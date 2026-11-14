const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNvidiaSmi, parseWindowsDiskIo, isAllowedOrigin } = require('../lib/parsers');

test('parseNvidiaSmi parses one row per GPU', () => {
  const out = 'NVIDIA GeForce RTX 4060, 37, 8188, 2048, 55, 30, 42.50\r\nNVIDIA GeForce RTX 3080, 0, 10240, 512, 40, 0, 20.00\r\n';
  const gpus = parseNvidiaSmi(out);
  assert.equal(gpus.length, 2);
  assert.deepEqual(gpus[0], {
    name: 'NVIDIA GeForce RTX 4060',
    utilizationGpu: 37,
    memoryTotal: 8188,
    memoryUsed: 2048,
    temperatureGpu: 55,
    fanSpeed: 30,
    powerDraw: 42.5,
  });
});

test('parseNvidiaSmi maps unsupported readings to null', () => {
  const [gpu] = parseNvidiaSmi('Laptop GPU, 12, 4096, 100, 50, [N/A], [N/A]\n');
  assert.equal(gpu.fanSpeed, null);
  assert.equal(gpu.powerDraw, null);
  assert.equal(gpu.utilizationGpu, 12);
});

test('parseNvidiaSmi ignores malformed lines', () => {
  assert.deepEqual(parseNvidiaSmi('garbage\n'), []);
  assert.deepEqual(parseNvidiaSmi(''), []);
});

test('parseWindowsDiskIo reports every lettered volume and the total', () => {
  const json = JSON.stringify([
    { Name: 'C:', DiskReadBytesPerSec: 1000, DiskWriteBytesPerSec: 2000, DiskTransfersPerSec: 5 },
    { Name: 'D:', DiskReadBytesPerSec: 300, DiskWriteBytesPerSec: 400, DiskTransfersPerSec: 2 },
    { Name: 'HarddiskVolume1', DiskReadBytesPerSec: 9, DiskWriteBytesPerSec: 9, DiskTransfersPerSec: 9 },
    { Name: '_Total', DiskReadBytesPerSec: 1300, DiskWriteBytesPerSec: 2400, DiskTransfersPerSec: 7 },
  ]);
  const io = parseWindowsDiskIo(json);
  assert.deepEqual(Object.keys(io.volumes), ['C:', 'D:']);
  assert.deepEqual(io.volumes['D:'], { read: 300, write: 400, iops: 2 });
  assert.deepEqual(io.total, { read: 1300, write: 2400, iops: 7 });
});

test('parseWindowsDiskIo accepts a single object', () => {
  const io = parseWindowsDiskIo('{"Name":"c:","DiskReadBytesPerSec":"10","DiskWriteBytesPerSec":null,"DiskTransfersPerSec":1}');
  assert.deepEqual(io.volumes['C:'], { read: 10, write: 0, iops: 1 });
  assert.equal(io.total, null);
});

test('parseWindowsDiskIo throws on invalid JSON', () => {
  assert.throws(() => parseWindowsDiskIo('not json'));
});

test('isAllowedOrigin allows same-host and origin-less requests only', () => {
  assert.equal(isAllowedOrigin('http://localhost:3000', 'localhost:3000'), true);
  assert.equal(isAllowedOrigin(undefined, 'localhost:3000'), true);
  assert.equal(isAllowedOrigin('https://evil.example', 'localhost:3000'), false);
  assert.equal(isAllowedOrigin('http://localhost:4000', 'localhost:3000'), false);
  assert.equal(isAllowedOrigin('not a url', 'localhost:3000'), false);
});
