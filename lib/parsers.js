/**
 * Pure parsers for the output of the external tools the server shells out to.
 */

function parseNumber(value, parse) {
  if (value === undefined || value === '' || /N\/A|Not Supported/i.test(value)) return null;
  const n = parse(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `nvidia-smi --query-gpu=name,utilization.gpu,memory.total,memory.used,
 * temperature.gpu,fan.speed,power.draw --format=csv,noheader,nounits`.
 */
function parseNvidiaSmi(stdout) {
  const int = (v) => parseNumber(v, (s) => parseInt(s, 10));
  return String(stdout)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((p) => p.trim()))
    .filter((parts) => parts.length >= 7 && parts[0])
    .map((parts) => ({
      name: parts[0],
      utilizationGpu: int(parts[1]),
      memoryTotal: int(parts[2]),
      memoryUsed: int(parts[3]),
      temperatureGpu: int(parts[4]),
      fanSpeed: int(parts[5]),
      powerDraw: parseNumber(parts[6], parseFloat),
    }));
}

/**
 * Parse the JSON produced by querying Win32_PerfFormattedData_PerfDisk_LogicalDisk.
 * Returns { volumes: { 'C:': { read, write } }, total: { read, write, iops } | null },
 * with read and write in bytes per second.
 */
function parseWindowsDiskIo(stdout) {
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const num = (v) => Number(v) || 0;
  const result = { volumes: {}, total: null };

  for (const item of list) {
    if (!item || typeof item.Name !== 'string') continue;
    const entry = {
      read: num(item.DiskReadBytesPerSec),
      write: num(item.DiskWriteBytesPerSec),
      iops: num(item.DiskTransfersPerSec),
    };
    const name = item.Name.trim();
    if (name === '_Total') {
      result.total = entry;
    } else if (/^[A-Z]:$/i.test(name)) {
      result.volumes[name.toUpperCase()] = entry;
    }
  }
  return result;
}

/**
 * Decide whether a WebSocket upgrade may proceed. Browsers always send an
 * Origin header, so a page on another site cannot read the metrics; tools
 * that send no Origin (curl, scripts) are allowed.
 */
function isAllowedOrigin(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

module.exports = { parseNvidiaSmi, parseWindowsDiskIo, isAllowedOrigin };
