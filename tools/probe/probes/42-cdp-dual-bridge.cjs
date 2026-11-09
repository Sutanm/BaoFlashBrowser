// Probe 42 · P4 可行性：两个独立 CDP 桥能否并存
//
// 「严格对齐 Chrome」要求每个窗口拥有独立的开发者工具箱桥。现有实现是
// 单例 DevToolsBridge（browser 端点 + 单 targetId）。本 probe 直接验证底层前提：
//   1. 同一个 browser ws 端点是否支持两条独立连接（各自独立 session）
//   2. 两条连接能否同时 attach 到两个不同的 page target 并各自收发命令
//   3. 一条连接关闭是否影响另一条
//
// 若 (1) 不成立，P4 就只能改成「单 ws + 多 sessionId 复用」或回退方案 B。
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { wait, waitFor } = require('../lib/timeout.cjs');

function httpJson(port, path, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout ' + path)));
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const pending = new Map();
    let seq = 0;
    const events = [];
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const { resolve: done, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message)); else done(msg.result);
        return;
      }
      events.push(msg);
    });
    socket.once('open', () => resolve({
      socket,
      events,
      send(method, params = {}, sessionId) {
        const id = ++seq;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((done, fail) => {
          pending.set(id, { resolve: done, reject: fail });
          socket.send(JSON.stringify(payload));
          setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); fail(new Error('cdp timeout: ' + method)); }
          }, 5000);
        });
      },
      close() { try { socket.close(); } catch { /* ignore */ } },
    }));
    socket.once('error', reject);
  });
}

module.exports = {
  id: '42-cdp-dual-bridge',
  name: 'P4 dual CDP bridge feasibility',
  needsElectron: true,
  timeoutMs: 60_000,

  async run(ctx) {
    const { BrowserWindow, BrowserView, app } = ctx.electron;
    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    // 端口来自 DevToolsActivePort（host 已按主应用方式设 remote-debugging-port=0）
    const fs = require('fs');
    const path = require('path');
    const portFile = path.join(app.getPath('userData'), 'DevToolsActivePort');
    let port = null;
    try {
      await waitFor(async () => fs.existsSync(portFile), { timeoutMs: 10_000, label: 'DevToolsActivePort written' });
      port = Number.parseInt(fs.readFileSync(portFile, 'utf-8').split('\n')[0], 10);
    } catch (error) {
      return { ok: false, summary: 'DevToolsActivePort unavailable: ' + (error.message || error) };
    }
    check('debug port resolved', Number.isFinite(port) && port > 0, { port });

    const version = await httpJson(port, '/json/version').catch((e) => ({ error: String(e) }));
    const browserWs = version.webSocketDebuggerUrl;
    check('browser ws endpoint advertised', Boolean(browserWs), version);

    // 准备两个页面 target
    const winA = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const winB = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const viewA = new BrowserView({ webPreferences: { partition: 'persist:probe-dual', contextIsolation: true } });
    const viewB = new BrowserView({ webPreferences: { partition: 'persist:probe-dual', contextIsolation: true } });
    winA.addBrowserView(viewA);
    winB.addBrowserView(viewB);
    viewA.setBounds({ x: 0, y: 0, width: 600, height: 360 });
    viewB.setBounds({ x: 0, y: 0, width: 600, height: 360 });
    await Promise.all([
      viewA.webContents.loadURL('data:text/html,<html><body><h1 id="a">A</h1></body></html>').catch(() => {}),
      viewB.webContents.loadURL('data:text/html,<html><body><h1 id="b">B</h1></body></html>').catch(() => {}),
    ]);

    let conn1 = null; let conn2 = null;
    try {
      const targets = await httpJson(port, '/json/list');
      const pages = Array.isArray(targets) ? targets.filter((t) => t.type === 'page') : [];
      check('at least two page targets listed', pages.length >= 2, { pages: pages.length });

      // 选出两个不同的 page target（优先匹配我们刚建的两个 view）
      const wantedA = viewA.webContents.id;
      const wantedB = viewB.webContents.id;
      const pickA = pages.find((t) => String(t.title || '').includes('A')) || pages[0];
      const pickB = pages.find((t) => t.id !== pickA.id) || pages[1];
      check('two distinct targets', Boolean(pickA && pickB && pickA.id !== pickB.id),
        { pickA: pickA && pickA.id, pickB: pickB && pickB.id, wantedA, wantedB });

      // 两条独立的 browser ws 连接
      conn1 = await connect(browserWs);
      conn2 = await connect(browserWs);
      check('two independent browser ws connections open', true);

      // 各自 attach 到不同 target（flatten 模式）
      const attachA = await conn1.send('Target.attachToTarget', { targetId: pickA.id, flatten: true });
      const attachB = await conn2.send('Target.attachToTarget', { targetId: pickB.id, flatten: true });
      check('conn1 attached to target A', Boolean(attachA && attachA.sessionId), attachA);
      check('conn2 attached to target B', Boolean(attachB && attachB.sessionId), attachB);
      check('session ids are independent', attachA.sessionId !== attachB.sessionId,
        { a: attachA.sessionId, b: attachB.sessionId });

      // 并发收发：各自在自身 session 上执行 Runtime.evaluate
      const [resA, resB] = await Promise.all([
        conn1.send('Runtime.evaluate', { expression: 'document.querySelector("h1")?.id || "none"', returnByValue: true }, attachA.sessionId),
        conn2.send('Runtime.evaluate', { expression: 'document.querySelector("h1")?.id || "none"', returnByValue: true }, attachB.sessionId),
      ]);
      check('conn1 evaluates in its own target', resA && resA.result && resA.result.value === 'a', resA);
      check('conn2 evaluates in its own target', resB && resB.result && resB.result.value === 'b', resB);

      // 关闭一条连接，另一条仍可用
      conn1.close();
      await wait(300);
      let stillWorks = null;
      try {
        stillWorks = await conn2.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, attachB.sessionId);
      } catch (error) {
        stillWorks = { error: String(error.message || error) };
      }
      check('closing bridge 1 does not break bridge 2',
        Boolean(stillWorks && stillWorks.result && stillWorks.result.value === 2), stillWorks);

      return {
        ok: failures.length === 0,
        summary: failures.length === 0
          ? 'dual bridge viable: independent ws + sessions, isolated teardown'
          : `${failures.length} check(s) failed`,
        detail: {
          port,
          failures,
          browserWs: browserWs ? browserWs.replace(/\/devtools\/browser\/.*/, '/devtools/browser/…') : null,
          pageTargets: pages.map((t) => ({ id: t.id, title: t.title })),
          sessions: { a: attachA && attachA.sessionId, b: attachB && attachB.sessionId },
          evalA: resA && resA.result,
          evalB: resB && resB.result,
        },
      };
    } finally {
      if (conn1) conn1.close();
      if (conn2) conn2.close();
      for (const [w, v] of [[winA, viewA], [winB, viewB]]) {
        try { if (!w.isDestroyed()) w.removeBrowserView(v); } catch { /* ignore */ }
        try { if (!v.webContents.isDestroyed()) v.webContents.destroy(); } catch { /* ignore */ }
        try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
      }
    }
  },
};
