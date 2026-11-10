// Probe 52 — 自动填充"出现即填"的边界（2026-11-10 用户报告：必须点一下输入框才填）。
//
// 症状拆成六个形态，用真实 tabs/password-capture/password-fill + 生产 preload 逐一验证：
//
//   static    表单在文档解析期就存在                  → did-stop-loading 定时器即可命中
//   late      表单在 12s 后动态插入                    → 只剩 form-detected 信号
//   hidden    12s 插入但 display:none，16s 才显示       → 插入瞬间不可用；显示后是否有信号
//   clickopen 登录框一开始 display:none，点"登录"才显示 → 真实站点形态（7k7k #union）
//   hint      账号框 value 就是提示文字（7k7k #un_name）→ 填充脚本是否把提示当成"用户已填"
//   expired   34s 才插入，随后点一下页面               → 预加载 observer 已到期（30s）
//
// 期望：static/late/hidden/clickopen 全部"无需点输入框"自动填好；
// hint 必须把提示文字当空值、账号密码都填上；expired 至少靠点击兜底填上。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { wait, waitFor } = require('../lib/timeout.cjs');

const HINT = '用户名/邮箱/KK号';
const PASSWORD_VALUE = 'fixture-pass-a';
const LOGIN_FORM = '<form id="login">'
  + `<input id="un_name" name="username" value="${HINT}" placeholder="${HINT}">`
  + '<input id="un_pass" name="password" type="password" autocomplete="current-password"></form>';
const PLAIN_FORM = '<form id="login"><input name="username" autocomplete="username">'
  + '<input name="password" type="password" autocomplete="current-password"></form>';

function pageHtml(kind) {
  if (kind === 'static') return `<main>${PLAIN_FORM}</main>`;
  if (kind === 'late') {
    return '<main id="panel"></main><script>setTimeout(function(){'
      + `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(PLAIN_FORM)});}, 12000);</script>`;
  }
  if (kind === 'hidden') {
    return '<main id="panel"></main><div id="wrap" style="display:none"></div><script>'
      + `setTimeout(function(){document.getElementById('wrap').innerHTML=${JSON.stringify(PLAIN_FORM)};}, 12000);`
      + "setTimeout(function(){document.getElementById('wrap').style.display='block';}, 16000);"
      + '</script>';
  }
  if (kind === 'clickopen') {
    // 7k7k 形态：登录层一开始 display:none，点登录按钮才显示（站点在 click 里同步 show）
    return '<button id="open">登录</button><div id="union" style="display:none">' + PLAIN_FORM + '</div>'
      + '<script>document.getElementById("open").addEventListener("click",function(){'
      + 'document.getElementById("union").style.display="block";});</script>';
  }
  if (kind === 'hint') return `<main>${LOGIN_FORM}</main>`;
  if (kind === 'expired') {
    return '<main id="panel"></main><script>setTimeout(function(){'
      + `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(PLAIN_FORM)});}, 34000);</script>`;
  }
  throw new Error('unknown page kind: ' + kind);
}

module.exports = {
  id: '52-password-autofill-rearm',
  name: 'autofill rearm: static / late / hidden / click-open / hint value / expired observer',
  needsElectron: true,
  timeoutMs: 240000,

  async run(ctx) {
    const { BrowserWindow, ipcMain } = ctx.electron;
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-autofill-rearm-')), 'bundle.cjs');
    // 保留生产 capture/fill/TabManager；只隔离保险库、宿主窗口与无关网络策略。
    await require('esbuild').build({
      stdin: { contents: "export * from './src/main/modules/password-capture'; export * from './src/main/modules/password-fill'; export * from './src/main/modules/tabs';", resolveDir: ctx.root, loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node12',
      external: ['electron', 'electron-log'], alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{ name: 'isolated-autofill-ports', setup(build) {
        build.onLoad({ filter: /[\\/]modules[\\/](password-store|window|session-manager|ui-language)\.ts$/ }, (args) => {
          const name = path.basename(args.path);
          const contents = name === 'password-store.ts'
            ? "export const getMetaForHost=()=>[]; export const getDecryptedPassword=()=>null; export const isAutoCaptureEnabled=()=>true; export const isCaptureExcluded=()=>false;"
            : name === 'window.ts' ? 'export const getMainWindow=()=>globalThis.__baoAutofillWindow;'
              : name === 'ui-language.ts' ? 'export const uiText=(zh)=>zh;'
                : 'export const setupSessionOnce=()=>{};';
          return { contents, loader: 'ts' };
        });
      } }],
    });
    const Module = require('module');
    const bundled = new Module(outfile, module);
    bundled.filename = outfile; bundled.paths = Module._nodeModulePaths(ctx.root);
    bundled._compile(fs.readFileSync(outfile, 'utf8'), outfile);
    const mod = bundled.exports;

    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: false } });
    globalThis.__baoAutofillWindow = win;
    mod.createTabManager(win, path.join(ctx.root, 'dist/webview-preload.js'));
    win.webContents.send = () => {};

    // 记录每一次填充尝试（日志里看不到的东西）：时间 + 结果原因。
    const attempts = [];
    const fillPasswords = async (wc, resolve) => {
      const startedAt = Date.now();
      const result = await mod.fillPasswordsInWebContents(wc, resolve);
      attempts.push({ at: startedAt, reason: result.reason ?? 'filled', filledFields: result.filledFields, filledCredentials: result.filledCredentials, wcId: wc.id });
      return result;
    };
    const formDetected = [];
    const handlers = {
      'get-ruffle-mode': (event) => { event.returnValue = { enabled: false, source: 'bundled', js: '', bundle: null }; },
      'userscript:get-config': (event) => { event.returnValue = { ok: true, scripts: [], values: {} }; },
      'password:form-detected': (event) => {
        formDetected.push({ at: Date.now(), wcId: event.sender.id });
        mod.tabManager.notifyPasswordFormDetected(event.sender.id);
      },
    };
    for (const [name, handler] of Object.entries(handlers)) ipcMain.on(name, handler);

    const server = http.createServer((req, res) => {
      const kind = String(req.url || '/').replace(/^\//, '').split('?')[0] || 'static';
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(pageHtml(kind));
      } catch {
        res.writeHead(404); res.end('no fixture');
      }
    });

    const read = (wc, script) => wc.executeJavaScript(script).catch(() => false);
    const filledValues = (wc) => read(wc, `(function(){
      var p=document.querySelector('input[type=password]');
      var u=document.querySelector('#un_name,[autocomplete=username],input[name=username]');
      return { password: !!p && p.value, username: u ? u.value : null,
        visible: !!p && p.getBoundingClientRect().width > 0 };
    })()`);
    const cases = [];

    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      mod.configureOptionalTabServices({ passwords: {
        setupCapture: mod.setupCapture, teardownCapture: mod.teardownCapture,
        fillPasswords,
        isAutoFillEnabled: () => true,
        getFillCredentialForUrl: (url) => (url.startsWith(origin) ? { username: 'fixture-a', password: PASSWORD_VALUE } : null),
      } });
      mod.tabManager.setPreload(path.join(ctx.root, 'dist/webview-preload.js'));
      mod.tabManager.setBounds(0, 0, 720, 480);

      /** clickWhat: 表单出现后要模拟的页面动作（打开登录框 / 随便点一下页面）。 */
      const runCase = async (kind, { insertedAfterMs, waitMs, clickWhat }) => {
        const tabId = 'probe-' + kind;
        const attemptFrom = attempts.length;
        mod.tabManager.create(tabId, `${origin}/${kind}`);
        mod.tabManager.activate(tabId);
        const wc = mod.tabManager.getWebContents(tabId);
        const startedAt = Date.now();
        await waitFor(() => read(wc, `!!document.querySelector('input[type=password]')`), {
          timeoutMs: insertedAfterMs + 8000, intervalMs: 100, label: kind + ': password input present',
        });
        const appearedAt = Date.now();
        let autoFilledAt = null;
        const waitFilled = async (budget) => {
          try {
            await waitFor(async () => (await filledValues(wc)).password === PASSWORD_VALUE, {
              timeoutMs: budget, intervalMs: 100, label: kind + ': autofill',
            });
            return Date.now();
          } catch { return null; }
        };
        if (clickWhat) {
          // 先让 did-stop-loading 的 120ms/1s/3s 定时器全部跑完（证明"仅靠定时器"填不上），
          // 再模拟页面动作；随后的等待刻意短于 10s 那档定时器，避免把定时器兜底算成自动填充。
          await wait(3500);
          await read(wc, clickWhat);
          autoFilledAt = await waitFilled(waitMs);
        } else {
          autoFilledAt = await waitFilled(waitMs);
        }
        const values = await filledValues(wc);
        const record = {
          kind,
          autoFilledMs: autoFilledAt ? autoFilledAt - appearedAt : null,
          username: values.username,
          formDetected: formDetected.filter((entry) => entry.wcId === wc.id).length,
          attempts: attempts.slice(attemptFrom),
          totalMs: Date.now() - startedAt,
        };
        cases.push(record);
        mod.tabManager.close(tabId);
        await wait(200);
        return record;
      };

      await runCase('static', { insertedAfterMs: 0, waitMs: 8000 });
      await runCase('late', { insertedAfterMs: 14000, waitMs: 6000 });
      await runCase('hidden', { insertedAfterMs: 18000, waitMs: 12000 });
      await runCase('clickopen', { insertedAfterMs: 0, waitMs: 2500, clickWhat: "document.getElementById('open').click()" });
      await runCase('hint', { insertedAfterMs: 0, waitMs: 8000 });
      await runCase('expired', { insertedAfterMs: 36000, waitMs: 6000, clickWhat: "document.getElementById('panel').click()" });

      const byKind = Object.fromEntries(cases.map((item) => [item.kind, item]));
      const autoOk = (kind) => byKind[kind]?.autoFilledMs != null;
      const hintOk = autoOk('hint') && byKind.hint?.username === 'fixture-a';
      const staticOk = autoOk('static');
      const lateOk = autoOk('late');
      const hiddenOk = autoOk('hidden');
      const clickOpenOk = autoOk('clickopen');
      const expiredOk = autoOk('expired');
      return {
        ok: staticOk && lateOk && hiddenOk && clickOpenOk && hintOk && expiredOk,
        summary: `static=${staticOk ? 'auto' : 'MISS'} late=${lateOk ? 'auto' : 'MISS'} `
          + `hidden=${hiddenOk ? 'auto' : 'MISS'} clickopen=${clickOpenOk ? 'auto' : 'MISS'} `
          + `hint=${hintOk ? 'auto' : (autoOk('hint') ? 'password-only' : 'MISS')} expired=${expiredOk ? 'auto' : 'MISS'}`,
        detail: { cases },
      };
    } finally {
      mod.tabManager.destroyAll();
      mod.configureOptionalTabServices({});
      for (const [name, handler] of Object.entries(handlers)) ipcMain.removeListener(name, handler);
      if (!win.isDestroyed()) win.destroy();
      delete globalThis.__baoAutofillWindow;
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
