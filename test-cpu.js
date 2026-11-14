const os = require('os');

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

// Print CPU load every second for 5 seconds
let count = 0;
const interval = setInterval(() => {
  const load = calculateCpuLoad();
  console.log(`Overall CPU Load: ${load.currentLoad.toFixed(2)}%`);
  load.cpus.forEach((c, i) => {
    console.log(`  Core ${i}: ${c.load.toFixed(2)}%`);
  });
  console.log('');
  count++;
  if (count >= 5) {
    clearInterval(interval);
  }
}, 1000);
