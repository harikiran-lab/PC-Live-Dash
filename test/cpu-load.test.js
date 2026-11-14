const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLoad, createCpuLoadSampler } = require('../lib/cpu-load');

test('computeLoad reports per-core and overall load', () => {
  const previous = [{ idle: 100, total: 200 }, { idle: 100, total: 200 }];
  const current = [{ idle: 150, total: 300 }, { idle: 100, total: 300 }];
  const load = computeLoad(previous, current);
  assert.equal(load.cpus[0].load, 50);
  assert.equal(load.cpus[1].load, 100);
  assert.equal(load.currentLoad, 75);
});

test('computeLoad returns zero when no time has passed', () => {
  const snapshot = [{ idle: 100, total: 200 }];
  assert.deepEqual(computeLoad(snapshot, snapshot), { currentLoad: 0, cpus: [{ load: 0 }] });
});

test('sampler measures the delta since the previous sample', () => {
  const readings = [
    [{ idle: 0, total: 0 }],
    [{ idle: 75, total: 100 }],
    [{ idle: 75, total: 200 }],
  ];
  const sampler = createCpuLoadSampler(() => readings.shift());
  assert.equal(sampler.sample().currentLoad, 25);
  assert.equal(sampler.sample().currentLoad, 100);
});
