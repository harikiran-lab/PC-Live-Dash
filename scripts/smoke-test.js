/**
 * Smoke test for a running PC Live Dash server (source or packaged .exe).
 *
 *   node scripts/smoke-test.js [port]
 *
 * Checks that the dashboard and its assets are served, that the settings API
 * reports the expected version, and that all three metric tiers arrive over
 * WebSocket. Exits non-zero on failure.
 */

const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { version } = require('../package.json');

const port = Number(process.argv[2]) || 3000;
const base = `http://127.0.0.1:${port}`;
const STARTUP_TIMEOUT_MS = 90_000;
const METRICS_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${base}/`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`Server did not answer on ${base} in time`);
    await sleep(1000);
  }
}

function collectTiers() {
  return new Promise((resolve, reject) => {
    const seen = {};
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out waiting for metrics. Received: ${Object.keys(seen).join(', ') || 'nothing'}`));
    }, METRICS_TIMEOUT_MS);

    ws.on('error', reject);
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      seen[message.type] = message.data;
      if (seen.static && seen.fast && seen.medium && seen.slow) {
        clearTimeout(timer);
        ws.close();
        resolve(seen);
      }
    });
  });
}

async function main() {
  await waitForServer();
  console.log('ok  dashboard page is served');

  for (const asset of ['app.js', 'styles.css', 'vendor/chart.js/chart.umd.min.js']) {
    const res = await fetch(`${base}/${asset}`);
    assert.equal(res.status, 200, `${asset} should be served`);
  }
  console.log('ok  static assets and Chart.js are served');

  const settingsRes = await fetch(`${base}/api/settings`, { headers: { 'X-PC-Live-Dash': 'smoke-test' } });
  assert.equal(settingsRes.status, 200);
  const settings = await settingsRes.json();
  assert.equal(settings.version, version, 'server version should match package.json');
  console.log(`ok  settings API reports v${settings.version}, port ${settings.port}, LAN access ${settings.lanAccess}`);

  const blocked = await fetch(`${base}/api/settings`);
  assert.equal(blocked.status, 403, 'settings API should refuse requests without the tool header');
  console.log('ok  settings API refuses requests without the tool header');

  const tiers = await collectTiers();
  const { fast, medium, slow } = tiers;

  assert.ok(fast.currentLoad.cpus.length > 0, 'CPU cores should be reported');
  assert.ok(fast.mem && fast.mem.total > 0, 'memory should be reported');
  console.log(`ok  fast tier: ${fast.currentLoad.cpus.length} cores, ${Math.round(fast.mem.total / 2 ** 30)} GB RAM`);

  assert.ok(medium.processes.list.length > 0, 'processes should be reported');
  assert.ok(Array.isArray(medium.fsSize) && medium.fsSize.length > 0, 'disks should be reported');
  console.log(`ok  medium tier: ${medium.processes.list.length} processes, ${medium.fsSize.length} volumes`);
  console.log('    disk totals:', JSON.stringify(medium.disksIO));
  console.log(
    '    volumes:',
    JSON.stringify(medium.fsSize.map((d) => ({ mount: d.mount, read: d.readSpeed, write: d.writeSpeed })))
  );
  console.log(
    '    gpus:',
    JSON.stringify(
      ((medium.graphics && medium.graphics.controllers) || []).map((g) => ({
        model: g.model,
        util: g.utilizationGpu,
        vramUsed: g.memoryUsed,
      }))
    )
  );
  console.log('    cpu temperature:', JSON.stringify(medium.cpuTemperature));
  if (process.platform === 'win32') {
    assert.ok(medium.disksIO, 'Windows disk counters should be reported');
    assert.ok(Number.isFinite(medium.disksIO.readBytesSec), 'disk read rate should be a number');
    assert.ok(
      medium.fsSize.some((d) => Number.isFinite(d.readSpeed)),
      'per-volume disk speeds should be reported'
    );
  }

  assert.ok(slow.time && slow.time.uptime > 0, 'uptime should be reported');
  console.log(`ok  slow tier: ${Array.isArray(slow.services) ? slow.services.length : 0} services`);

  console.log('\nSmoke test passed.');
}

main().catch((err) => {
  console.error(`\nSmoke test FAILED: ${err.message}`);
  process.exit(1);
});
