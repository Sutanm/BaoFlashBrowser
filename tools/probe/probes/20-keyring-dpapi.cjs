// Probe: Windows DPAPI roundtrip via PowerShell + .NET ProtectedData.
//
// Validates the REAL environment capability that keyring-win-dpapi.ts relies
// on: powershell.exe reachable, Add-Type System.Security allowed (i.e. not
// blocked by GPO/AppLocker), DPAPI CurrentUser protect/unprotect roundtrip.
// Pure Node — no Electron needed. Honors BFB_POWERSHELL_CMD override
// (dev-only, used to exercise the spawn-failure path).
'use strict';

const { spawn } = require('child_process');

const PS_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Security',
  '  $line = [Console]::In.ReadLine()',
  '  if ([string]::IsNullOrEmpty($line)) { Write-Output "ERR empty-input"; exit 1 }',
  '  $bytes = [Convert]::FromBase64String($line)',
  '  $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  "  Write-Output ('OK ' + [Convert]::ToBase64String($enc))",
  '}',
  'catch {',
  '  Write-Output ("ERR " + $_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

const PS_UNPROTECT = PS_PROTECT.replace('Protect($bytes', 'Unprotect($bytes').replace(
  'ToBase64String($enc)',
  'ToBase64String($dec)',
).replace('$enc = ', '$dec = ');

function runPs(script, payloadB64, timeoutMs) {
  return new Promise((resolve) => {
    const exe = process.env.BFB_POWERSHELL_CMD || 'powershell.exe';
    let child;
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: 'spawn-error', message: error.message });
      return;
    }
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { child.kill(); } catch { /* noop */ }
      resolve({ code: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', () => { /* diagnostics only */ });
    child.on('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code: 'spawn-error', message: error.message }); }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
      const match = /^(OK|ERR)\s+(.*)$/.exec(first);
      if (!match) resolve({ code: 'bad-response', exitCode: code });
      else if (match[1] === 'OK') resolve({ code: 'ok', value: match[2], exitCode: code });
      else resolve({ code: 'exit-error', message: match[2], exitCode: code });
    });
    child.stdin.on('error', () => { /* EPIPE */ });
    child.stdin.end(`${payloadB64}\n`);
  });
}

module.exports = {
  id: '20-keyring-dpapi',
  name: 'DPAPI roundtrip (win-dpapi backend prereq)',
  needsElectron: false,
  timeoutMs: 30000,

  async run() {
    if (process.platform !== 'win32') {
      return { ok: false, summary: `skipped (platform=${process.platform}, win32 required)`, detail: { platform: process.platform } };
    }
    const probePlain = 'keyring-probe-42';
    const probeB64 = Buffer.from(probePlain, 'utf8').toString('base64');
    const wrap = await runPs(PS_PROTECT, probeB64, 10000);
    if (wrap.code !== 'ok') {
      return { ok: false, summary: `protect failed: ${wrap.code}${wrap.message ? ` (${wrap.message})` : ''}`, detail: wrap };
    }
    const unwrap = await runPs(PS_UNPROTECT, wrap.value, 15000);
    if (unwrap.code !== 'ok') {
      return { ok: false, summary: `unprotect failed: ${unwrap.code}${unwrap.message ? ` (${unwrap.message})` : ''}`, detail: unwrap };
    }
    if (unwrap.value !== probeB64) {
      return { ok: false, summary: 'roundtrip mismatch', detail: { expect: probeB64, got: unwrap.value } };
    }
    return { ok: true, summary: 'DPAPI protect/unprotect roundtrip OK' };
  },
};
