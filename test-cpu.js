// Prints overall and per-core CPU load once a second for five seconds,
// using the same sampler as the server.
const { createCpuLoadSampler } = require('./lib/cpu-load');

const sampler = createCpuLoadSampler();
let count = 0;
const interval = setInterval(() => {
  const load = sampler.sample();
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
