// Probe: view-gate Windows backend (CredUI + LogonUserW) — non-interactive paths.
//
// Validates what can be validated without a human: the PowerShell script that
// src/main/modules/view-gate-win.ts ships actually parses and runs on this
// machine, its stdout contract holds, the self-check path reaches the SID
// comparison, and a bad credential is reported as `bad-credential`.
//
// IMPORTANT: the script is EXTRACTED FROM THE MODULE SOURCE at runtime instead
// of being copied here. A second copy would silently drift from production —
// and the whole point of this probe is to test production.
//
// What this probe deliberately does NOT do: pop the CredUI dialog. That path
// needs a human to type a real password (and to cancel it); it is the one
// remaining piece of the view gate that automated probes cannot cover.
//
// CAUTION: `LogonUserW` failures count toward the account's bad-password /
// lockout policy. The failing cases below therefore use an obviously bogus
// account name, never the real one.
//
// Pure Node — no Electron needed. Honors BFB_POWERSHELL_CMD to exercise the
// spawn-failure path. Read-only: never touches userData or app state.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SKIP_FLAG = 'BFB_VIEWGATE_SKIP_PROMPT';

/** 脚本数组里插值的模块常量（必须与 view-gate-win.ts 同名）。 */
const CONST_NAMES = ['CREDUI_FLAGS', 'WIN32_ERROR_CANCELLED', 'LOGON32_LOGON_NETWORK', 'LOGON32_PROVIDER_DEFAULT'];

/**
 * 从 view-gate-win.ts 抽出 PS_VERIFY 脚本（唯一真源）。
 *
 * 该数组不是纯字面量：它插值了上面四个模块常量，所以先把常量声明也从源码里解出来，
 * 再以参数注入的方式求值——这样脚本本体与常量都只有一份真源。
 */
function extractScript(root) {
  const file = path.join(root, 'src/main/modules/view-gate-win.ts');
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/const PS_VERIFY = \[([\s\S]*?)\]\.join\('\\n'\);/);
  if (!match) return { ok: false, reason: 'PS_VERIFY array not found in ' + file };

  const values = [];
  for (const name of CONST_NAMES) {
    const declaration = source.match(new RegExp('const ' + name + '\\s*=\\s*([^;\\n]+);'));
    if (!declaration) return { ok: false, reason: `constant ${name} not found in view-gate-win.ts` };
    try {
      // eslint-disable-next-line no-eval
      values.push(eval(declaration[1]));
    } catch (error) {
      return { ok: false, reason: `cannot evaluate ${name}: ${error.message}` };
    }
  }

  let lines;
  try {
    // eslint-disable-next-line no-new-func
    lines = new Function(...CONST_NAMES, 'return [' + match[1] + '];')(...values);
  } catch (error) {
    return { ok: false, reason: 'cannot evaluate PS_VERIFY lines: ' + error.message };
  }
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
    return { ok: false, reason: 'PS_VERIFY is not a string array' };
  }
  return { ok: true, script: lines.join('\n'), file, constants: values };
}

function runScript(script, payloadB64, timeoutMs) {
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
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { child.kill(); } catch { /* already dead */ }
      resolve({ code: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 'spawn-error', message: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
      if (!first) {
        resolve({ code: 'bad-response', exitCode: code, stderr: stderr.slice(0, 300) });
        return;
      }
      const match = /^(OK|ERR)\s+(.*)$/.exec(first);
      if (!match) {
        resolve({ code: 'bad-response', exitCode: code, first, stderr: stderr.slice(0, 300) });
        return;
      }
      resolve({ code: match[1] === 'OK' ? 'ok' : 'err', value: match[2], exitCode: code });
    });
    child.stdin.on('error', () => { /* EPIPE after exit */ });
    child.stdin.end(payloadB64 + '\n');
  });
}

module.exports = {
  id: '22-viewgate-credui',
  name: 'view-gate CredUI backend (non-interactive paths)',
  needsElectron: false,
  timeoutMs: 90_000,

  async run(ctx) {
    if (process.platform !== 'win32') {
      return { ok: true, summary: 'skipped (not win32)', detail: { platform: process.platform } };
    }

    const extracted = extractScript(ctx.root);
    if (!extracted.ok) return { ok: false, summary: extracted.reason };
    const script = extracted.script;

    // 脚本必须纯 ASCII：Windows PowerShell 5.1 按 ANSI 解码 -Command，
    // 非 ASCII 会破坏引号配对、让整段脚本语法错误（2026-09-22 实跑踩过）。
    const asciiOnly = !/[^\x00-\x7F]/.test(script);
    const hasDialog = script.includes('CredUIPromptForWindowsCredentialsW');
    const hasLogon = script.includes('LogonUserW');
    const hasSidCheck = script.includes('not-current-user');

    const previousSkip = process.env[SKIP_FLAG];
    const previousCmd = process.env.BFB_POWERSHELL_CMD;
    process.env[SKIP_FLAG] = '1';
    const timeout = 60_000;
    const result = { asciiOnly, hasDialog, hasLogon, hasSidCheck };

    try {
      // 1) 自检：空凭据 → 用当前进程 token 走同一条 SID 比对路径 → OK granted
      result.selfCheck = await runScript(script, '', timeout);

      // 2) 错误密码 → ERR bad-credential（LogonUserW 返回 1326）。
      //    用不存在的账户，理由同上：不能让探针把真实账户的失败计数打上去。
      result.badPassword = await runScript(
        script,
        Buffer.from('bol_no_such_user\nthis-is-not-the-password\n', 'utf8').toString('base64'),
        timeout,
      );

      // 3) 域限定名（走拆分路径）→ 同样是 bad-credential，但不能崩。
      //    刻意用一个**不存在的域 + 不存在的账户**：LogonUserW 的失败调用会累加到
      //    账户的"错误密码"计数上，打真实账户反复跑这个探针可能触发系统锁定策略。
      result.domainUser = await runScript(
        script,
        Buffer.from('BOL_NO_SUCH_DOMAIN\\bol_no_such_user\nsomepass\n', 'utf8').toString('base64'),
        timeout,
      );

      // 4) 子进程不可用 → spawn-error（调用方据此判 unavailable，fail closed）
      process.env.BFB_POWERSHELL_CMD = process.platform === 'win32'
        ? 'C:\\__bfb_no_such_powershell__.exe'
        : '/nonexistent/powershell';
      result.spawnFailure = await runScript(script, '', timeout);
    } finally {
      if (previousSkip === undefined) delete process.env[SKIP_FLAG];
      else process.env[SKIP_FLAG] = previousSkip;
      if (previousCmd === undefined) delete process.env.BFB_POWERSHELL_CMD;
      else process.env.BFB_POWERSHELL_CMD = previousCmd;
    }

    const problems = [];
    if (!asciiOnly) problems.push('script is not ASCII-only');
    if (!hasDialog || !hasLogon || !hasSidCheck) problems.push('script lost dialog/LogonUser/SID check');
    if (result.selfCheck.code !== 'ok' || result.selfCheck.value !== 'granted') {
      problems.push('self-check did not return OK granted (' + JSON.stringify(result.selfCheck).slice(0, 120) + ')');
    }
    if (result.badPassword.code !== 'err' || result.badPassword.value !== 'bad-credential') {
      problems.push('bad password was not classified bad-credential');
    }
    if (result.domainUser.code !== 'err') problems.push('domain-qualified user path did not report an error');
    if (result.spawnFailure.code !== 'spawn-error') problems.push('spawn failure was not reported as spawn-error');

    return {
      ok: problems.length === 0,
      summary: problems.length === 0
        ? 'self-check granted, bad password rejected, spawn failure fail-closed (dialog path needs a human)'
        : problems.join('; '),
      detail: result,
    };
  },
};
