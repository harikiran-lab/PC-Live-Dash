/**
 * CPU load sampling based on os.cpus() tick deltas.
 *
 * Each call to sample() returns the load since the previous call, so the
 * first call after a long pause reports the average over that pause.
 */

const os = require('os');

function readCpuTimes() {
  return os.cpus().map((cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return { idle: cpu.times.idle, total };
  });
}

/**
 * Work out per-core and overall load between two readCpuTimes() snapshots.
 */
function computeLoad(previous, current) {
  const cpus = [];
  let totalIdle = 0;
  let totalTime = 0;

  for (let i = 0; i < current.length; i++) {
    const last = previous[i];
    const cur = current[i];
    if (!last) continue;

    const idleDiff = cur.idle - last.idle;
    const totalDiff = cur.total - last.total;

    cpus.push({ load: totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0 });
    totalIdle += idleDiff;
    totalTime += totalDiff;
  }

  return {
    currentLoad: totalTime > 0 ? (1 - totalIdle / totalTime) * 100 : 0,
    cpus,
  };
}

function createCpuLoadSampler(read = readCpuTimes) {
  let last = read();
  return {
    sample() {
      const current = read();
      const load = computeLoad(last, current);
      last = current;
      return load;
    },
  };
}

module.exports = { readCpuTimes, computeLoad, createCpuLoadSampler };
