// Probe 47 · P7/P8：PPAPI（Flash）BrowserView 跨窗口迁移后仍出帧
//
// `ppapi-flash-*` 开关必须在 app ready 之前设置，探针宿主做不到，因此本探针
// spawn 一个独立 Electron 子进程（lib/flash-tear-off-child.cjs）完成真实验证：
//   - 插件文档（embed）确实加载
//   - 迁移前后 capturePage 均非纯色（Flash 在出帧）
//   - 迁移后 wc.id / pid 不变、画面尺寸不变、视图挂到目标窗口
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '47-flash-tear-off',
  name: 'P7 PPAPI tear-off keeps rendering',
  needsElectron: true,
  timeoutMs: 120_000,

  async run(ctx) {
    const childPath = path.join(__dirname, '..', 'lib', 'flash-tear-off-child.cjs');
    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [childPath, ctx.root], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    try {
      await waitFor(() => stdout.includes('FLASH_RESULT:'), { timeoutMs: 90_000, intervalMs: 200, label: 'flash child result' });
    } catch (error) {
      return {
        ok: false,
        summary: 'flash child did not report a result',
        detail: { error: error.message, stderr: stderr.slice(-2000) },
      };
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }

    const line = stdout.split('\n').find((item) => item.includes('FLASH_RESULT:'));
    let result = null;
    try { result = JSON.parse(line.slice(line.indexOf('FLASH_RESULT:') + 'FLASH_RESULT:'.length)); } catch { /* below */ }
    if (!result) {
      return { ok: false, summary: 'invalid flash child result', detail: { line, stderr: stderr.slice(-2000) } };
    }

    check('flash child reported ok', result.ok === true, { result, stderr: stderr.slice(-1500) });
    check('plugin document has embed', (result.first?.embeds ?? 0) > 0, result.first);
    check('before capture is non-uniform', Boolean(result.first && result.first.before && result.first.before.max - result.first.before.min > 8), result.first?.before);
    check('after capture is non-uniform', Boolean(result.after && result.after.max - result.after.min > 8), result.after);
    check('capture size unchanged', Boolean(result.first && result.after
      && result.first.before.width === result.after.width
      && result.first.before.height === result.after.height), { before: result.first?.before, after: result.after });

    return {
      ok: failures.length === 0,
      summary: failures.length === 0
        ? 'PPAPI view migrated and kept rendering (embed + non-uniform frames)'
        : `${failures.length} check(s) failed`,
      detail: { failures, child: result, stderr: stderr.slice(-1500) },
    };
  },
};
