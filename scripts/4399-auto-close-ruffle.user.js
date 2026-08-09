// ==UserScript==
// @name         4399 Ruffle 自动关闭 Flash 兼容提示
// @namespace    bao-flash-browser
// @version      1.0.0
// @description  在 Ruffle 模式下自动关闭 4399 的"当前浏览器不支持"Flash 兼容提示框，
//              还原出被 blockflashtip iframe 覆盖的真实 Flash 游戏画面。仅 Ruffle 生效，
//              原生 Flash (ppapi) 时不做任何事。
// @match        *://*.4399.com/flash/*
// @match        *://www.4399.com/flash/*
// @run-at       document-start
// @grant        GM_info
// ==/UserScript==
(function () {
  'use strict';

  // 仅在 Ruffle 模式下启用；原生 Flash (ppapi) 不需要，也避免干扰。
  // GM_info.flashRuntime 为 'ppapi' | 'ruffle'。
  if (!GM_info || GM_info.flashRuntime !== 'ruffle') return;

  // 4399 检测到 Flash 不可用时，把 #swfdiv 的内容替换成一个
  // <iframe src="/loadimg/blockflashtip.html">（"block flash tip" 兼容提示）。
  // 关闭按钮在 iframe 内点击 window.top.closeBlockFlash()，其实现是：
  //   document.getElementById("swfdiv").innerHTML = old_swfdiv_html;
  // （old_swfdiv_html 是保存的真实 Flash 嵌入代码）。
  // 我们直接在主页面监测 swfdiv 的替换，一旦发现 blockflashtip iframe 就调用
  // 同一个 closeBlockFlash() 还原 Flash，等效于自动点击关闭按钮。
  const isBlockTipFrame = (el) => {
    if (!el || el.tagName !== 'IFRAME') return false;
    const src = (el.getAttribute('src') || '').toLowerCase();
    return src.includes('blockflashtip');
  };

  const closeIfBlocked = () => {
    const swf = document.getElementById('swfdiv');
    if (!swf) return;
    const tipFrame = Array.prototype.find.call(swf.querySelectorAll('iframe'), isBlockTipFrame);
    if (tipFrame && typeof window.closeBlockFlash === 'function') {
      try {
        window.closeBlockFlash();
      } catch (e) {
        // closeBlockFlash 若抛错，退回点击 iframe 内的关闭链接（若存在）。
        const closeLink = tipFrame.contentDocument && tipFrame.contentDocument.getElementById('close_block');
        if (closeLink) {
          const a = closeLink.querySelector('a');
          if (a && a.onclick) a.onclick.call(a);
        }
      }
    }
  };

  // 页面结构可能是静态替换或 JS 动态替换，观察 swfdiv 子树。
  const swf = document.getElementById('swfdiv');
  if (swf) {
    closeIfBlocked();
    if (typeof MutationObserver === 'function') {
      const obs = new MutationObserver(() => closeIfBlocked());
      obs.observe(swf, { childList: true, subtree: true });
    }
  }

  // swfdiv 可能较晚才被脚本插入，document-start 时可能尚未存在；用一次性的
  // 轮询兜底，直到出现后建立观察。
  let attempts = 0;
  const poll = setInterval(() => {
    const s = document.getElementById('swfdiv');
    if (s) {
      closeIfBlocked();
      if (typeof MutationObserver === 'function') {
        new MutationObserver(() => closeIfBlocked()).observe(s, { childList: true, subtree: true });
      }
      clearInterval(poll);
      return;
    }
    if (++attempts > 40) clearInterval(poll); // ~8 秒后放弃
  }, 200);
})();
