const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettingsStore, resolveHost, isLoopbackAddress, isLocalHostHeader } = require('../lib/settings');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pcld-')), 'config.json');
}

test('settings default to LAN access off when no file exists', () => {
  assert.deepEqual(createSettingsStore(tempFile()).load(), { lanAccess: false, port: 3000 });
});

test('settings persist across store instances', () => {
  const file = tempFile();
  const first = createSettingsStore(file);
  first.load();
  assert.equal(first.update({ lanAccess: true }).lanAccess, true);
  assert.equal(createSettingsStore(file).load().lanAccess, true);
});

test('a damaged or invalid file falls back to defaults', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not json');
  assert.equal(createSettingsStore(file).load().lanAccess, false);
  fs.writeFileSync(file, '{"lanAccess":"yes","other":1}');
  assert.equal(createSettingsStore(file).load().lanAccess, false);
});

test('resolveHost follows the saved setting unless HOST is set', () => {
  assert.deepEqual(resolveHost(undefined, { lanAccess: false }), { host: '127.0.0.1', locked: false });
  assert.deepEqual(resolveHost(undefined, { lanAccess: true }), { host: '0.0.0.0', locked: false });
  assert.deepEqual(resolveHost('192.168.1.5', { lanAccess: false }), { host: '192.168.1.5', locked: true });
});

test('local request checks', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
  assert.equal(isLocalHostHeader('localhost:3000'), true);
  assert.equal(isLocalHostHeader('127.0.0.1:3000'), true);
  assert.equal(isLocalHostHeader('evil.example:3000'), false);
  assert.equal(isLocalHostHeader(undefined), false);
});

test('port is saved when valid and ignored when not', () => {
  const { isValidPort, resolvePort } = require('../lib/settings');
  const file = tempFile();
  const store = createSettingsStore(file);
  assert.equal(store.load().port, 3000);
  assert.equal(store.update({ port: 8080 }).port, 8080);
  assert.equal(createSettingsStore(file).load().port, 8080);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(3000.5), false);
  assert.deepEqual(resolvePort(undefined, { port: 8080 }), { port: 8080, locked: false });
  assert.deepEqual(resolvePort('4000', { port: 8080 }), { port: 4000, locked: true });
  assert.deepEqual(resolvePort('abc', { port: 8080 }), { port: 8080, locked: false });
});
