// ==UserScript==
// @name         BaoFlash 测试脚本
// @namespace    https://baoflash.local/demo
// @version      1.1.0
// @description  平台功能测试:可拖动/可收起/可关闭的右下角徽章(访问计数/URL/运行时长)、菜单命令、系统通知、页世界桥
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==
(function () {
  'use strict';
  var started = Date.now();
  var visits = Number(GM_getValue('visits', 0)) + 1;
  GM_setValue('visits', visits);
  GM_log('probe-log-marker', 'info');

  // 页世界桥:隔离世界写入,主世界可读(unsafeWindow 验证)
  try {
    unsafeWindow.__baoflashTest = { loaded: started, visits: visits };
  } catch (e) { /* 桥不可用 */ }

  GM_addStyle(
    '#baoflash-test-badge{position:fixed;right:12px;bottom:12px;z-index:2147483647;' +
    'font:12px/1.5 system-ui,sans-serif;background:rgba(16,20,36,.94);color:#7ee787;' +
    'padding:0;border-radius:10px;box-shadow:0 2px 14px rgba(0,0,0,.45);' +
    'border:1px solid rgba(126,231,135,.35);max-width:360px;pointer-events:auto;' +
    'user-select:none;-webkit-user-select:none;overflow:hidden;}' +
    '#baoflash-test-badge .bf-head{display:flex;align-items:center;gap:6px;' +
    'padding:5px 6px 5px 10px;cursor:move;background:rgba(255,255,255,.04);}' +
    '#baoflash-test-badge .bf-head b{font-weight:700;flex:1;white-space:nowrap;}' +
    '#baoflash-test-badge .bf-btn{border:1px solid rgba(126,231,135,.4);background:transparent;' +
    'color:#7ee787;border-radius:6px;font-size:12px;line-height:1;padding:3px 7px;cursor:pointer;}' +
    '#baoflash-test-badge .bf-btn:hover{background:rgba(126,231,135,.15);}' +
    '#baoflash-test-badge .bf-body{padding:6px 10px 8px;}' +
    '#baoflash-test-badge .bf-clock{font-weight:700;}' +
    '#baoflash-test-badge .bf-meta{opacity:.85;word-break:break-all;margin-top:2px;}' +
    '#baoflash-test-badge .bf-hint{opacity:.6;margin-top:4px;font-size:11px;}' +
    '#baoflash-test-badge.bf-collapsed{width:34px;height:34px;border-radius:50%;padding:0;' +
    'display:flex;align-items:center;justify-content:center;cursor:pointer;}' +
    '#baoflash-test-badge.bf-collapsed .bf-head,#baoflash-test-badge.bf-collapsed .bf-body{display:none;}'
  );

  var badge = document.createElement('div');
  badge.id = 'baoflash-test-badge';
  var head = document.createElement('div');
  head.className = 'bf-head';
  var title = document.createElement('b');
  title.textContent = 'BaoFlash';
  var collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'bf-btn';
  collapseBtn.textContent = '—';
  collapseBtn.title = '收起';
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'bf-btn';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭';
  head.appendChild(title);
  head.appendChild(collapseBtn);
  head.appendChild(closeBtn);

  var body = document.createElement('div');
  body.className = 'bf-body';
  var clock = document.createElement('div');
  clock.className = 'bf-clock';
  var meta = document.createElement('div');
  meta.className = 'bf-meta';
  var hint = document.createElement('div');
  hint.className = 'bf-hint';
  body.appendChild(clock);
  body.appendChild(meta);
  body.appendChild(hint);

  badge.appendChild(head);
  badge.appendChild(body);

  // 位置持久化:上次拖拽的位置跨页面/跨重启还原
  var savedPos = GM_getValue('badgePos', null);
  if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
    badge.style.left = savedPos.x + 'px';
    badge.style.top = savedPos.y + 'px';
    badge.style.right = 'auto';
    badge.style.bottom = 'auto';
  }

  // 拖拽(按住标题栏)
  var dragging = null;
  head.addEventListener('mousedown', function (event) {
    if (event.button !== 0) return;
    dragging = {
      dx: event.clientX - badge.getBoundingClientRect().left,
      dy: event.clientY - badge.getBoundingClientRect().top,
    };
    event.preventDefault();
  });
  document.addEventListener('mousemove', function (event) {
    if (!dragging) return;
    var x = event.clientX - dragging.dx;
    var y = event.clientY - dragging.dy;
    x = Math.max(0, Math.min(window.innerWidth - 60, x));
    y = Math.max(0, Math.min(window.innerHeight - 30, y));
    badge.style.left = x + 'px';
    badge.style.top = y + 'px';
    badge.style.right = 'auto';
    badge.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = null;
    var rect = badge.getBoundingClientRect();
    GM_setValue('badgePos', { x: Math.round(rect.left), y: Math.round(rect.top) });
  });

  // 收起/展开:折叠成小圆点,只保留一个指示
  collapseBtn.addEventListener('click', function () {
    if (badge.classList.contains('bf-collapsed')) {
      badge.classList.remove('bf-collapsed');
      collapseBtn.textContent = '—';
      collapseBtn.title = '收起';
    } else {
      badge.classList.add('bf-collapsed');
      collapseBtn.textContent = '+';
      collapseBtn.title = '展开';
    }
  });
  badge.addEventListener('click', function (event) {
    if (event.target !== badge) return;
    if (badge.classList.contains('bf-collapsed')) {
      badge.classList.remove('bf-collapsed');
      collapseBtn.textContent = '—';
      collapseBtn.title = '收起';
    }
  });

  // 关闭:本次页面彻底移除
  closeBtn.addEventListener('click', function () {
    badge.remove();
  });

  function tick() {
    var seconds = Math.floor((Date.now() - started) / 1000);
    var mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    var ss = String(seconds % 60).padStart(2, '0');
    clock.textContent = 'Userscript OK · ' + mm + ':' + ss;
    meta.textContent = '访问计数(持久化):' + visits + ' · ' + location.href;
    var bridge = '桥: ' + (unsafeWindow.__baoflashTest ? 'OK' : '不可用');
    hint.textContent = '拖动移动 · 菜单: 重置计数 / 发通知 · ' + bridge;
  }
  tick();
  window.setInterval(tick, 1000);

  function attach() {
    if (document.body && !document.body.contains(badge)) document.body.appendChild(badge);
  }
  attach();
  document.addEventListener('DOMContentLoaded', attach);

  GM_registerMenuCommand('重置访问计数', function () {
    GM_setValue('visits', 0);
    visits = 0;
    meta.textContent = '访问计数(持久化):0 · ' + location.href;
  });

  GM_registerMenuCommand('发送测试通知', function () {
    GM_notification({
      title: 'BaoFlash 测试通知',
      text: '来自「' + (GM_info && GM_info.script ? GM_info.script.name : 'BaoFlash 测试脚本') + '」,点击回调应触发。',
      onclick: function () {
        try { unsafeWindow.__baoflashTest = { notified: Date.now() }; } catch (e) { /* ignore */ }
      }
    });
  });
})();
