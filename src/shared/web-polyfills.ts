/**
 * 页面主世界 polyfill 的唯一来源（主进程与 preload 共用）。
 *
 * Chromium 87 缺现代 Web API。缺失的 API 会让整包站点脚本直接抛错中断
 * （GitHub 需要 `crypto.randomUUID` 与 `.at()`，否则 React 根本挂不上）。
 *
 * 2026-11-13 修复：这段负载原先由 `src/webview-preload/index.ts` 用
 * `webFrame.executeJavaScript` 注入，并自称 document-start。但该 API 的语义是
 *
 *   "Code execution will be suspended until web page stop loading."
 *   —— electron.d.ts, webFrame.executeJavaScript
 *
 * 即它一定要等页面加载完才执行，与"抢在页面脚本之前"的定位天然冲突；实测
 * 主世界的 `[].at` / `crypto.randomUUID` / `window.close` 全部保持原生状态，
 * 说明这段代码从未真正落到主世界。后果是百度这类站点的现代脚本在裸的
 * Chromium 87 上抛错，被风控判为环境异常（表现为验证码验证成功后仍循环）。
 *
 * 现在改为由主进程在 `dom-ready` 用 `webContents.executeJavaScript` 注入，
 * 该方法没有上述挂起语义（electron.d.ts:10417）。
 */
import coreApiPolyfills from './web-api-polyfills.generated';

export const HANDMADE_POLYFILLS = `(function () {
  try {
    if (window.crypto && !window.crypto.randomUUID) {
      window.crypto.randomUUID = function () {
        var b = window.crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); });
        return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
      };
    }
  } catch (e) { /* polyfill must never break the page */ }
})();
`;

/**
 * `window.close` 守卫：Electron 11 会把 BrowserView 页面的 `window.close()`
 * 路由到宿主 BrowserWindow（实测：页面一句 window.close() 就能关掉整个浏览器）。
 *
 * ⚠ 当前**未注入**。它是一个主世界的原生函数替换，`String(window.close)` 会
 * 立刻失去 `[native code]`，属于站点可自检的环境篡改特征。正确做法是在主进程
 * 拦窗口关闭事件，而不是改页面 JS —— 待办，不要为了"看起来能用"把它塞回去。
 */
export const PAGE_WORLD_CLOSE_GUARD = `(function () {
  try {
    if (window && typeof window.close === 'function') {
      window.close = function () { /* tabs must not close the browser window */ };
    }
  } catch (e) { /* guard must never break the page */ }
})();
`;

export type PolyfillMode = 'full' | 'handmade' | 'off';

/** 诊断开关：BAO_POLYFILL_MODE=handmade 只补 crypto.randomUUID；=off 完全不注入。 */
export function resolvePolyfillMode(raw?: string): PolyfillMode {
  const value = raw ?? (typeof process !== 'undefined' ? process.env?.BAO_POLYFILL_MODE : undefined);
  if (value === 'off') return 'off';
  if (value === 'handmade') return 'handmade';
  return 'full';
}

const scriptCache = new Map<PolyfillMode, string>();

/**
 * 生成注入脚本。返回 'applied' / 'already' / 'error:<message>'，主进程据此留日志 ——
 * 上一版正是静默失败，才让这个问题藏了这么久，不要再吞掉结果。
 */
export function buildPageWorldPolyfillScript(mode: PolyfillMode = resolvePolyfillMode()): string | null {
  if (mode === 'off') return null;
  const cached = scriptCache.get(mode);
  if (cached) return cached;
  const payload = mode === 'full' ? HANDMADE_POLYFILLS + coreApiPolyfills : HANDMADE_POLYFILLS;
  // 幂等标记用不可枚举属性：`Object.keys(window)` / `for...in` 看不到它，
  // 少给站点留一个"这个页面被注入过"的枚举痕迹。注意只在 payload 成功后落标，
  // 失败保持未标记，下次导航还会重试。
  const script = `(function(){try{if(window.__bfPagePolyfills)return 'already';${payload};Object.defineProperty(window,'__bfPagePolyfills',{value:1,configurable:true,enumerable:false});return 'applied';}catch(e){return 'error:'+(e&&e.message?e.message:String(e));}})();`;
  scriptCache.set(mode, script);
  return script;
}
