import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import childProcess from 'child_process';
import execa from 'execa';

let winDpapi: { protectData: (b: Buffer, e: null, s: string) => Buffer; unprotectData: (b: Buffer, e: null, s: string) => Buffer } | null = null;
let _impl: 'win-dpapi' | 'powershell' | 'none' = 'none';

try {
  winDpapi = require('win-dpapi');
  _impl = 'win-dpapi';
} catch (_e) {
  _impl = 'powershell';
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

export function isAvailable(): boolean {
  if (!isWindows()) return false;
  if (_impl === 'win-dpapi' && winDpapi) return true;
  if (_impl === 'powershell') return true;
  return false;
}

export function impl(): string {
  return _impl;
}

function protectNative(plainBuffer: Buffer): Buffer {
  return winDpapi!.protectData(plainBuffer, null, 'CurrentUser');
}

function unprotectNative(cipherBuffer: Buffer): Buffer {
  return winDpapi!.unprotectData(cipherBuffer, null, 'CurrentUser');
}

const PROTECT_PS = [
  '$ErrorActionPreference="Stop"',
  'Add-Type -AssemblyName System.Security',
  '$in=[Console]::In.ReadToEnd().Trim()',
  '$bytes=[Convert]::FromBase64String($in)',
  '$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join(';');

const UNPROTECT_PS = [
  '$ErrorActionPreference="Stop"',
  'Add-Type -AssemblyName System.Security',
  '$in=[Console]::In.ReadToEnd().Trim()',
  '$bytes=[Convert]::FromBase64String($in)',
  '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join(';');

function runPs(script: string, b64Input: string): Buffer {
  const psExe = getPsExe();

  const res = childProcess.spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: b64Input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (res.status !== 0) {
    const msg = res.stderr ? res.stderr.toString().trim() : 'exit=' + res.status;
    throw new Error('PowerShell DPAPI failed: ' + msg);
  }
  const out = (res.stdout || '').trim();
  if (!out) throw new Error('PowerShell DPAPI empty output');
  return Buffer.from(out, 'base64');
}

// --- L15: 异步版本（使用 execa，Node 12 兼容 timeout） ---
function getPsExe(): string {
  return fs.existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    ? 'powershell.exe'
    : process.env.PATH?.split(';').find((d) => {
        try { return fs.existsSync(path.join(d, 'pwsh.exe')); } catch { return false; }
      })
      ? 'pwsh.exe'
      : 'powershell.exe';
}

async function runPsAsync(script: string, b64Input: string): Promise<Buffer> {
  const result = await execa(getPsExe(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: b64Input,
    timeout: 15000,       // execa 5.x 内部用 setTimeout + child.kill() 实现，兼容 Node 12
    reject: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.failed || result.timedOut) {
    throw new Error('PowerShell DPAPI failed: ' + (result.stderr?.trim() || result.message));
  }
  const out = result.stdout.trim();
  if (!out) throw new Error('PowerShell DPAPI empty output');
  return Buffer.from(out, 'base64');
}

export function protect(plainBuffer: Buffer): Buffer {
  if (!isAvailable()) throw new Error('DPAPI unavailable (not Windows or no implementation)');
  if (_impl === 'win-dpapi') return protectNative(plainBuffer);
  return runPs(PROTECT_PS, plainBuffer.toString('base64'));
}

export function unprotect(cipherBuffer: Buffer): Buffer {
  if (!isAvailable()) throw new Error('DPAPI unavailable (not Windows or no implementation)');
  if (_impl === 'win-dpapi') return unprotectNative(cipherBuffer);
  return runPs(UNPROTECT_PS, cipherBuffer.toString('base64'));
}

export function selfTest(): boolean {
  if (!isAvailable()) {
    log.info('[DPAPI] unavailable, auto-fill will require master password');
    return false;
  }
  try {
    const probe = Buffer.from('baoflash-dpapi-probe');
    const enc = protect(probe);
    const dec = unprotect(enc);
    if (dec && dec.toString() === probe.toString()) {
      log.info('[DPAPI] self-test passed, impl: ' + _impl);
      return true;
    }
    log.warn('[DPAPI] self-test data mismatch');
    return false;
  } catch (e: unknown) {
    log.warn('[DPAPI] self-test failed: ' + (e as Error).message);
    return false;
  }
}

// --- L15: 异步导出（运行时使用，不阻塞主进程） ---
export async function protectAsync(plainBuffer: Buffer): Promise<Buffer> {
  if (!isAvailable()) throw new Error('DPAPI unavailable');
  if (_impl === 'win-dpapi') return protectNative(plainBuffer);
  return runPsAsync(PROTECT_PS, plainBuffer.toString('base64'));
}

export async function unprotectAsync(cipherBuffer: Buffer): Promise<Buffer> {
  if (!isAvailable()) throw new Error('DPAPI unavailable');
  if (_impl === 'win-dpapi') return unprotectNative(cipherBuffer);
  return runPsAsync(UNPROTECT_PS, cipherBuffer.toString('base64'));
}
