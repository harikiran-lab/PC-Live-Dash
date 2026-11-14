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
const os = require('os');
const { execFile } = require('child_process');
const { createCpuLoadSampler } = require('./lib/cpu-load');
const { parseNvidiaSmi, parseWindowsDiskIo, isAllowedOrigin } = require('./lib/parsers');
const {
  createSettingsStore,
  isValidPort,
  resolveHost,
  resolvePort,
  isLoopbackHost,
  isLoopbackAddress,
  isLocalHostHeader,
} = require('./lib/settings');
const { version } = require('./package.json');

// ─── Configuration ──────────────────────────────────────────────────────────────

// Settings are saved in config.json and changed from the tray app. By default
// the server listens on port 3000 on this machine only. The PORT and HOST
// environment variables override the saved values. There is no authentication.
const settingsStore = createSettingsStore(path.join(__dirname, 'config.json'));
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
app.use(
  '/vendor/chart.js',
  express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), { maxAge: '7d' })
);

// ─── Listening address ──────────────────────────────────────────────────────────

const server = http.createServer(app);

// Where the server is listening right now.
let listening = { host: '127.0.0.1', port: 3000 };
// Set while switching address: called if the new address cannot be used.
let listenFallback = null;

/** The address the saved settings and environment ask for. */
function wantedAddress() {
  const settings = settingsStore.get();
  return {
    host: resolveHost(process.env.HOST, settings).host,
    port: resolvePort(process.env.PORT, settings).port,
  };
}

/** Addresses other devices on the network can use to reach the dashboard. */
function getLanUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => `http://${iface.address}:${listening.port}`);
}

function announce() {
  console.log('');
  console.log(`  PC Live Dashboard v${version}`);
  console.log(`  http://localhost:${listening.port}`);
  if (!isLoopbackHost(listening.host)) {
    getLanUrls().forEach((url) => console.log(`  ${url}  (LAN)`));
    console.log('');
    console.log('[server] LAN access is on with no authentication. Use a trusted network only.');
  }
  console.log('');
}

function listen(address, onListening) {
  server.listen(address.port, address.host, () => {
    listening = address;
    listenFallback = null;
    announce();
    if (onListening) onListening();
  });
}

server.on('error', (err) => {
  const reason = err.code === 'EADDRINUSE' ? 'the port is already in use' : err.message;
  if (listenFallback) {
    const fallback = listenFallback;
    listenFallback = null;
    console.error(`[server] Could not switch address (${reason}). Going back to the previous one.`);
    fallback();
    return;
  }
  console.error(`[server] Could not start the HTTP server: ${reason}.`);
  process.exit(1);
});

/**
 * Move the listener to a different address without restarting the process.
 * Open dashboards are disconnected and reconnect on their own. If the new
 * address cannot be used, the previous address and settings are restored.
 */
function rebind(target, previousSettings) {
  if (shuttingDown) return;
  const previous = listening;
  console.log(`[server] Switching to ${target.host}:${target.port}...`);
  wss.clients.forEach((client) => {
    try {
      client.close(1012, 'Server changing address');
    } catch (_) {
      /* ignore */
    }
  });
  server.close(() => {
    listenFallback = () => {
      try {
        settingsStore.update(previousSettings);
      } catch (err) {
        console.error('[settings] Could not restore settings:', err.message);
      }
      listen(previous);
    };
    listen(target);
  });
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}

// ─── Settings API ───────────────────────────────────────────────────────────────

function describeSettings() {
  const settings = settingsStore.get();
  const lanAccess = !isLoopbackHost(listening.host);
  return {
    lanAccess,
    port: listening.port,
    hostLocked: resolveHost(process.env.HOST, settings).locked,
    portLocked: resolvePort(process.env.PORT, settings).locked,
    lanUrls: lanAccess ? getLanUrls() : [],
  };
}

/**
 * Settings can only be read or changed from this machine, by a local tool
 * such as the tray app. The custom header cannot be sent by another website
 * without a CORS preflight, which this server never approves.
 */
function requireLocalTool(req, res, next) {
  const allowed =
    isLoopbackAddress(req.socket.remoteAddress) &&
    isLocalHostHeader(req.headers.host) &&
    !req.headers.origin &&
    Boolean(req.headers['x-pc-live-dash']);
  if (!allowed) return res.status(403).json({ error: 'Settings are only available from this computer.' });
  next();
}

app.get('/api/settings', requireLocalTool, (req, res) => {
  res.json(describeSettings());
});

app.put('/api/settings', requireLocalTool, express.json({ limit: '1kb' }), (req, res) => {
  const body = req.body || {};
  const change = {};

  if (body.lanAccess !== undefined) {
    if (typeof body.lanAccess !== 'boolean') {
      return res.status(400).json({ error: 'lanAccess must be true or false.' });
    }
    change.lanAccess = body.lanAccess;
  }
  if (body.port !== undefined) {
    if (!isValidPort(body.port)) {
      return res.status(400).json({ error: 'port must be a whole number from 1024 to 65535.' });
    }
    change.port = body.port;
  }
  if (Object.keys(change).length === 0) {
    return res.status(400).json({ error: 'Nothing to change.' });
  }

  const previousSettings = settingsStore.get();
  if (change.lanAccess !== undefined && change.lanAccess !== previousSettings.lanAccess && process.env.HOST) {
    return res.status(409).json({ error: 'LAN access is fixed by the HOST environment variable.' });
  }
  if (change.port !== undefined && change.port !== previousSettings.port && process.env.PORT) {
    return res.status(409).json({ error: 'The port is fixed by the PORT environment variable.' });
  }

  try {
    settingsStore.update(change);
  } catch (err) {
    console.error('[settings] Could not save settings:', err.message);
    return res.status(500).json({ error: 'Could not save settings.' });
  }

  const target = wantedAddress();
  const willSwitch = target.host !== listening.host || target.port !== listening.port;
  // Report what the settings will be once the switch has happened.
  const lanAccess = !isLoopbackHost(target.host);
  res.json({
    ...describeSettings(),
    lanAccess,
    port: target.port,
    lanUrls: lanAccess ? getLanUrls().map((url) => url.replace(/:\d+$/, `:${target.port}`)) : [],
  });
  if (willSwitch) {
    // Switch after the response has gone out, since rebinding drops connections.
    res.on('finish', () => setImmediate(() => rebind(target, previousSettings)));
  }
});

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
const missingCommands = new Set();
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

/** Copy the named keys of an object, to keep WebSocket messages small. */
function pick(source, keys) {
  const result = {};
  for (const key of keys) result[key] = source[key];
  return result;
}

/**
 * Run an external command and resolve with its stdout, or null if it
 * fails, is missing, or exceeds EXEC_TIMEOUT_MS.
 */
function run(command, args) {
  // A command that is not installed will not appear later, so stop trying it.
  if (missingCommands.has(command)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(command, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error && error.code === 'ENOENT') missingCommands.add(command);
      resolve(error ? null : stdout);
    });
  });
}

// ─── Data Collection ────────────────────────────────────────────────────────────

/**
 * Gather static (one-time) system information.
 */
async function collectStaticData() {
  // Only what the dashboard shows. Serial numbers and hardware IDs stay on the server.
  const [cpu, osInfo, networkInterfaces] = await Promise.all([
    safeCall(() => si.cpu()),
    safeCall(() => si.osInfo()),
    safeCall(() => si.networkInterfaces()),
  ]);

  return {
    cpu: cpu && pick(cpu, ['manufacturer', 'brand', 'physicalCores', 'cores']),
    osInfo: osInfo && pick(osInfo, ['hostname', 'distro', 'release', 'arch']),
    networkInterfaces:
      Array.isArray(networkInterfaces) &&
      networkInterfaces.map((iface) =>
        pick(iface, ['iface', 'ifaceName', 'internal', 'virtual', 'operstate', 'type', 'ip4', 'mac', 'speed'])
      ),
  };
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
  // The slower external queries start now and run alongside everything else.
  const nvidiaPromise = isWindows ? getNvidiaGpuStats() : null;
  const winDiskIoPromise = isWindows ? getWindowsDiskIoStats() : null;
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
      const nvGpuStats = await nvidiaPromise;
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
    const winDiskIo = await winDiskIoPromise;
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

  // Send only the process fields the dashboard uses. Full command lines and
  // paths for every process make up most of the message otherwise.
  const slimProcesses = processes && Array.isArray(processes.list)
    ? {
        all: processes.all,
        list: processes.list.map((proc) => ({
          pid: proc.pid,
          name: proc.name,
          command: typeof proc.command === 'string' ? proc.command.slice(0, 200) : proc.command,
          cpu: proc.cpu,
          mem: proc.mem,
          memRss: proc.memRss,
          state: proc.state,
          user: proc.user,
        })),
      }
    : processes;

  return { processes: slimProcesses, fsSize, disksIO, graphics, cpuTemperature: finalCpuTemperature, cpuCurrentSpeed };
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

  const slimServices = Array.isArray(services)
    ? services.map((svc) => pick(svc, ['name', 'running', 'startmode', 'pcpu', 'pmem']))
    : services;

  return { battery, time, services: slimServices };
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

    // Start the HTTP server. Collection starts when the first client connects.
    settingsStore.load();
    listen(wantedAddress(), () => {
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
