// Probe: Linux Secret Service roundtrip via `secret-tool`.
//
// Validates the REAL environment capability that keyring-linux-secret-tool.ts
// relies on: a reachable D-Bus session bus, an activatable
// org.freedesktop.secrets, and store/lookup/clear semantics under it.
// Pure Node — no Electron needed.
//
// Skips on non-linux. Honors BFB_SECRET_TOOL_CMD (dev-only spawn-failure path).
//
// Empirical contract this probe re-checks every run (learned on Ubuntu 26.04 /
// libsecret 0.21.7): "item missing" and "bus unreachable" BOTH exit 1, and only
// stderr tells them apart. A regression here would make the backend classify a
// transient outage as a corrupted ciphertext.
'use strict';

const { spawn } = require('child_process');

const ATTR = ['service', 'baoflash-browser', 'bfb-key'];

function runSecretTool(args, stdin, timeoutMs) {
  return new Promise((resolve) => {
    const exe = process.env.BFB_SECRET_TOOL_CMD || 'secret-tool';
    let child;
    try {
      child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: 'spawn-error', message: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { child.kill(); } catch { /* noop */ }
      resolve({ code: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
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
      resolve({ code: code === 0 ? 'ok' : 'exit-error', exitCode: code, stdout, stderr: stderr.trim() });
    });
    child.stdin.on('error', () => { /* EPIPE */ });
    child.stdin.end(stdin);
  });
}

module.exports = {
  id: '21-keyring-secret-tool',
  name: 'Secret Service roundtrip (linux-secret-service backend prereq)',
  needsElectron: false,
  timeoutMs: 45000,

  async run() {
    if (process.platform !== 'linux') {
      // 平台不符 = 不适用，不是失败（同 22/26 的约定；否则 Windows 跑探针会误报）。
      return { ok: true, summary: `skipped (not linux, platform=${process.platform})`, detail: { platform: process.platform } };
    }

    const id = `${Date.now().toString(16)}${'0'.repeat(32)}`.slice(0, 32);
    const plain = 'keyring-probe-42';
    const b64 = Buffer.from(plain, 'utf8').toString('base64');

    const store = await runSecretTool(['store', '--label=bfb probe', ...ATTR, id], b64, 15000);
    if (store.code !== 'ok') {
      return {
        ok: false,
        summary: `store failed: ${store.code}${store.message ? ` (${store.message})` : ''}${store.stderr ? ` (${store.stderr})` : ''}`,
        detail: store,
      };
    }

    try {
      const lookup = await runSecretTool(['lookup', ...ATTR, id], '', 10000);
      if (lookup.code !== 'ok') {
        return { ok: false, summary: `lookup failed: ${lookup.code}`, detail: lookup };
      }
      if (lookup.stdout !== b64) {
        return { ok: false, summary: 'roundtrip mismatch', detail: { expect: b64, got: lookup.stdout } };
      }
      if (/\n$/.test(lookup.stdout) && lookup.stdout.replace(/\n$/, '') === b64) {
        return { ok: false, summary: 'lookup appends a trailing newline (backend strips one, but contract drift)', detail: lookup };
      }

      // 条目不存在：必须 exit≠0 且 stderr 为空（后端据此判"确定性失败"）。
      const miss = await runSecretTool(['lookup', ...ATTR, 'f'.repeat(32)], '', 10000);
      if (miss.code === 'ok') {
        return { ok: false, summary: 'missing item returned exit 0 (unexpected)', detail: miss };
      }
      if (miss.stderr) {
        return {
          ok: false,
          summary: `missing item writes stderr (breaks transient/deterministic split): ${miss.stderr.slice(0, 120)}`,
          detail: miss,
        };
      }

      return { ok: true, summary: 'secret-tool store/lookup/miss contract OK' };
    } finally {
      await runSecretTool(['clear', ...ATTR, id], '', 10000);
    }
  },
};
