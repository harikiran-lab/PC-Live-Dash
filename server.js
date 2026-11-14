/**
 * PC Live Dashboard - Server
 *
 * Node.js backend that collects real-time system metrics using the
 * `systeminformation` library and broadcasts them to connected clients
 * over WebSocket. Metrics are collected at three tiers:
 *   - Fast   (2s):  CPU load, RAM, network stats
 *   - Medium (5s):  Processes, disk usage, disk I/O, GPU, CPU temp & speed
 *   - Slow   (15s): Battery, uptime, services
 *
 * Collection only runs while at least one client is connected. Static
 * system info (CPU model, OS, etc.) is sent once when a client connects.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const si = require('systeminformation');
const path = require('path');
const { execFile } = require('child_process');
const { createCpuLoadSampler } = require('./lib/cpu-load');
const { parseNvidiaSmi, parseWindowsDiskIo, isAllowedOrigin } = require('./lib/parsers');
const { version } = require('./package.json');

// ─── Configuration ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
// Listen on this machine only by default. Set HOST=0.0.0.0 to allow other
// devices on the network to connect (there is no authentication).
const HOST = process.env.HOST || '127.0.0.1';
const FAST_INTERVAL_MS = 2000;
const MEDIUM_INTERVAL_MS = 5000;
const SLOW_INTERVAL_MS = 15000;
// Upper bound for nvidia-smi and PowerShell calls so a hung child process
// cannot stall a collection tier.
const EXEC_TIMEOUT_MS = 8000;

// ─── Express & HTTP Setup ───────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
// Chart.js is served from the installed package so the dashboard works offline.
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

const server = http.createServer(app);

// ─── WebSocket Setup ────────────────────────────────────────────────────────────

const wss = new WebSocket.Server({
  server,
  // Reject connections opened by pages on other sites.
  verifyClient: ({ origin, req }) => isAllowedOrigin(origin, req.headers.host),
});

// ─── State ──────────────────────────────────────────────────────────────────────

let staticData = null;
let latestCpuLoad = 0;
let shuttingDown = false;
const cpuLoadSampler = createCpuLoadSampler();

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Broadcast a JSON message to every connected client whose socket is open.
 */
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        console.error('[ws] Error sending to client:', err.message);
      }
    }
  });
}

/**
 * Safely call a systeminformation function, returning null on failure
 * so that one broken metric never crashes the collection cycle.
 */
async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[si] Metric collection failed: ${err.message}`);
    return null;
  }
}

/**
 * Run an external command and resolve with its stdout, or null if it
 * fails, is missing, or exceeds EXEC_TIMEOUT_MS.
 */
function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

// ─── Data Collection ────────────────────────────────────────────────────────────

/**
 * Gather static (one-time) system information.
 */
async function collectStaticData() {
  const [cpu, osInfo, system, memLayout, diskLayout, networkInterfaces] =
    await Promise.all([
      safeCall(() => si.cpu()),
      safeCall(() => si.osInfo()),
      safeCall(() => si.system()),
      safeCall(() => si.memLayout()),
      safeCall(() => si.diskLayout()),
      safeCall(() => si.networkInterfaces()),
    ]);

  return { cpu, osInfo, system, memLayout, diskLayout, networkInterfaces };
}

/**
 * Query nvidia-smi for detailed per-GPU metrics.
 * Returns null if nvidia-smi is not available or fails.
 */
async function getNvidiaGpuStats() {
  const stdout = await run('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu,fan.speed,power.draw',
    '--format=csv,noheader,nounits',
  ]);
  if (stdout === null) return null;
  try {
    return parseNvidiaSmi(stdout);
  } catch (err) {
    console.error('[gpu] nvidia-smi parse error:', err.message);
    return null;
  }
}

/**
 * Query Windows performance counters for per-volume disk throughput.
 * Used on Windows, where si.disksIO() typically returns null.
 */
async function getWindowsDiskIoStats() {
  const stdout = await run('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -ErrorAction SilentlyContinue | ' +
      'Select-Object Name, DiskReadBytesPerSec, DiskWriteBytesPerSec, DiskTransfersPerSec | ConvertTo-Json',
  ]);
  if (!stdout) return null;
  try {
    return parseWindowsDiskIo(stdout);
  } catch (err) {
    console.error('[disk] JSON parse error:', err.message);
    return null;
  }
}

/**
 * Run gpu.ps1 to fetch GPU utilization and VRAM from Windows performance
 * counters. This supports AMD and Intel graphics on Windows.
 */
async function getWindowsGpuStats() {
  const stdout = await run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(__dirname, 'gpu.ps1'),
  ]);
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch (err) {
    console.error('[gpu] JSON parse error:', err.message);
    return null;
  }
}

/**
 * Fast-tier metrics – collected every 2 seconds.
 */
async function collectFastData() {
  const currentLoad = cpuLoadSampler.sample();
  latestCpuLoad = currentLoad.currentLoad;
  const [mem, networkStats] = await Promise.all([
    safeCall(() => si.mem()),
    safeCall(() => si.networkStats()),
  ]);

  return { currentLoad, mem, networkStats };
}

/**
 * Medium-tier metrics – collected every 5 seconds.
 */
async function collectMediumData() {
  const isWindows = process.platform === 'win32';
  const [processes, fsSize, graphics, cpuTemperature, cpuCurrentSpeed, siDisksIO, fsStats] = await Promise.all([
    safeCall(() => si.processes()),
    safeCall(() => si.fsSize()),
    safeCall(() => si.graphics()),
    safeCall(() => si.cpuTemperature()),
    safeCall(() => si.cpuCurrentSpeed()),
    isWindows ? null : safeCall(() => si.disksIO()),
    isWindows ? null : safeCall(() => si.fsStats()),
  ]);
  // Filter out remote display adapters / basic render drivers
  if (graphics && graphics.controllers) {
    graphics.controllers = graphics.controllers.filter(gpu => 
      gpu.model && 
      !gpu.model.toLowerCase().includes('remote display') && 
      !gpu.model.toLowerCase().includes('basic render')
    );
  }

  // Augment GPU stats on Windows
  if (isWindows && graphics && graphics.controllers) {
    try {
      const nvGpuStats = await getNvidiaGpuStats();
      if (nvGpuStats && nvGpuStats.length > 0) {
        graphics.controllers.forEach((gpu) => {
          // Find matching nvidia-smi stats by checking model/name overlap
          const match = nvGpuStats.find(stat => 
            gpu.model && (
              stat.name.toLowerCase().includes(gpu.model.toLowerCase()) ||
              gpu.model.toLowerCase().includes(stat.name.toLowerCase())
            )
          );
          if (match) {
            gpu.utilizationGpu = match.utilizationGpu !== null ? match.utilizationGpu : gpu.utilizationGpu;
            gpu.memoryUsed = match.memoryUsed !== null ? match.memoryUsed : gpu.memoryUsed;
            gpu.memoryTotal = match.memoryTotal !== null ? match.memoryTotal : gpu.memoryTotal;
            gpu.temperatureGpu = match.temperatureGpu !== null ? match.temperatureGpu : gpu.temperatureGpu;
            gpu.fanSpeed = match.fanSpeed !== null ? match.fanSpeed : gpu.fanSpeed;
            
            if (match.powerDraw !== null && match.powerDraw !== undefined) {
              gpu.powerDraw = match.powerDraw;
            } else {
              // nvidia-smi gave no reading: estimate from utilization and flag it.
              gpu.powerDrawEstimated = true;
              const util = gpu.utilizationGpu || 0;
              const is4060 = gpu.model && gpu.model.includes('4060');
              const baseTdp = is4060 ? 115 : 150;
              gpu.powerDraw = Math.round(7 + (util / 100) * (baseTdp - 7));
            }
          }
        });
      } else {
        // Fallback to WMI/CIM sum stats
        const winGpu = await getWindowsGpuStats();
        if (winGpu) {
          graphics.controllers.forEach((gpu) => {
            if (gpu.utilizationGpu === null || gpu.utilizationGpu === undefined) {
              gpu.utilizationGpu = winGpu.utilizationGpu;
            }
            if (gpu.memoryUsed === null || gpu.memoryUsed === undefined) {
              const usedBytes = winGpu.dedicatedUsage > 0 ? winGpu.dedicatedUsage : winGpu.sharedUsage;
              gpu.memoryUsed = Math.round(usedBytes / 1024 / 1024);
            }
            if (gpu.memoryTotal === null || gpu.memoryTotal === undefined) {
              gpu.memoryTotal = gpu.vram || 2048;
            }
          });
        }
      }
    } catch (gpuErr) {
      console.error('[gpu] Augmentation error:', gpuErr.message);
    }
  }

  // Windows often exposes no CPU temperature sensor. Fall back to a rough
  // estimate from CPU load, flagged so the UI can label it as an estimate.
  let finalCpuTemperature = cpuTemperature;
  if (!finalCpuTemperature || finalCpuTemperature.main === null || finalCpuTemperature.main === -1) {
    const mainTemp = Math.round(38 + (latestCpuLoad || 5) * 0.4);
    finalCpuTemperature = { main: mainTemp, cores: [], max: null, estimated: true };
  }

  // Disk throughput, normalised to bytes per second plus total IOPS.
  let disksIO = null;
  if (isWindows) {
    const winDiskIo = await getWindowsDiskIoStats();
    if (winDiskIo) {
      (fsSize || []).forEach((disk) => {
        const volume = disk.mount ? winDiskIo.volumes[disk.mount.toUpperCase()] : null;
        disk.readSpeed = volume ? volume.read : 0;
        disk.writeSpeed = volume ? volume.write : 0;
      });
      if (winDiskIo.total) {
        disksIO = {
          readBytesSec: winDiskIo.total.read,
          writeBytesSec: winDiskIo.total.write,
          iops: winDiskIo.total.iops,
        };
      }
    }
  } else if (fsStats || siDisksIO) {
    disksIO = {
      readBytesSec: fsStats ? fsStats.rx_sec : null,
      writeBytesSec: fsStats ? fsStats.wx_sec : null,
      iops: siDisksIO ? siDisksIO.tIO_sec : null,
    };
  }

  return { processes, fsSize, disksIO, graphics, cpuTemperature: finalCpuTemperature, cpuCurrentSpeed };
}

/**
 * Slow-tier metrics – collected every 15 seconds.
 */
async function collectSlowData() {
  const [battery, services] = await Promise.all([
    safeCall(() => si.battery()),
    safeCall(() => si.services('*')),
  ]);

  // si.time() is synchronous – wrap in try/catch for safety
  let time = null;
  try {
    time = si.time();
  } catch (err) {
    console.error('[si] time() failed:', err.message);
  }

  return { battery, time, services };
}

// ─── Collection Tiers ───────────────────────────────────────────────────────────

/**
 * Create a collection tier. Each run is scheduled only after the previous
 * one finishes, so slow collections never overlap, and the tier pauses
 * itself while no clients are connected.
 */
function createTier(type, intervalMs, collect) {
  let timer = null;
  let running = false;
  let latest = null;

  async function runOnce() {
    timer = null;
    if (shuttingDown || wss.clients.size === 0) return;
    running = true;
    try {
      const data = await collect();
      latest = { type, data, timestamp: Date.now() };
      broadcast(latest);
    } catch (err) {
      console.error(`[${type}] Collection cycle error:`, err.message);
    } finally {
      running = false;
    }
    if (!shuttingDown && wss.clients.size > 0) {
      timer = setTimeout(runOnce, intervalMs);
    }
  }

  return {
    /** Start collecting now unless a run is already in progress or scheduled. */
    kick() {
      if (!running && !timer) runOnce();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** Most recent message, if it is still fresh enough to show a new client. */
    latest() {
      return latest && Date.now() - latest.timestamp < intervalMs * 2 ? latest : null;
    },
  };
}

const tiers = [
  createTier('fast', FAST_INTERVAL_MS, collectFastData),
  createTier('medium', MEDIUM_INTERVAL_MS, collectMediumData),
  createTier('slow', SLOW_INTERVAL_MS, collectSlowData),
];

// ─── WebSocket Connection Handling ──────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  console.log(`[ws] Client connected from ${ip}`);

  // Send static system info to the newly connected client
  if (staticData) {
    try {
      ws.send(JSON.stringify({ type: 'static', data: staticData }));
    } catch (err) {
      console.error('[ws] Error sending static data:', err.message);
    }
  }

  // Show the newest readings straight away, then make sure collection is running.
  tiers.forEach((tier) => {
    const latest = tier.latest();
    if (latest) {
      try {
        ws.send(JSON.stringify(latest));
      } catch (err) {
        console.error('[ws] Error sending cached data:', err.message);
      }
    }
    tier.kick();
  });

  ws.on('close', (code) => {
    console.log(`[ws] Client disconnected (code=${code})`);
  });

  ws.on('error', (err) => {
    console.error('[ws] Client socket error:', err.message);
  });
});

wss.on('error', (err) => {
  console.error('[wss] WebSocket server error:', err.message);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[server] ${signal} received – shutting down gracefully...`);

  // Stop all collection tiers
  shuttingDown = true;
  tiers.forEach((tier) => tier.stop());

  // Close every open WebSocket connection
  wss.clients.forEach((client) => {
    try {
      client.close(1001, 'Server shutting down');
    } catch (_) {
      /* ignore */
    }
  });

  // Close the WebSocket server
  wss.close(() => {
    console.log('[server] WebSocket server closed.');

    // Close the HTTP server
    server.close(() => {
      console.log('[server] HTTP server closed. Goodbye!');
      process.exit(0);
    });
  });

  // Force-exit after 5 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('[server] Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Startup ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log('[server] Collecting static system information...');

    // Gather one-time system data
    staticData = await collectStaticData();

    // Prime the pump – first calls to these return null/zero delta values,
    // so we call them once now and discard the result.
    console.log('[server] Priming network & disk I/O stats...');
    await safeCall(() => si.networkStats());
    if (process.platform !== 'win32') {
      await safeCall(() => si.disksIO());
      await safeCall(() => si.fsStats());
    }

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[server] Port ${PORT} is already in use. Set PORT to a different value.`);
      } else {
        console.error('[server] HTTP server error:', err.message);
      }
      process.exit(1);
    });

    // Start the HTTP server. Collection starts when the first client connects.
    server.listen(PORT, HOST, () => {
      const shownHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
      console.log('');
      console.log(`  PC Live Dashboard v${version}`);
      console.log(`  http://${shownHost}:${PORT}`);
      console.log('');
      if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
        console.log('[server] Listening on the network with no authentication. Use a trusted network only.');
      }
      console.log('[server] Collection runs while a browser is connected:');
      console.log(`  ├─ Fast   : every ${FAST_INTERVAL_MS / 1000}s  (CPU, RAM, Network)`);
      console.log(`  ├─ Medium : every ${MEDIUM_INTERVAL_MS / 1000}s  (Processes, Disks, GPU, CPU Temps & Speed)`);
      console.log(`  └─ Slow   : every ${SLOW_INTERVAL_MS / 1000}s (Battery, Uptime, Services)`);
      console.log('');
    });
  } catch (err) {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  }
}

main();
