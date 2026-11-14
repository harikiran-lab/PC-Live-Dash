/**
 * File locations that differ between running from source (node server.js)
 * and running as the packaged .exe, where the code lives in a read-only
 * snapshot inside the executable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const isPackaged = Boolean(process.pkg);

// Bundled, read-only files: public/, gpu.ps1, node_modules.
const appRoot = path.join(__dirname, '..');

// Where config.json is kept: the project folder, or next to the .exe.
const dataDir = isPackaged ? path.dirname(process.execPath) : appRoot;

/**
 * Path to a bundled script that an external program (PowerShell) must read.
 * External programs cannot see inside the .exe, so when packaged the script
 * is copied to a temporary folder first.
 */
function externalScriptPath(name, version) {
  const bundled = path.join(appRoot, name);
  if (!isPackaged) return bundled;

  const dir = path.join(os.tmpdir(), `pc-live-dash-${version}`);
  const target = path.join(dir, name);
  const contents = fs.readFileSync(bundled);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(contents)) {
    fs.writeFileSync(target, contents);
  }
  return target;
}

module.exports = { isPackaged, appRoot, dataDir, externalScriptPath };
