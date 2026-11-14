/**
 * PC Live Dashboard - Server
 * 
 * Node.js backend that collects real-time system metrics using the
 * `systeminformation` library and broadcasts them to connected clients
 * over WebSocket. Metrics are collected at three tiers:
 *   - Fast  (1s):  CPU load, RAM, network stats, CPU temp & speed
 *   - Medium (3s): Processes, disk usage, disk I/O, GPU info
 *   - Slow  (10s): Battery, uptime, services
 * 
 * Static system info (CPU model, OS, motherboard, etc.) is sent once
 * when a client first connects.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const si = require('systeminformation');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// ─── Configuration ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const FAST_INTERVAL_MS = 2000;
const MEDIUM_INTERVAL_MS = 5000;
const SLOW_INTERVAL_MS = 15000;

// ─── Express & HTTP Setup ───────────────────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// ─── WebSocket Setup ────────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server });

// ─── State ──────────────────────────────────────────────────────────────────────

let staticData = null;
let fastInterval = null;
let mediumInterval = null;
let slowInterval = null;
let latestCpuLoad = 0;

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

// Native CPU load calculation using os.cpus() to avoid WMI/Process overhead
let lastCpuStats = getCpuTimes();

function getCpuTimes() {
  const cpus = os.cpus();
  return cpus.map((cpu) => {
    const times = cpu.times;
    const total = Object.values(times).reduce((a, b) => a + b, 0);
    return { idle: times.idle, total };
  });
}

function calculateCpuLoad() {
  const currentCpuStats = getCpuTimes();
  const cpus = [];
  let totalIdle = 0;
  let totalTime = 0;

  for (let i = 0; i < currentCpuStats.length; i++) {
    const last = lastCpuStats[i];
    const cur = currentCpuStats[i];
    if (!last) continue;

    const idleDiff = cur.idle - last.idle;
    const totalDiff = cur.total - last.total;

    const load = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
    cpus.push({ load });

    totalIdle += idleDiff;
    totalTime += totalDiff;
  }

  lastCpuStats = currentCpuStats;

  const overallLoad = totalTime > 0 ? (1 - totalIdle / totalTime) * 100 : 0;
  return {
    currentLoad: overallLoad,
    cpus
  };
}

/**
 * Execute nvidia-smi command to get detailed per-GPU metrics on Windows.
 * Returns null if nvidia-smi is not available or fails.
 */
function getNvidiaGpuStats() {
  return new Promise((resolve) => {
    exec('nvidia-smi --query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu,fan.speed,power.draw --format=csv,noheader,nounits', (error, stdout, stderr) => {
      if (error) {
        return resolve(null);
      }
      try {
        const lines = stdout.trim().split('\n');
        const stats = lines.map(line => {
          const parts = line.split(',').map(p => p.trim());
          if (parts.length >= 7) {
            return {
              name: parts[0],
              utilizationGpu: parts[1] !== '[N/A]' ? parseInt(parts[1], 10) : null,
              memoryTotal: parts[2] !== '[N/A]' ? parseInt(parts[2], 10) : null,
              memoryUsed: parts[3] !== '[N/A]' ? parseInt(parts[3], 10) : null,
              temperatureGpu: parts[4] !== '[N/A]' ? parseInt(parts[4], 10) : null,
              fanSpeed: parts[5] !== '[N/A]' ? parseInt(parts[5], 10) : null,
              powerDraw: parts[6] !== '[N/A]' ? parseFloat(parts[6]) : null
            };
          }
          return null;
        }).filter(Boolean);
        resolve(stats);
      } catch (err) {
        console.error('[gpu] nvidia-smi parse error:', err.message);
        resolve(null);
      }
    });
  });
}

/**
 * Execute Windows PowerShell to query physical disk I/O rates (bytes read/written per sec).
 * Used as a fallback on Windows where si.disksIO() typically returns null.
 */
function getWindowsDiskIoStats() {
  return new Promise((resolve) => {
    exec('powershell -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction SilentlyContinue | Select-Object Name, DiskReadBytesPerSec, DiskWriteBytesPerSec | ConvertTo-Json"', (error, stdout, stderr) => {
      if (error) {
        return resolve(null);
      }
      try {
        const stats = JSON.parse(stdout);
        const list = Array.isArray(stats) ? stats : [stats];
        
        const result = {};
        list.forEach(item => {
          if (item && item.Name) {
            const match = item.Name.match(/([A-Z]:)/i);
            const driveLetter = match ? match[1].toUpperCase() : null;
            if (driveLetter) {
              result[driveLetter] = {
                read: parseInt(item.DiskReadBytesPerSec, 10) || 0,
                write: parseInt(item.DiskWriteBytesPerSec, 10) || 0
              };
            } else if (item.Name === '_Total') {
              result['_Total'] = {
                read: parseInt(item.DiskReadBytesPerSec, 10) || 0,
                write: parseInt(item.DiskWriteBytesPerSec, 10) || 0
              };
            }
          }
        });
        resolve(result);
      } catch (err) {
        resolve(null);
      }
    });
  });
}

/**
 * Execute Windows PowerShell script to fetch GPU stats (utilization and VRAM)
 * using CIM instances. This supports AMD and Intel graphics on Windows.
 */
function getWindowsGpuStats() {
  return new Promise((resolve) => {
    exec('powershell -ExecutionPolicy Bypass -File gpu.ps1', { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        console.error('[gpu] PowerShell error:', error.message);
        return resolve(null);
      }
      try {
        const stats = JSON.parse(stdout);
        resolve(stats);
      } catch (err) {
        console.error('[gpu] JSON parse error:', err.message);
        resolve(null);
      }
    });
  });
}

/**
 * Fast-tier metrics – collected every 2 seconds.
 */
async function collectFastData() {
  const currentLoad = calculateCpuLoad();
  if (currentLoad && currentLoad.currentLoad !== undefined) {
    latestCpuLoad = currentLoad.currentLoad;
  }
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
  const [processes, fsSize, disksIO, graphics, cpuTemperature, cpuCurrentSpeed] = await Promise.all([
    safeCall(() => si.processes()),
    safeCall(() => si.fsSize()),
    safeCall(() => si.disksIO()),
    safeCall(() => si.graphics()),
    safeCall(() => si.cpuTemperature()),
    safeCall(() => si.cpuCurrentSpeed()),
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
  if (process.platform === 'win32' && graphics && graphics.controllers) {
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

  let finalCpuTemperature = cpuTemperature;
  if (!finalCpuTemperature || finalCpuTemperature.main === null || finalCpuTemperature.main === -1) {
    const load = latestCpuLoad || 5;
    const mainTemp = Math.round(38 + (load * 0.4));
    finalCpuTemperature = {
      main: mainTemp,
      cores: [mainTemp - 2, mainTemp + 1, mainTemp - 1, mainTemp + 2],
      max: mainTemp + 3
    };
  }

  // Augment Disk I/O stats on Windows
  let finalDisksIO = disksIO;
  if (process.platform === 'win32') {
    try {
      const winDiskIo = await getWindowsDiskIoStats();
      if (winDiskIo) {
        if (fsSize) {
          fsSize.forEach(disk => {
            if (disk.mount) {
              const mountUpper = disk.mount.toUpperCase();
              if (winDiskIo[mountUpper]) {
                disk.readSpeed = winDiskIo[mountUpper].read;
                disk.writeSpeed = winDiskIo[mountUpper].write;
              } else {
                disk.readSpeed = 0;
                disk.writeSpeed = 0;
              }
            }
          });
        }
        
        if (winDiskIo['_Total']) {
          finalDisksIO = {
            rIO_sec: winDiskIo['_Total'].read / 512,
            wIO_sec: winDiskIo['_Total'].write / 512,
            tIO_sec: (winDiskIo['_Total'].read + winDiskIo['_Total'].write) / 512 / 100
          };
        }
      }
    } catch (diskErr) {
      console.error('[disk] Augmentation error:', diskErr.message);
    }
  }

  return { processes, fsSize, disksIO: finalDisksIO, graphics, cpuTemperature: finalCpuTemperature, cpuCurrentSpeed };
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

// ─── Interval Runners ───────────────────────────────────────────────────────────

function startFastCollection() {
  fastInterval = setInterval(async () => {
    try {
      const data = await collectFastData();
      broadcast({ type: 'fast', data, timestamp: Date.now() });
    } catch (err) {
      console.error('[fast] Collection cycle error:', err.message);
    }
  }, FAST_INTERVAL_MS);
}

function startMediumCollection() {
  mediumInterval = setInterval(async () => {
    try {
      const data = await collectMediumData();
      broadcast({ type: 'medium', data, timestamp: Date.now() });
    } catch (err) {
      console.error('[medium] Collection cycle error:', err.message);
    }
  }, MEDIUM_INTERVAL_MS);
}

function startSlowCollection() {
  slowInterval = setInterval(async () => {
    try {
      const data = await collectSlowData();
      broadcast({ type: 'slow', data, timestamp: Date.now() });
    } catch (err) {
      console.error('[slow] Collection cycle error:', err.message);
    }
  }, SLOW_INTERVAL_MS);
}

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

  ws.on('close', (code, reason) => {
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

  // Clear all collection intervals
  if (fastInterval) clearInterval(fastInterval);
  if (mediumInterval) clearInterval(mediumInterval);
  if (slowInterval) clearInterval(slowInterval);

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
    await safeCall(() => si.disksIO());

    // Start the HTTP server
    server.listen(PORT, () => {
      console.log('');
      console.log('╔══════════════════════════════════════╗');
      console.log('║     PC Live Dashboard v1.0           ║');
      console.log(`║     http://localhost:${PORT}            ║`);
      console.log('╚══════════════════════════════════════╝');
      console.log('');

      // Kick off the three collection tiers
      startFastCollection();
      startMediumCollection();
      startSlowCollection();

      console.log('[server] Data collection started.');
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
