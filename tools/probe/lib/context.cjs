// Probe toolkit — context: project root / userData / log locations.
// Pure Node; no Electron required. Probing is READ-ONLY: nothing here writes.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

function projectRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function userDataDir() {
  if (process.env.BAO_PROBE_USER_DATA) return process.env.BAO_PROBE_USER_DATA;
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'bao-flash-browser');
}

function logFile() {
  return path.join(userDataDir(), 'logs', 'main.log');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Latest mtime of a file or directory tree (recursive). Returns 0 when missing.
function latestMtime(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return stat.mtimeMs;
    if (stat.isDirectory()) {
      let latest = stat.mtimeMs;
      for (const entry of fs.readdirSync(target)) {
        latest = Math.max(latest, latestMtime(path.join(target, entry)));
      }
      return latest;
    }
    return 0;
  } catch {
    return 0;
  }
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function createContext() {
  return {
    root: projectRoot(),
    userData: userDataDir(),
    logFile: logFile(),
    readJsonSafe,
    latestMtime,
    exists,
  };
}

module.exports = { createContext, projectRoot, userDataDir, logFile, readJsonSafe, latestMtime, exists };
