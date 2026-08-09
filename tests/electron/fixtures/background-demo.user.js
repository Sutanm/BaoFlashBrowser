// ==UserScript==
// @name         BaoFlash Background Demo
// @namespace    https://baoflash.local/background-demo
// @version      1.0.0
// @description  后台运行时冒烟:值写入/菜单命令/定时 tick
// @background
// @connect      127.0.0.1
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==
(function () {
  'use strict';
  var n = 0;
  GM_setValue('bg-running', 1);
  GM_registerMenuCommand('后台命令', function () { GM_setValue('bg-ran', 1); });
  setInterval(function () { n += 1; GM_setValue('bg-tick', n); }, 2000);
})();
