import log from 'electron-log';
import type { DevToolPageProbe } from '@shared/types/devtoolbox';
import { clip } from './devtoolbox-buffer';
import { probeFramesDeep, type DeepProbe } from './devtoolbox-probe';
import { resolveDebugPort } from './devtoolbox-targets';
import { pickTargetForTab } from './devtoolbox-target-resolve';
import { getTabManagerForWindow, tabManager } from './tabs';

function managerFor(winId?: number | null) {
  return winId === undefined || winId === null ? tabManager : (getTabManagerForWindow(winId) ?? tabManager);
}

const PROBE_SCRIPT = `(function () {
  function abs(value, base) {
    try { return new URL(value, base || location.href).href; } catch (e) { return String(value || ''); }
  }
  function isSwf(url) {
    var text = String(url || '').toLowerCase();
    var at = text.indexOf('.swf');
    if (at < 0) return false;
    var next = text.charAt(at + 4);
    return next === '' || next === '?' || next === '#';
  }
  function isFlashType(node) {
    var t = String(node.getAttribute('type') || '').toLowerCase();
    return t.indexOf('shockwave-flash') !== -1 || t.indexOf('shockwave') !== -1;
  }
  var found = [];
  var seen = Object.create(null);
  var flashPlugins = 0;
  var sameOriginFrames = 0;
  // 尺寸归一：0×0 的加载器插件不该在 UI 里显示成 NaN×NaN
  function dim(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? Math.round(n) : undefined;
  }
  function push(url, kind, base, width, height) {
    var full = abs(url, base);
    if (!full || !isSwf(full)) return;
    var key = kind + '|' + full;
    if (seen[key]) return;
    seen[key] = true;
    found.push({ url: full, kind: kind, width: width, height: height });
  }
  // 递归扫同源 frame：很多站把游戏塞在同源 iframe 里，只扫顶层会漏。
  // 跨域 frame 的 document 访问会抛异常，只能跳过（Electron 11 没有 mainFrame API）。
  function scan(doc, depth) {
    if (!doc) return;
    var base = doc.baseURI || location.href;
    var nodes;
    try { nodes = doc.querySelectorAll('embed, object, param'); } catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var tag = node.tagName.toLowerCase();
      if (tag === 'param') {
        if ((node.getAttribute('name') || '').toLowerCase() === 'movie') {
          push(node.value || node.getAttribute('value'), 'param', base);
        }
        continue;
      }
      if (isFlashType(node)) flashPlugins += 1;
      var box = [dim(node.clientWidth) || dim(node.width), dim(node.clientHeight) || dim(node.height)];
      push(node.getAttribute('src'), tag, base, box[0], box[1]);
      push(node.getAttribute('data'), tag, base, box[0], box[1]);
    }
    try {
      var win = doc.defaultView;
      var list = win && win.performance ? win.performance.getEntriesByType('resource') : [];
      for (var j = 0; j < list.length; j++) push(list[j].name, 'resource', base);
    } catch (e) { /* performance unavailable */ }
    if (depth <= 0) return;
    var frames;
    try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
    for (var k = 0; k < frames.length; k++) {
      try {
        var sub = frames[k].contentDocument;
        if (sub) { sameOriginFrames += 1; scan(sub, depth - 1); }
      } catch (e) { /* 跨域，跳过 */ }
    }
  }
  scan(document, 2);
  // 主文档探测不到跨域 iframe 内部：把 iframe 的地址与是否同源暴露出来，
  // 避免"未检测到 SWF"被误读成"这页没有 Flash"。
  var frameList = [];
  var frameNodes = document.querySelectorAll('iframe, frame');
  for (var k2 = 0; k2 < frameNodes.length; k2++) {
    var frameNode = frameNodes[k2];
    var frameUrl = frameNode.getAttribute('src') || '';
    var sameOrigin = false;
    try { sameOrigin = !!frameNode.contentWindow && !!frameNode.contentDocument; } catch (e) { sameOrigin = false; }
    frameList.push({ url: abs(frameUrl), sameOrigin: sameOrigin });
  }
  var frames = 1;
  try { frames = window.frames.length + 1; } catch (e) { frames = 1; }
  return {
    swf: found,
    frames: frameList,
    flashPlugins: flashPlugins,
    sameOriginFrames: sameOriginFrames,
    ua: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    frameCount: frames
  };
})()`;

/**
 * 浅探（主文档 + 同源 iframe）与 CDP 深探（跨域 / OOPIF / 无 JS 上下文）合并。
 * 深探为 null 时原样返回浅探——深探只是增强，不能让探测退化成"必须能连 CDP"。
 */
function mergeProbe(base: DevToolPageProbe | null, deep: DeepProbe | null, ua: string): DevToolPageProbe | null {
  if (!deep) return base;
  const swf = [...(base?.swf ?? [])];
  const seen = new Set(swf.map((item) => `${item.kind}|${item.url}`));
  for (const item of deep.swf) {
    const key = `${item.kind}|${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    swf.push({ url: item.url, kind: item.kind, width: item.width, height: item.height });
  }
  // frame 列表以深探为准：它给的是真实 frame 树，带 depth 与「有没有真跑过探测」。
  // 深探没结果时退回浅探（同源 iframe 的 src 列表）。
  const frames = deep.frames.length
    ? deep.frames
    : (base?.frames ?? []).map((frame) => ({
      url: frame.url,
      sameOrigin: frame.sameOrigin,
      depth: 1,
      readable: frame.sameOrigin,
    }));
  return {
    swf,
    frames,
    flashPlugins: Math.max(base?.flashPlugins ?? 0, deep.plugins),
    sameOriginFrames: frames.filter((frame) => frame.sameOrigin).length,
    deep: true,
    ua: base?.ua || ua,
    viewport: base?.viewport ?? { width: 0, height: 0 },
    frameCount: frames.length || base?.frameCount || 1,
  };
}

/**
 * 探测某个标签页的 Flash 情况。
 *
 * **必须由渲染层传 tabId**：切标签是渲染层先变、主进程后跟上的，这里读
 * `tabManager.getActiveId()` 会在这段窗口里探到上一个标签——表现是切到新标签后
 * 工具箱 Flash 页显示的还是上一页的数据，得重新按一次 F12 才更正。这与
 * `devtoolsUrl` / `bridge.attach` 是同一类错误（见 §9.4）。
 */
export async function probeActivePage(tabId?: string | null, winId?: number | null): Promise<DevToolPageProbe | null> {
  const manager = managerFor(winId);
  const resolvedId = tabId ?? manager.getActiveId();
  const wc = resolvedId ? manager.getWebContents(resolvedId) : null;
  if (!wc || wc.isDestroyed()) return null;

  let base: DevToolPageProbe | null = null;
  try {
    const raw = await wc.executeJavaScript(PROBE_SCRIPT, false);
    if (raw && typeof raw === 'object') base = raw as DevToolPageProbe;
  } catch (error) {
    log.debug('[DevToolbox] page probe failed:', error instanceof Error ? error.message : String(error));
  }

  // 什么时候值得上 CDP 深探：主文档没扫到 SWF，或者存在读不到的跨域 frame。
  // 两个条件都不成立时走快路径（4399 这种顶层 object 的页面完全不需要连 CDP）。
  const needsDeep = !base || (base.swf?.length ?? 0) === 0 || (base.frames ?? []).some((frame) => !frame.sameOrigin);
  let deep: DeepProbe | null = null;
  if (needsDeep && resolvedId) {
    const port = resolveDebugPort();
    if (port) {
      const targetId = await pickTargetForTab(resolvedId, port, winId).catch(() => null);
      if (targetId) {
        deep = await probeFramesDeep(`ws://127.0.0.1:${port}/devtools/page/${targetId}`).catch(() => null);
      }
    }
  }

  const probe = mergeProbe(base, deep, (() => { try { return wc.getUserAgent(); } catch { return ''; } })());
  if (!probe) return null;
  log.debug('[DevToolbox] probe tab=%s url=%s swf=%d frames=%d deep=%s%s',
    resolvedId?.slice(-6), clip(wc.getURL(), 40), probe.swf?.length ?? 0, probe.frameCount ?? 0,
    probe.deep ? 'yes' : 'no',
    deep ? ` via=${JSON.stringify(deep.via)} ${deep.elapsedMs}ms` : '');
  return probe;
}
