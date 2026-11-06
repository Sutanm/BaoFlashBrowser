#!/usr/bin/env node
/**
 * 复现「更多工具」子菜单一移动就消失，并量出父菜单/子菜单的矩形。
 *
 *   BFB_DOCK=right node tools/devtools-spike/devtools-menu-check.cjs
 *
 * 判据：
 * - 悬浮「更多工具」后应出现第 2 个 .soft-context-menu（子菜单）；
 * - 打印两者矩形，看子菜单是否被父菜单盖住 / 超出视口（超出就会被原生层裁剪，
 *   指针移过去等于离开视图，菜单按 mouseleave 收起）；
 * - 再把指针"移到子菜单"，看它是否还在。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT_FILE = path.join(process.env.APPDATA || '', 'bao-flash-browser', 'DevToolsActivePort');
const DOCK = process.env.BFB_DOCK || 'right';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('timeout')));
});

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const e = pending.get(msg.id); pending.delete(msg.id); e(msg); return; }
    for (const listener of listeners) listener(msg);
  });
  const ready = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    ready,
    onEvent(listener) { listeners.push(listener); },
    send(method, params = {}) {
      const i = ++id;
      socket.send(JSON.stringify({ id: i, method, params }));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ error: { message: 'timeout' } }); } }, 15000);
        pending.set(i, (m) => { clearTimeout(timer); resolve(m); });
      });
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function evaluate(client, expression, awaitPromise = true) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) return `EXC ${r.exceptionDetails.text}`;
  return r && r.result && r.result.result && r.result.result.value;
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(400);
  }
  console.log('[menu] 等待超时:', label);
  return null;
}

const HELPERS = `window.__bfbDeep = (sel) => {
  const acc = [];
  const visit = (root) => {
    root.querySelectorAll(sel).forEach((el) => acc.push(el));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
  };
  visit(document);
  return acc;
};`;

const OPEN_MENU = `(() => {
  __bfbDeep('button').length;
  const btn = __bfbDeep('button').find((b) => ((b.getAttribute('aria-label') || '') + (b.title || '')).indexOf('自定义和控制') !== -1);
  if (!btn) return 'no-button';
  btn.click();
  return 'opened';
})()`;

const HOVER_MORE = `(() => {
  const items = __bfbDeep('.soft-context-menu-item');
  const more = items.find((el) => (el.textContent || '').indexOf('更多工具') !== -1);
  if (!more) return 'no-item:' + items.length;
  ['mouseover', 'mousemove'].forEach((type) => more.dispatchEvent(new MouseEvent(type, { bubbles: true })));
  return 'hovered';
})()`;

const MEASURE = `(() => {
  const menus = __bfbDeep('.soft-context-menu').map((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: String(el.innerText || '').slice(0, 24).replace(/\\n/g, '/') };
  });
  return JSON.stringify({ count: menus.length, menus, view: { w: window.innerWidth, h: window.innerHeight } });
})()`;

const HOVER_SUBMENU = `(() => {
  const menus = __bfbDeep('.soft-context-menu');
  const sub = menus[menus.length - 1];
  if (!sub || menus.length < 2) return 'no-submenu';
  ['mouseover', 'mousemove'].forEach((type) => sub.dispatchEvent(new MouseEvent(type, { bubbles: true })));
  return 'moved';
})()`;

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(1000);

  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>menu</title><style>body{margin:0}</style></head><body><div>MENU</div></body></html>');
  });
  const fixturePort = await new Promise((resolve) => { fixture.listen(0, '127.0.0.1', () => resolve(fixture.address().port)); });

  const out = fs.openSync(path.join(os.tmpdir(), 'bfb-menu.log'), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.'], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });

  const startedAt = Date.now();
  const port = await waitUntil(async () => {
    try {
      if (fs.statSync(PORT_FILE).mtimeMs > startedAt) {
        const p = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).split('\n')[0]);
        if (p > 0 && await getJson(`http://127.0.0.1:${p}/json/version`).then(() => true).catch(() => false)) return p;
      }
    } catch { /* not yet */ }
    return null;
  }, 40000, 'debug port');
  if (!port) { fixture.close(); process.exit(2); }

  const shell = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /dist\/renderer\/index\.html$/.test(t.url || '')) || null;
  }, 30000, 'shell');
  if (!shell) { fixture.close(); process.exit(2); }
  const client = cdp(shell.webSocketDebuggerUrl);
  await client.ready;

  const navigate = (url) => evaluate(client, `(() => {
    const input = document.querySelector('.address-input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'submitted';
  })()`, false);

  for (let i = 0; i < 40; i += 1) {
    if (await navigate(`http://127.0.0.1:${fixturePort}/page`) === 'submitted') break;
    await sleep(500);
  }
  await sleep(2500);

  for (let i = 0; i < 40; i += 1) {
    const st = await evaluate(client, `(() => {
      const b = document.querySelector('[data-devtoolbox-toggle]');
      if (!b) return 'no-button';
      b.click(); return 'clicked';
    })()`, false).catch(() => 'no-button');
    if (st === 'clicked') break;
    await sleep(500);
  }
  await sleep(3500);

  // 把抽屉挪到目标停靠（默认右侧，和用户截图一致）
  const dockLabel = DOCK === 'right' ? '右侧' : DOCK === 'left' ? '左侧' : '底部';
  console.log('[menu] 停靠:', await evaluate(client, `(() => {
    const drawer = document.querySelector('[data-devtools-drawer]');
    const btn = [].slice.call(drawer.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').indexOf(${JSON.stringify(dockLabel)}) !== -1);
    if (!btn) return 'no-btn';
    btn.click(); return 'clicked';
  })()`, false));
  await sleep(1800);

  const front = await waitUntil(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    return (list || []).find((t) => /devtools_app\.html/.test(t.url || '')) || null;
  }, 30000, 'frontend');
  if (!front) { client.close(); fixture.close(); process.exit(2); }
  const fc = cdp(front.webSocketDebuggerUrl);
  await fc.ready;

  const logs = [];
  fc.onEvent((m) => {
    if (m.method !== 'Runtime.consoleAPICalled') return;
    const text = (m.params.args || []).map((a) => String(a.value === undefined ? a.description : a.value)).join(' ');
    logs.push(text);
  });
  await fc.send('Runtime.enable');
  await evaluate(fc, HELPERS, false);
  console.log('[menu] 打开 ⋮:', await evaluate(fc, OPEN_MENU, false));
  await sleep(600);
  console.log('[menu] 菜单状态:', await evaluate(fc, MEASURE, false));

  // 真实指针：用 Input.dispatchMouseEvent 走前端的 hover 逻辑（DOM dispatch 不会触发 mouseleave）
  const moveTo = async (x, y) => {
    await fc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0 });
  };
  const itemCenter = await evaluate(fc, `(() => {
    const items = __bfbDeep('.soft-context-menu-item');
    const more = items.find((el) => (el.textContent || '').indexOf('更多工具') !== -1);
    if (!more) return 'none';
    const r = more.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`, false);
  console.log('[menu] 「更多工具」中心:', itemCenter);
  const ic = JSON.parse(String(itemCenter));
  await moveTo(ic.x, ic.y);
  await sleep(400);
  console.log('[menu] 悬浮后（真实指针）:', await evaluate(fc, MEASURE, false));

  // 记录指针事件（capture，注意 shadow DOM 会 retarget 到 host）
  await evaluate(fc, `(() => {
    window.__bfbEvents = [];
    ['mouseover', 'mouseout', 'mouseleave', 'mouseenter'].forEach((type) => {
      document.addEventListener(type, (e) => {
        const name = (el) => el ? (String(el.className || '').split(' ')[0] || el.tagName || '') : 'null';
        window.__bfbEvents.push(type + '  target=' + name(e.target) + '  related=' + name(e.relatedTarget));
        if (window.__bfbEvents.length > 80) window.__bfbEvents.shift();
      }, true);
    });
    return 'recording';
  })()`, false);

  const subCenter = await evaluate(fc, `(() => {
    const menus = __bfbDeep('.soft-context-menu');
    if (menus.length < 2) return 'none';
    const r = menus[menus.length - 1].getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + 30 });
  })()`, false);
  console.log('[menu] 子菜单目标点:', subCenter);
  // 沿轨迹看“指针实际命中的是谁”（含 shadow DOM 下钻）
  const hitPath = await evaluate(fc, `(() => {
    const probe = (x, y) => {
      const list = document.elementsFromPoint(x, y).map((el) => {
        const cls = String(el.className || '').slice(0, 28);
        return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
      });
      return { x: Math.round(x), y: Math.round(y), top: list.slice(0, 3) };
    };
    return JSON.stringify([probe(433, 190), probe(343, 190), probe(313, 190), probe(256, 181)]);
  })()`, false);
  console.log('[menu] 轨迹命中:', hitPath);

  const ownership = await evaluate(fc, `(() => {
    const menus = __bfbDeep('.soft-context-menu');
    const info = (el, label) => {
      if (!el) return { label, missing: true };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const chain = [];
      let node = el;
      for (let i = 0; i < 5 && node; i += 1) {
        chain.push(node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).split(' ')[0] : ''));
        node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      }
      const hit = document.elementFromPoint(r.x + 8, r.y + 8);
      return {
        label,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        chain,
        hitAtCorner: hit ? hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : 'none',
        inShadow: Boolean(el.getRootNode() !== document),
      };
    };
    return JSON.stringify([info(menus[0], 'parent'), info(menus[1], 'sub')]);
  })()`, false);
  console.log('[menu] 归属/命中:', ownership);
  if (subCenter !== 'none') {
    const sc = JSON.parse(String(subCenter));
    // 模拟用户真实轨迹：从父项中点水平移到子菜单（中间经过两者交界）
    for (let step = 1; step <= 6; step += 1) {
      await moveTo(ic.x + (sc.x - ic.x) * step / 6, ic.y + (sc.y - ic.y) * step / 6);
      await sleep(60);
    }
    await sleep(300);
    console.log('[menu] 移到子菜单后:', await evaluate(fc, MEASURE, false));
    const events = await evaluate(fc, 'JSON.stringify(window.__bfbEvents || [])', false);
    console.log('[menu] 事件序列:');
    for (const line of JSON.parse(String(events)).slice(-18)) console.log('    ' + line);
  }

  console.log('[menu] BFB 标记:');
  for (const line of logs.filter((l) => l.indexOf('BFB-') === 0).slice(-6)) console.log('    ' + line.slice(0, 220));
  console.log('[menu] BFB 标记:');
  for (const line of logs.filter((l) => l.indexOf('BFB-') === 0).slice(-6)) console.log('    ' + line.slice(0, 220));
  fc.close();
  client.close();
  fixture.close();
  child.kill();
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('[menu] failed:', e && e.message); process.exit(1); });
