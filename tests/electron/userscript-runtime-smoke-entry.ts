import { app } from 'electron';
import path from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

// Pin userData before importing the smoke's production dependency graph.
// Several legacy main-process modules construct electron-store at import time.
// Chromium switches must also be applied synchronously in this entry module;
// applying them after a dynamic import can be too late during startup.
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
const smokeUserDataDir = mkdtempSync(path.join(tmpdir(), 'userscript-runtime-userdata-'));
app.setPath('userData', smokeUserDataDir);
process.env.BAO_SMOKE_USER_DATA = smokeUserDataDir;

void import('./userscript-runtime-smoke');
