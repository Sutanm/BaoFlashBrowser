// DPAPI 抽象层（Windows 数据保护 API）
// 优先使用 win-dpapi 原生绑定；不可用时回退到 PowerShell 调用 .NET ProtectedData。
// 对外接口：isAvailable() / protect(plainBuffer) -> cipherBuffer / unprotect(cipherBuffer) -> plainBuffer
var log = require('electron-log');
var childProcess = require('child_process');

var winDpapi = null;
var _impl = 'none';

try {
  winDpapi = require('win-dpapi');
  _impl = 'win-dpapi';
} catch (e) {
  _impl = 'powershell';
}

function isWindows() {
  return process.platform === 'win32';
}

function isAvailable() {
  if (!isWindows()) return false;
  if (_impl === 'win-dpapi' && winDpapi) return true;
  if (_impl === 'powershell') return true; // Windows 自带 Windows PowerShell 5.1
  return false;
}

function impl() { return _impl; }

// --- win-dpapi 路径 ---
// win-dpapi: protectData(plaintextBuffer, entropyBuffer|null, scopeString)
//            unprotectData(ciphertextBuffer, entropyBuffer|null, scopeString)
// scope: 'CurrentUser' | 'LocalMachine'
function protectNative(plainBuffer) {
  return winDpapi.protectData(plainBuffer, null, 'CurrentUser');
}

function unprotectNative(cipherBuffer) {
  return winDpapi.unprotectData(cipherBuffer, null, 'CurrentUser');
}

// --- PowerShell 回退路径 ---
// 通过 stdin 传入 base64，stdout 返回 base64，避免命令行暴露明文密钥。
var PROTECT_PS = [
  '$ErrorActionPreference="Stop"',
  'Add-Type -AssemblyName System.Security',
  '$in=[Console]::In.ReadToEnd().Trim()',
  '$bytes=[Convert]::FromBase64String($in)',
  '$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))'
].join(';');

var UNPROTECT_PS = [
  '$ErrorActionPreference="Stop"',
  'Add-Type -AssemblyName System.Security',
  '$in=[Console]::In.ReadToEnd().Trim()',
  '$bytes=[Convert]::FromBase64String($in)',
  '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($out))'
].join(';');

function runPs(script, b64Input) {
  var res = childProcess.spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: b64Input, encoding: 'utf8', windowsHide: true, timeout: 15000 }
  );
  if (res.status !== 0) {
    var msg = (res.stderr && res.stderr.toString()) ? res.stderr.toString().trim() : ('exit=' + res.status);
    throw new Error('PowerShell DPAPI failed: ' + msg);
  }
  var out = (res.stdout || '').trim();
  if (!out) throw new Error('PowerShell DPAPI empty output');
  return Buffer.from(out, 'base64');
}

function protect(plainBuffer) {
  if (!isAvailable()) throw new Error('DPAPI 不可用（非 Windows 或无可用实现）');
  if (_impl === 'win-dpapi') return protectNative(plainBuffer);
  return runPs(PROTECT_PS, plainBuffer.toString('base64'));
}

function unprotect(cipherBuffer) {
  if (!isAvailable()) throw new Error('DPAPI 不可用（非 Windows 或无可用实现）');
  if (_impl === 'win-dpapi') return unprotectNative(cipherBuffer);
  return runPs(UNPROTECT_PS, cipherBuffer.toString('base64'));
}

// 启动时自检（仅日志，不抛错）
function selfTest() {
  if (!isAvailable()) {
    log.info('[DPAPI] 不可用，自动填充将需要主密码解锁');
    return false;
  }
  try {
    var probe = Buffer.from('baoflash-dpapi-probe');
    var enc = protect(probe);
    var dec = unprotect(enc);
    if (dec && dec.toString() === probe.toString()) {
      log.info('[DPAPI] 自检通过，实现：' + _impl);
      return true;
    }
    log.warn('[DPAPI] 自检数据不一致');
    return false;
  } catch (e) {
    log.warn('[DPAPI] 自检失败：' + e.message);
    return false;
  }
}

module.exports = {
  isAvailable: isAvailable,
  impl: impl,
  protect: protect,
  unprotect: unprotect,
  selfTest: selfTest
};
