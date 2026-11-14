/**
 * Persistent app settings, stored as JSON next to the server (config.json).
 * Unknown keys and wrong types are ignored so a damaged file falls back to
 * the defaults instead of stopping the server.
 */

const fs = require('fs');

const DEFAULTS = Object.freeze({ lanAccess: false, port: 3000 });

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function normalise(raw) {
  const settings = { ...DEFAULTS };
  if (raw && typeof raw === 'object' && typeof raw.lanAccess === 'boolean') {
    settings.lanAccess = raw.lanAccess;
  }
  if (raw && typeof raw === 'object' && isValidPort(raw.port)) {
    settings.port = raw.port;
  }
  return settings;
}

function createSettingsStore(filePath) {
  let current = { ...DEFAULTS };

  return {
    load() {
      try {
        current = normalise(JSON.parse(fs.readFileSync(filePath, 'utf8')));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`[settings] Could not read ${filePath}, using defaults: ${err.message}`);
        }
        current = { ...DEFAULTS };
      }
      return { ...current };
    },
    get() {
      return { ...current };
    },
    /** Merge a change, write it to disk, and return the new settings. */
    update(change) {
      const next = normalise({ ...current, ...change });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      fs.renameSync(tmp, filePath);
      current = next;
      return { ...current };
    },
  };
}

/**
 * Pick the address to listen on. A HOST environment variable always wins
 * and locks the setting; otherwise the saved LAN access choice decides.
 */
function resolveHost(envHost, settings) {
  if (envHost) return { host: envHost, locked: true };
  return { host: settings.lanAccess ? '0.0.0.0' : '127.0.0.1', locked: false };
}

/**
 * Pick the port to listen on. A valid PORT environment variable wins and
 * locks the setting; otherwise the saved port is used.
 */
function resolvePort(envPort, settings) {
  const fromEnv = Number(envPort);
  if (envPort && Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) {
    return { port: fromEnv, locked: true };
  }
  return { port: settings.port, locked: false };
}

/** True when an address is only reachable from this machine. */
function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** True for a socket address that belongs to this machine. */
function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** True when a Host header names this machine, which blocks DNS rebinding. */
function isLocalHostHeader(hostHeader) {
  if (!hostHeader) return false;
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

module.exports = {
  DEFAULTS,
  createSettingsStore,
  isValidPort,
  resolveHost,
  resolvePort,
  isLoopbackHost,
  isLoopbackAddress,
  isLocalHostHeader,
};
