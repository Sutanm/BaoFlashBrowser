// ==UserScript==
// @name         BaoFlash 页面悬浮相框助手
// @namespace    bao-flash-browser
// @author       Sutanm
// @homepageURL  https://github.com/Sutanm/BaoFlashBrowser
// @bao-origin   bfb:833eaf0307cffe0c
// @version      3.3.4
// @updateHash  f43211a985d9
// @description  Automation 2.0 页面助手：运行、识别、取材、Surface 与 CoordinateLocator。
// @match        http://*/*
// @match        https://*/*
// @match        file:///*
// @run-at       document-end
// @noframes
// @grant        GM_baoAutomation
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/* global GM, window, document, innerWidth, innerHeight, setInterval, clearInterval, setTimeout */

(function () {
  'use strict';
  if (!GM || !GM.baoAutomation || document.getElementById('bao-automation-frame-assistant')) return;

  var api = GM.baoAutomation;
  var state = {
    packages: [], busy: false, monitor: 0, statusTimer: 0, lastState: '', statusInitialized: false, matchMode: 'image',
    capture: null, selection: null, gameSurface: null, surfaceViewport: null, surfaceRefreshTimer: 0, coordinateViewport: { width: 1280, height: 720 }, captureIndex: Number(GM.getValue('captureIndex', 1)) || 1,
  };
  var style = document.createElement('style');
  style.id = 'bao-automation-assistant-style';
  style.textContent = `
#bao-automation-frame-assistant{all:initial;position:fixed;z-index:2147483645;left:12px;top:72px;width:46px;height:46px;color:#eef5ff;font:11px/1.35 Inter,"Microsoft YaHei",system-ui,sans-serif;transition:width .22s cubic-bezier(.2,.8,.2,1),height .22s cubic-bezier(.2,.8,.2,1);color-scheme:dark;touch-action:none}
#bao-automation-frame-assistant *{box-sizing:border-box}
#bao-automation-frame-assistant.bao-open{width:320px;height:min(450px,calc(100vh - 16px))}
#bao-automation-frame-assistant.bao-open[data-view="match"]{height:min(500px,calc(100vh - 16px))}
#bao-automation-frame-assistant.bao-open[data-view="capture"]{height:min(220px,calc(100vh - 16px))}
#bao-automation-frame-assistant.bao-right{left:auto}
#bao-automation-frame-assistant button,#bao-automation-frame-assistant select,#bao-automation-frame-assistant input{font:inherit}
#bao-automation-frame-assistant button:focus{outline:none}
#bao-automation-frame-assistant select:focus,#bao-automation-frame-assistant input:focus{outline:1px solid #77b3ff;outline-offset:1px}
#bao-automation-frame-assistant .bao-orb{position:absolute;z-index:3;left:0;top:0;display:grid;width:46px;height:46px;place-items:center;border:1px solid #9ec9ff66;border-radius:50%;background:radial-gradient(circle at 36% 28%,#72b4ff,#2c5cae 58%,#15294d);box-shadow:0 6px 22px #0008,0 0 0 3px #80b8ff19;color:#fff;cursor:grab;transition:transform .2s,box-shadow .2s}
#bao-automation-frame-assistant.bao-right .bao-orb{left:auto;right:0}
#bao-automation-frame-assistant .bao-orb:hover{transform:scale(1.06);box-shadow:0 10px 36px #0009,0 0 0 7px #80b8ff24}
#bao-automation-frame-assistant .bao-orb:active{cursor:grabbing}
#bao-automation-frame-assistant .bao-orb-icon{font-size:19px;line-height:1}
#bao-automation-frame-assistant .bao-ring{position:absolute;inset:-3px;border:2px solid transparent;border-radius:50%;opacity:0}
#bao-automation-frame-assistant.bao-running .bao-ring{border-top-color:#7bb8ff;border-right-color:#7bb8ff;opacity:1;animation:bao-spin 1s linear infinite}
#bao-automation-frame-assistant.bao-success .bao-ring{border-color:#45d18a;opacity:1}
#bao-automation-frame-assistant.bao-failed .bao-ring{border-color:#ff6b72;opacity:1}
@keyframes bao-spin{to{transform:rotate(360deg)}}
#bao-automation-frame-assistant .bao-drawer{position:absolute;left:0;top:0;width:320px;height:100%;overflow:hidden;border:1px solid #9bc1ef42;border-radius:0 16px 16px 0;background:linear-gradient(145deg,#192841ed,#0d182be6);box-shadow:0 18px 50px #0009,inset 0 1px #ffffff16;backdrop-filter:blur(10px) saturate(1.1);transform:translateX(calc(-100% - 20px));opacity:0;pointer-events:none;transition:transform .24s cubic-bezier(.2,.8,.2,1),opacity .18s}
#bao-automation-frame-assistant.bao-open .bao-drawer{transform:none;opacity:1;pointer-events:auto}
#bao-automation-frame-assistant.bao-right .bao-drawer{left:auto;right:0;border-radius:16px 0 0 16px;transform:translateX(calc(100% + 20px))}
#bao-automation-frame-assistant.bao-right.bao-open .bao-drawer{transform:none}
#bao-automation-frame-assistant .bao-handle{position:absolute;z-index:-1;right:-12px;top:14px;width:25px;height:60px;border:1px solid #9cc4ec33;border-left:0;border-radius:0 22px 22px 0;background:#122137e8;box-shadow:8px 6px 22px #0005}
#bao-automation-frame-assistant.bao-right .bao-handle{left:-12px;right:auto;transform:scaleX(-1)}
#bao-automation-frame-assistant .bao-head{display:flex;height:48px;align-items:center;gap:6px;padding:0 9px 0 50px;border-bottom:1px solid #9cbbee2b}
#bao-automation-frame-assistant.bao-right .bao-head{padding:0 50px 0 9px}
#bao-automation-frame-assistant .bao-title{min-width:0;flex:1}#bao-automation-frame-assistant .bao-title strong{display:block;font-size:12px}
#bao-automation-frame-assistant .bao-icon{display:grid;width:26px;height:26px;place-items:center;border:1px solid transparent;border-radius:7px;background:transparent;color:#afc1d8;cursor:pointer}#bao-automation-frame-assistant .bao-icon:hover{border-color:#9cbbee2b;background:#ffffff0d;color:white}
#bao-automation-frame-assistant .bao-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:6px 8px 0}#bao-automation-frame-assistant .bao-tab{padding:6px 4px;border:0;border-radius:7px;background:transparent;color:#8fa3ba;cursor:pointer}#bao-automation-frame-assistant .bao-tab.bao-active{background:#6c9eff1c;color:#c6dcff;box-shadow:inset 0 0 0 1px #77aaff30}
#bao-automation-frame-assistant .bao-views{height:calc(100% - 82px);overflow:hidden;padding:8px}#bao-automation-frame-assistant .bao-view{display:none}#bao-automation-frame-assistant .bao-view.bao-active{display:block}@media (max-height:440px){#bao-automation-frame-assistant .bao-views{overflow-y:auto}}
#bao-automation-frame-assistant .bao-card{margin-bottom:7px;padding:9px;border:1px solid #9cbbee2b;border-radius:9px;background:#07132252}#bao-automation-frame-assistant .bao-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}#bao-automation-frame-assistant .bao-card-head strong{font-size:11px}#bao-automation-frame-assistant .bao-card-head small{color:#9cafc7;font-size:9px}
#bao-automation-frame-assistant .bao-field{display:grid;gap:4px;margin-bottom:7px}#bao-automation-frame-assistant .bao-field label{color:#9eb0c5;font-size:9px}#bao-automation-frame-assistant select,#bao-automation-frame-assistant input[type=text],#bao-automation-frame-assistant input[type=number]{width:100%;height:29px;padding:0 8px;border:1px solid #95bce526;border-radius:7px;background:#071524d9;color:#e9f2ff}
#bao-automation-frame-assistant input[type=range]{width:100%;accent-color:#5998ff}
#bao-automation-frame-assistant .bao-two{display:grid;grid-template-columns:1fr 1fr;gap:6px}#bao-automation-frame-assistant .bao-button{height:30px;padding:0 9px;border:1px solid #8eb8e22b;border-radius:7px;background:#10223a;color:#c8d7ea;cursor:pointer}#bao-automation-frame-assistant .bao-button:hover{background:#183254}#bao-automation-frame-assistant .bao-button.bao-primary{border-color:#699fff;background:linear-gradient(#4b8bff,#3971db);color:#fff;box-shadow:0 4px 14px #397ce933}#bao-automation-frame-assistant .bao-button.bao-danger{color:#ffabb0}#bao-automation-frame-assistant .bao-button:disabled{opacity:.45;cursor:not-allowed}
#bao-automation-frame-assistant .bao-game-actions{display:grid;grid-template-columns:1fr;gap:6px;margin-top:7px}#bao-automation-frame-assistant .bao-game-actions.bao-bound{grid-template-columns:minmax(0,1fr) 82px 62px}#bao-automation-frame-assistant .bao-game-copy,#bao-automation-frame-assistant .bao-game-clear{display:none}#bao-automation-frame-assistant .bao-game-actions.bao-bound .bao-game-copy,#bao-automation-frame-assistant .bao-game-actions.bao-bound .bao-game-clear{display:block}
#bao-automation-frame-assistant .bao-run-state{display:flex;align-items:center;gap:11px}#bao-automation-frame-assistant .bao-run-dot{width:11px;height:11px;border-radius:50%;background:#6d7f94;box-shadow:0 0 0 5px #6d7f9422}#bao-automation-frame-assistant .bao-run-state.bao-live .bao-run-dot{background:#6ea8ff;box-shadow:0 0 0 5px #6ea8ff20;animation:bao-pulse 1s ease-in-out infinite}@keyframes bao-pulse{50%{transform:scale(.72);opacity:.6}}
#bao-automation-frame-assistant .bao-run-copy{min-width:0;flex:1}#bao-automation-frame-assistant .bao-run-copy b{display:block}#bao-automation-frame-assistant .bao-run-copy span{display:block;overflow:hidden;margin-top:3px;color:#9cafc7;font-size:10px;text-overflow:ellipsis;white-space:nowrap}#bao-automation-frame-assistant .bao-run-state.bao-live .bao-state-title,#bao-automation-frame-assistant .bao-run-state.bao-live .bao-state-detail{color:#76dba8}#bao-automation-frame-assistant .bao-step{color:#9cafc7;font-size:10px}
#bao-automation-frame-assistant .bao-progress{height:4px;margin-top:8px;overflow:hidden;border-radius:99px;background:#ffffff10}#bao-automation-frame-assistant .bao-progress i{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#4489ff,#69d8e8);transition:width .35s}
#bao-automation-frame-assistant .bao-log{display:grid;max-height:145px;gap:5px;overflow-y:auto;padding-right:3px}#bao-automation-frame-assistant .bao-log::-webkit-scrollbar{width:5px}#bao-automation-frame-assistant .bao-log::-webkit-scrollbar-thumb{border-radius:5px;background:#7691b052}#bao-automation-frame-assistant .bao-log-row{display:grid;grid-template-columns:43px 1fr;gap:6px;color:#9fb0c3;font-size:9px}#bao-automation-frame-assistant .bao-log-row time{color:#668098}#bao-automation-frame-assistant .bao-log-row span{overflow-wrap:anywhere}#bao-automation-frame-assistant .bao-log-row.bao-good span{color:#76dba8}#bao-automation-frame-assistant .bao-log-row.bao-bad span{color:#ff858c}
#bao-automation-frame-assistant .bao-assets{display:flex;gap:5px;overflow:auto;padding:1px 1px 5px}#bao-automation-frame-assistant .bao-asset{position:relative;display:grid;flex:0 0 64px;height:56px;place-items:center;overflow:hidden;border:1px solid #91b9df24;border-radius:7px;background:#071320;color:#a9bbcf;cursor:pointer}#bao-automation-frame-assistant .bao-asset.bao-selected{border-color:#73aaff;box-shadow:0 0 0 2px #73aaff22}#bao-automation-frame-assistant .bao-asset img{max-width:44px;max-height:34px;object-fit:contain}#bao-automation-frame-assistant .bao-asset span{position:absolute;right:2px;bottom:1px;left:2px;overflow:hidden;font-size:8px;text-align:center;text-overflow:ellipsis;white-space:nowrap}
#bao-automation-frame-assistant .bao-match-modes{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:7px}#bao-automation-frame-assistant .bao-match-mode{height:27px;border:1px solid #8eb8e22b;border-radius:7px;background:#10223a;color:#9fb2c9;cursor:pointer}#bao-automation-frame-assistant .bao-match-mode.bao-active{border-color:#699fff;background:#356dc4;color:#fff}#bao-automation-frame-assistant .bao-test-settings.bao-hidden{display:none}#bao-automation-frame-assistant .bao-ocr-row{display:grid;grid-template-columns:1fr 88px;gap:6px}
#bao-automation-frame-assistant .bao-preview{display:grid;min-height:105px;place-items:center;overflow:auto;border:3px solid #6e5138;border-radius:6px;background:#07101d;box-shadow:inset 0 0 0 1px #be946b}#bao-automation-frame-assistant .bao-image{position:relative;max-width:100%}#bao-automation-frame-assistant .bao-image img{display:block;width:100%;max-height:210px;object-fit:contain}#bao-automation-frame-assistant .bao-hit{position:absolute;border:2px solid #ffca28;background:#ffca2826;box-shadow:0 0 8px #ffca28;pointer-events:none}#bao-automation-frame-assistant .bao-hit.bao-ok{border-color:#31d17c;background:#31d17c26;box-shadow:0 0 8px #31d17c}#bao-automation-frame-assistant .bao-hit b{position:absolute;left:-2px;bottom:calc(100% + 2px);padding:1px 3px;background:#ffca28;color:#172033;font-size:9px;white-space:nowrap}#bao-automation-frame-assistant .bao-hit.bao-ok b{background:#31d17c}
#bao-automation-frame-assistant .bao-result{margin:8px 0 0;color:#9fb1c7;font-size:10px}#bao-automation-frame-assistant .bao-score{color:#72dba5;font-size:25px;font-weight:700}#bao-automation-frame-assistant .bao-tip{padding:10px;border-radius:9px;background:#4b79d414;color:#b6c9e1;font-size:10px;line-height:1.6}
#bao-automation-assistant-toasts{all:initial;position:fixed;z-index:2147483647;top:18px;left:50%;display:grid;gap:8px;transform:translateX(-50%);pointer-events:none;font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif}#bao-automation-assistant-toasts .bao-toast{min-width:280px;padding:11px 15px;border:1px solid #9ec5ed38;border-radius:10px;background:#102039ee;box-shadow:0 12px 40px #0008;color:#dbeaff;animation:bao-toast-in .25s both}@keyframes bao-toast-in{from{transform:translateY(-12px);opacity:0}}
#bao-automation-capture-layer{all:initial;position:fixed;z-index:2147483646;inset:0;display:none;overflow:hidden;background:#020914ed;color:#eef5ff;font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif;cursor:crosshair}#bao-automation-capture-layer.bao-active{display:block}#bao-automation-capture-layer *{box-sizing:border-box}#bao-automation-capture-layer .bao-capture-image{position:absolute;max-width:100vw;max-height:100vh;object-fit:contain;left:50%;top:50%;transform:translate(-50%,-50%)}#bao-automation-capture-layer .bao-capture-help{position:absolute;z-index:4;top:64px;left:50%;display:flex;align-items:center;gap:10px;padding:7px 8px 7px 16px;transform:translateX(-50%);border:1px solid #b3d2f055;border-radius:999px;background:#10223ef2;box-shadow:0 10px 40px #0008;white-space:nowrap}#bao-automation-capture-layer .bao-capture-cancel{height:28px;padding:0 11px;border-color:#ff9b9b55;background:#5f2637;color:#ffdce2;cursor:pointer}#bao-automation-capture-layer .bao-selection{position:absolute;z-index:2;display:none;border:2px solid #78b5ff;background:#64a4ff16;box-shadow:0 0 0 9999px #02091399}#bao-automation-capture-layer .bao-selection-info{position:absolute;left:-2px;bottom:calc(100% + 7px);padding:4px 7px;border-radius:5px;background:#3779cf;color:white;font-size:10px;white-space:nowrap}
#bao-automation-capture-layer .bao-save{position:absolute;z-index:3;display:none;width:292px;gap:8px;padding:10px;border:1px solid #9ec6ee44;border-radius:12px;background:#0f2038f5;box-shadow:0 15px 45px #000b;cursor:default}#bao-automation-capture-layer .bao-save label{display:grid;gap:5px;color:#a9bbd0;font-size:10px}#bao-automation-capture-layer .bao-save input{width:100%;height:34px;padding:0 10px;border:1px solid #90b9e23d;border-radius:8px;background:#061321;color:#eff6ff}#bao-automation-capture-layer .bao-save small{color:#7890aa;font-size:9px}#bao-automation-capture-layer .bao-save-buttons,#bao-automation-capture-layer .bao-conflict-buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px}#bao-automation-capture-layer button{height:34px;border:1px solid #8eb8e22b;border-radius:8px;background:#142843;color:#dce9f8;cursor:pointer}#bao-automation-capture-layer button.bao-primary{background:#397cec;color:#fff}#bao-automation-capture-layer .bao-conflict{display:none;gap:7px;padding:8px;border:1px solid #ffb15b3b;border-radius:8px;background:#9a5b191f;color:#ffd2a0;font-size:10px}#bao-automation-capture-layer .bao-conflict.bao-show{display:grid}
#bao-automation-coordinate-layer{all:initial;position:fixed;z-index:2147483646;inset:0;display:none;overflow:hidden;cursor:crosshair;background-image:linear-gradient(#77b3ff24 1px,transparent 1px),linear-gradient(90deg,#77b3ff24 1px,transparent 1px);background-size:10% 10%;box-shadow:inset 0 0 0 1px #77b3ff88;font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif;color:#fff;user-select:none}#bao-automation-coordinate-layer.bao-active{display:block}#bao-automation-coordinate-layer .bao-coordinate-help{position:absolute;z-index:3;top:18px;left:50%;padding:9px 15px;transform:translateX(-50%);border:1px solid #b3d2f055;border-radius:999px;background:#10223ef2;box-shadow:0 10px 40px #0008;white-space:nowrap;pointer-events:none}#bao-automation-coordinate-layer .bao-coordinate-x,#bao-automation-coordinate-layer .bao-coordinate-y{position:absolute;z-index:1;background:#65b5ffcc;pointer-events:none}#bao-automation-coordinate-layer .bao-coordinate-x{top:0;bottom:0;width:1px}#bao-automation-coordinate-layer .bao-coordinate-y{right:0;left:0;height:1px}#bao-automation-coordinate-layer .bao-coordinate-value{position:absolute;z-index:2;padding:5px 8px;border:1px solid #80c2ff88;border-radius:6px;background:#0b2139ee;box-shadow:0 6px 20px #0008;color:#eaf6ff;font-weight:700;white-space:nowrap;pointer-events:none}
#bao-automation-coordinate-layer .bao-coordinate-surface{position:absolute;display:none;border:2px solid #55e49b;box-shadow:inset 0 0 0 1px #082b20,0 0 18px #32d98c66;pointer-events:none}#bao-automation-coordinate-layer.bao-surface .bao-coordinate-surface{display:block}
#bao-automation-game-layer{all:initial;position:fixed;z-index:2147483646;inset:0;display:none;background:#02091466;color:#fff;font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif}#bao-automation-game-layer.bao-active{display:block}#bao-automation-game-layer *{box-sizing:border-box}#bao-automation-game-layer .bao-game-help{position:absolute;z-index:3;top:18px;left:50%;display:flex;align-items:center;gap:10px;padding:7px 8px 7px 16px;transform:translateX(-50%);border:1px solid #b3d2f055;border-radius:999px;background:#10223ef2;box-shadow:0 10px 40px #0008;white-space:nowrap}#bao-automation-game-layer .bao-game-cancel{height:28px;padding:0 11px;border:1px solid #ff9b9b55;border-radius:7px;background:#5f2637;color:#ffdce2;cursor:pointer}#bao-automation-game-layer .bao-game-candidate{position:absolute;border:3px solid #58d99b;background:#36cc8720;box-shadow:0 0 0 1px #071b14,0 0 20px #2fe29388;color:#fff;cursor:pointer}#bao-automation-game-layer .bao-game-candidate:hover{border-color:#fff;background:#42dc9e38}#bao-automation-game-layer .bao-game-candidate span{position:absolute;left:-3px;bottom:100%;max-width:280px;padding:5px 8px;border-radius:6px 6px 0 0;background:#126442f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bao-automation-game-layer .bao-game-list{position:absolute;z-index:2147483647;top:64px;right:18px;display:grid;width:min(330px,calc(100vw - 36px));max-height:calc(100vh - 82px);gap:6px;overflow:auto;padding:10px;border:1px solid #9ec6ee55;border-radius:11px;background:#0d1d34f5;box-shadow:0 15px 45px #000b}#bao-automation-game-layer .bao-game-list-head{display:grid;gap:3px;padding:0 2px 4px}#bao-automation-game-layer .bao-game-list-head small{color:#9db1c9;font-size:10px}#bao-automation-game-layer .bao-game-option{display:grid;grid-template-columns:22px 1fr;gap:7px;align-items:center;width:100%;min-height:38px;padding:6px 8px;border:1px solid #8eb8e233;border-radius:8px;background:#142843;color:#e7f1ff;text-align:left;cursor:pointer}#bao-automation-game-layer .bao-game-option:hover{border-color:#67dca1;background:#174432}#bao-automation-game-layer .bao-game-option b{display:grid;width:21px;height:21px;place-items:center;border-radius:50%;background:#2c7957;font-size:10px}#bao-automation-game-layer .bao-game-option span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#bao-automation-game-layer .bao-game-option small{grid-column:2;color:#91a9c2;font-size:9px}
`;
  (document.head || document.documentElement).appendChild(style);

  var root = document.createElement('section');
  root.id = 'bao-automation-frame-assistant';
  root.setAttribute('data-view', 'run');
  root.innerHTML = '<button class="bao-orb" aria-label="展开自动化助手"><i class="bao-ring"></i><span class="bao-orb-icon">⌘</span></button><aside class="bao-drawer"><i class="bao-handle"></i><header class="bao-head"><div class="bao-title"><strong>BaoFlash 自动化</strong></div><button class="bao-icon bao-collapse" title="收起">×</button></header><nav class="bao-tabs"><button class="bao-tab bao-active" data-view="run">执行</button><button class="bao-tab" data-view="match">识别</button><button class="bao-tab" data-view="capture">取材</button></nav><div class="bao-views">'
    + '<section class="bao-view bao-active" data-panel="run"><div class="bao-card"><div class="bao-field"><label>自动化脚本</label><select class="bao-package-run"></select></div><div class="bao-run-state"><i class="bao-run-dot"></i><div class="bao-run-copy"><b class="bao-state-title">可以开始</b><span class="bao-state-detail">正在读取运行状态…</span></div><small class="bao-step">0 步</small></div><div class="bao-progress"><i></i></div></div><div class="bao-two"><button class="bao-button bao-primary bao-start">开始脚本</button><button class="bao-button bao-danger bao-stop" disabled>停止</button></div><div class="bao-card" style="margin-top:7px"><div class="bao-card-head"><strong>运行记录</strong></div><div class="bao-log"><div class="bao-log-row"><time>--:--:--</time><span>等待启动脚本</span></div></div></div></section>'
    + '<section class="bao-view" data-panel="match"><div class="bao-card"><div class="bao-match-modes"><button class="bao-match-mode bao-active" data-match-mode="image">图片识别</button><button class="bao-match-mode" data-match-mode="text">文字识别</button></div><div class="bao-test-settings bao-image-settings"><div class="bao-card-head"><strong>UI 素材</strong><button class="bao-button bao-refresh" style="height:25px">刷新素材</button></div><div class="bao-assets"></div><div class="bao-field"><label>识别阈值 <b class="bao-threshold-text">90%</b></label><input class="bao-threshold" type="range" min="50" max="100" value="90"></div></div><div class="bao-test-settings bao-text-settings bao-hidden"><div class="bao-field"><label>要识别的文字</label><input class="bao-ocr-text" type="text" maxlength="200" placeholder="例如：开始游戏"></div><div class="bao-ocr-row"><div class="bao-field"><label>匹配方式</label><select class="bao-ocr-match"><option value="contains">包含文字</option><option value="exact">完全一致</option></select></div><div class="bao-field"><label>最低可信度</label><input class="bao-ocr-score" type="number" min="0" max="1" step="0.01" value="0.5"></div></div></div><div class="bao-preview"><span>选择测试方式后捕获页面</span></div><p class="bao-result">选择图片或输入文字开始测试</p><div class="bao-two"><button class="bao-button bao-primary bao-compare">捕获并比对</button><button class="bao-button bao-monitor">连续监测</button></div></div></section>'
    + '<section class="bao-view" data-panel="capture"><div class="bao-card"><div class="bao-card-head"><strong>取材工具</strong><small>坐标范围 0–10000</small></div><div class="bao-two"><button class="bao-button bao-primary bao-capture">框选图片素材</button><button class="bao-button bao-primary bao-coordinate">获取相对坐标</button></div><div class="bao-game-actions"><button class="bao-button bao-game-select">选择游戏画面</button><button class="bao-button bao-game-copy">复制特征串</button><button class="bao-button bao-danger bao-game-clear">取消选择</button></div></div></section>'
    + '</div></aside>';
  document.documentElement.appendChild(root);

  var toasts = document.createElement('div'); toasts.id = 'bao-automation-assistant-toasts'; document.documentElement.appendChild(toasts);
  var captureLayer = document.createElement('div'); captureLayer.id = 'bao-automation-capture-layer';
  captureLayer.innerHTML = '<img class="bao-capture-image" alt=""><div class="bao-capture-help"><span>拖动框选需要识别的 UI 素材</span><button class="bao-capture-cancel" type="button">取消</button></div><div class="bao-selection"><span class="bao-selection-info">0 × 0</span></div><div class="bao-save"><label>素材名称<input class="bao-capture-name" type="text" autocomplete="off" spellcheck="false"></label><small>默认名称自动递增，也可以直接修改；按 Enter 保存</small><div class="bao-conflict"><span>该名称已经存在，要如何处理？</span><div class="bao-conflict-buttons"><button class="bao-replace">替换原素材</button><button class="bao-suffix">自动追加编号</button></div></div><div class="bao-save-buttons"><button class="bao-redo">重新框选</button><button class="bao-primary bao-save-crop">保存素材</button></div></div>';
  document.documentElement.appendChild(captureLayer);
  var coordinateLayer = document.createElement('div'); coordinateLayer.id = 'bao-automation-coordinate-layer';
  coordinateLayer.innerHTML = '<div class="bao-coordinate-help">移动鼠标查看坐标，单击复制 <b>X,Y</b>，按 Esc 取消</div><i class="bao-coordinate-surface"></i><i class="bao-coordinate-x"></i><i class="bao-coordinate-y"></i><output class="bao-coordinate-value">5000,5000</output>';
  document.documentElement.appendChild(coordinateLayer);
  var gameLayer = document.createElement('div'); gameLayer.id = 'bao-automation-game-layer';
  gameLayer.innerHTML = '<div class="bao-game-help"><span>单击绿色框，或从右侧候选列表选择</span><button class="bao-game-cancel" type="button">取消</button></div><div class="bao-game-candidates"></div><aside class="bao-game-list"><div class="bao-game-list-head"><strong>检测到的游戏画面</strong><small>旧式 Flash 可能盖住绿色边框，请直接选择列表中的 Flash 项</small></div><div class="bao-game-options"></div></aside>';
  document.documentElement.appendChild(gameLayer);

  var orb = root.querySelector('.bao-orb');
  var packageRun = root.querySelector('.bao-package-run');
  var assetsHost = root.querySelector('[data-panel="match"] .bao-assets');
  var threshold = root.querySelector('.bao-threshold');
  var ocrText = root.querySelector('.bao-ocr-text');
  var ocrMatch = root.querySelector('.bao-ocr-match');
  var ocrScore = root.querySelector('.bao-ocr-score');
  var preview = root.querySelector('.bao-preview');
  var resultText = root.querySelector('.bao-result');
  var startButton = root.querySelector('.bao-start');
  var stopButton = root.querySelector('.bao-stop');
  var selectedAsset = '';

  function toast(text) {
    var item = document.createElement('div'); item.className = 'bao-toast'; item.textContent = text; toasts.appendChild(item);
    setTimeout(function () { item.remove(); }, 2800);
  }
  function fitOpenPanel() {
    if (!root.classList.contains('bao-open')) return;
    var top = parseFloat(root.style.top) || root.getBoundingClientRect().top;
    root.style.top = Math.max(8, Math.min(innerHeight - root.offsetHeight - 8, top)) + 'px';
  }
  function openPanel(view) {
    if (view) selectView(view);
    root.classList.add('bao-open');
    fitOpenPanel();
    void refreshPackages();
  }
  function closePanel() { root.classList.remove('bao-open'); }
  function selectView(view) {
    root.querySelectorAll('.bao-tab,.bao-view').forEach(function (item) { item.classList.remove('bao-active'); });
    var tab = root.querySelector('[data-view="' + view + '"]'); var panel = root.querySelector('[data-panel="' + view + '"]');
    if (tab) tab.classList.add('bao-active'); if (panel) panel.classList.add('bao-active');
    root.setAttribute('data-view', view);
    fitOpenPanel();
    if (view === 'match' || view === 'capture') void refreshPackages();
    if (view === 'match') void api.warmAuthoring().catch(function () { /* Best-effort warm-up. */ });
  }
  function currentPackage() { return state.packages.find(function (item) { return item.packageId === packageRun.value; }); }
  function messageText(message) {
    if (!message) return '';
    if (typeof message === 'string') return message;
    var p = message.params || {};
    var map = {
      'status.scriptCompleted': '脚本执行完成', 'status.scriptStopped': '脚本已停止', 'status.stepNext': '可以执行下一步',
      'status.imageMatch': '识别到 ' + (p.asset || '') + ' · ' + (p.score || '') + '% · 总耗时 ' + (p.totalMs || '?') + 'ms（截图 ' + (p.captureMs || '?') + 'ms · 匹配 ' + (p.matchMs || '?') + 'ms）',
      'status.randomClickCoordinate': '本次随机点击坐标：' + (p.x || 0) + ',' + (p.y || 0),
      'status.runFailed': '运行失败：' + (p.detail || ''), 'status.readyCheckFailed': '就绪检查失败：' + (p.detail || ''),
      'step.clickImage': '点击图片：' + (p.asset || ''), 'step.waitImage': '等待图片：' + (p.asset || ''),
      'step.clickCoordinate': '点击坐标：' + (p.x || 0) + ',' + (p.y || 0),
      'step.randomClickRegion': '在指定区域内随机点击',
      'step.moveToImage': '移动到图片：' + (p.asset || ''), 'step.dragImage': '拖拽图片：' + (p.source || '') + ' → ' + (p.target || ''), 'step.delay': '等待 ' + (p.ms || 0) + 'ms',
      'step.moveToCoordinate': '移动鼠标到：' + (p.x || 0) + ',' + (p.y || 0), 'step.drag': '拖拽到指定目标',
      'step.keyPress': '按键：' + (p.key || ''), 'step.textInput': '输入文本', 'step.scroll': '滚动页面',
      'step.navigate': '打开页面', 'step.reload': '刷新页面', 'step.ifImage': '判断图片：' + (p.asset || ''),
      'step.ifCondition': '判断组合条件', 'step.waitCondition': '等待组合条件', 'step.repeat': '循环 ' + (p.times || 0) + ' 次',
      'step.waitConditionBranch': '等待条件并处理超时', 'step.end': '结束脚本：' + (p.result === 'failure' ? '执行失败' : '正常完成') + (p.message ? ' · ' + p.message : ''),
    };
    return map[message.key] || (message.key === 'raw' ? String(p.text || '') : message.key);
  }
  function renderStatus(status) {
    var active = ['preparing', 'checking', 'countdown', 'running', 'cancelling'].indexOf(status.state) >= 0;
    root.classList.toggle('bao-running', active); root.classList.toggle('bao-success', status.state === 'completed'); root.classList.toggle('bao-failed', status.state === 'failed');
    root.querySelector('.bao-run-state').classList.toggle('bao-live', active);
    var titles = { idle: '可以开始', preparing: '正在准备', checking: '检查入口条件', ready: '已经就绪', countdown: '倒计时启动', running: '正在执行', cancelling: '正在停止', completed: '执行完成', failed: '执行失败', cancelled: '已停止' };
    root.querySelector('.bao-state-title').textContent = titles[status.state] || status.state;
    root.querySelector('.bao-state-detail').textContent = messageText(status.currentStep) || messageText(status.message) || (status.workflowName || '等待启动脚本');
    root.querySelector('.bao-step').textContent = String(status.executedSteps || 0) + ' 步';
    root.querySelector('.bao-progress i').style.width = active ? Math.min(92, 14 + (status.executedSteps || 0) * 8) + '%' : status.state === 'completed' ? '100%' : '0';
    startButton.disabled = active; stopButton.disabled = !active;
    var logs = (status.logs || []).slice(-30).reverse(); var logHost = root.querySelector('.bao-log'); logHost.innerHTML = '';
    logs.forEach(function (entry) { var row = document.createElement('div'); row.className = 'bao-log-row ' + (entry.level === 'success' ? 'bao-good' : entry.level === 'error' ? 'bao-bad' : ''); var time = document.createElement('time'); time.textContent = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false }); var text = document.createElement('span'); text.textContent = messageText(entry.message); row.append(time, text); logHost.appendChild(row); });
    if (!logs.length) logHost.innerHTML = '<div class="bao-log-row"><time>--:--:--</time><span>等待启动脚本</span></div>';
    if (state.statusInitialized && state.lastState !== status.state && status.state === 'completed') toast('自动化脚本执行完成');
    if (state.statusInitialized && state.lastState !== status.state && status.state === 'failed') toast(messageText(status.message) || '自动化脚本执行失败');
    state.lastState = status.state;
    state.statusInitialized = true;
  }
  async function pollStatus() { try { renderStatus(await api.status()); } catch { /* Page teardown or disabled service. */ } }

  async function refreshPackages() {
    var previousPackage = packageRun.value; var previousAsset = selectedAsset;
    try { state.packages = await api.listPackages(); } catch (error) { resultText.textContent = error.message || String(error); return; }
    packageRun.innerHTML = '';
    state.packages.forEach(function (pkg) { var option = document.createElement('option'); option.value = pkg.packageId; option.textContent = pkg.name; packageRun.appendChild(option); });
    if (!state.packages.length) { var empty = document.createElement('option'); empty.value = ''; empty.textContent = '没有 Automation 2.0 包，请先在工作台新建'; packageRun.appendChild(empty); }
    if (state.packages.some(function (item) { return item.packageId === previousPackage; })) packageRun.value = previousPackage;
    renderAssets(previousAsset);
  }
  function renderAssets(preferred) {
    var pkg = currentPackage(); var assets = pkg ? pkg.assets : []; var byDirectory = {};
    assets.forEach(function (asset) { var at = asset.lastIndexOf('/'); if (at <= 0) return; var directory = asset.slice(0, at); if (directory === 'assets') return; (byDirectory[directory] || (byDirectory[directory] = [])).push(asset); });
    var groups = Object.keys(byDirectory).filter(function (directory) { return byDirectory[directory].length >= 2; }).sort().map(function (directory) {
      var members = byDirectory[directory].slice().sort(); return { label: '图片组：' + directory.replace(/^assets\//, '') + '（' + members.length + ' 张）', preview: members[0], value: '@bao-image-group:' + members.map(encodeURIComponent).join('|') };
    });
    var choices = groups.concat(assets.map(function (asset) { return { label: asset, preview: asset, value: asset }; })); var values = choices.map(function (choice) { return choice.value; });
    if (values.indexOf(preferred) >= 0) selectedAsset = preferred; else if (values.indexOf(selectedAsset) < 0) selectedAsset = choices.length ? choices[0].value : '';
    assetsHost.innerHTML = '';
    choices.forEach(function (choice) {
      var button = document.createElement('button'); button.className = 'bao-asset' + (choice.value === selectedAsset ? ' bao-selected' : ''); button.title = choice.label; var image = document.createElement('img'); var label = document.createElement('span'); label.textContent = choice.label; button.append(image, label);
      button.addEventListener('click', function () { selectedAsset = choice.value; renderAssets(choice.value); void warmSelected(); }); assetsHost.appendChild(button);
      void api.assetPreview(pkg.packageId, choice.preview).then(function (value) { image.src = value.dataUrl; }).catch(function () {});
    });
    if (!assets.length) assetsHost.innerHTML = '<span style="color:#8fa3ba;font-size:10px">当前脚本没有图片素材</span>';
    if (selectedAsset) void warmSelected();
  }
  async function warmSelected() { var pkg = currentPackage(); if (!pkg || !selectedAsset || selectedAsset.indexOf('@bao-image-group:') === 0) return; try { await api.warmup(pkg.packageId, selectedAsset); } catch { /* Best-effort idle warmup. */ } }
  async function withRecognitionPanelCollapsed(task) {
    var shouldRestore = root.getAttribute('data-view') === 'match' && root.classList.contains('bao-open');
    if (shouldRestore) {
      closePanel();
      // Wait until the drawer has fully become the orb so the transition cannot
      // be captured as part of the recognition frame.
      await new Promise(function (resolve) { setTimeout(resolve, 260); });
    }
    try { return await task(); }
    finally {
      if (shouldRestore) {
        root.classList.add('bao-open');
        fitOpenPanel();
      }
    }
  }
  function formatMs(value) {
    var duration = Math.max(0, Number(value) || 0);
    if (duration > 0 && duration < 0.1) return '<0.1';
    return duration < 10 ? duration.toFixed(1) : String(Math.round(duration));
  }
  function renderMatch(value) {
    preview.innerHTML = ''; var wrap = document.createElement('div'); wrap.className = 'bao-image'; var image = document.createElement('img'); image.src = value.dataUrl; wrap.appendChild(image);
    if (value.candidate) { var hit = document.createElement('span'); hit.className = 'bao-hit' + (value.matched ? ' bao-ok' : ''); hit.style.left = value.candidate.x / value.sourceWidth * 100 + '%'; hit.style.top = value.candidate.y / value.sourceHeight * 100 + '%'; hit.style.width = value.candidate.width / value.sourceWidth * 100 + '%'; hit.style.height = value.candidate.height / value.sourceHeight * 100 + '%'; var badge = document.createElement('b'); badge.textContent = (value.candidate.score * 100).toFixed(1) + '%'; hit.appendChild(badge); wrap.appendChild(hit); var relative = Math.round(value.candidate.x) + ',' + Math.round(value.candidate.y); var page = Math.round(value.candidate.pageX == null ? value.candidate.x : value.candidate.pageX) + ',' + Math.round(value.candidate.pageY == null ? value.candidate.y : value.candidate.pageY); var matchMs = Math.max(0, Number(value.candidate.matchMs) || 0); var captureMs = Math.max(0, Number(value.captureMs) || 0); var totalMs = Math.max(matchMs + captureMs, Number(value.totalMs) || 0); resultText.textContent = (value.matched ? '匹配成功' : '最佳候选低于阈值') + ' · 游戏区域 ' + relative + ' · 页面 ' + page + ' · 缩放 ' + (value.candidate.scale || 1).toFixed(2) + ' · 总计 ' + formatMs(totalMs) + 'ms（截图 ' + formatMs(captureMs) + 'ms · 匹配 ' + formatMs(matchMs) + 'ms）'; }
    else resultText.textContent = '没有找到匹配候选'; preview.appendChild(wrap);
  }
  function renderOcr(value) {
    preview.innerHTML = ''; var wrap = document.createElement('div'); wrap.className = 'bao-image'; var image = document.createElement('img'); image.src = value.dataUrl; wrap.appendChild(image);
    (value.candidates || []).forEach(function (candidate) {
      var hit = document.createElement('span'); hit.className = 'bao-hit' + (candidate.matched ? ' bao-ok' : '');
      hit.style.left = candidate.x / value.sourceWidth * 100 + '%'; hit.style.top = candidate.y / value.sourceHeight * 100 + '%';
      hit.style.width = candidate.width / value.sourceWidth * 100 + '%'; hit.style.height = candidate.height / value.sourceHeight * 100 + '%';
      var badge = document.createElement('b'); badge.textContent = candidate.text + ' ' + (candidate.score * 100).toFixed(1) + '%'; hit.appendChild(badge); wrap.appendChild(hit);
    });
    preview.appendChild(wrap);
    var matchedCount = (value.candidates || []).filter(function (candidate) { return candidate.matched; }).length;
    var captureMs = Math.max(0, Number(value.captureMs) || 0); var bitmapMs = Math.max(0, Number(value.bitmapMs) || 0); var ocrMs = Math.max(0, Number(value.ocrMs) || 0); var totalMs = Math.max(captureMs + bitmapMs + ocrMs, Number(value.totalMs) || 0); var otherMs = Math.max(0, totalMs - captureMs - bitmapMs - ocrMs);
    var best = (value.candidates || [])[0]; var recognizedCount = Math.max(0, Number(value.recognizedCount) || 0); var query = String(value.query || '');
    var summary = value.matched ? '找到 ' + matchedCount + ' 处匹配文字' : best ? '最接近候选“' + best.text + '”未满足条件' : recognizedCount ? '未找到与“' + query + '”相关的文字 · OCR 识别到 ' + recognizedCount + ' 处' : '没有识别到文字';
    resultText.textContent = summary + ' · 总耗时 ' + formatMs(totalMs) + 'ms（截图 ' + formatMs(captureMs) + 'ms · 位图 ' + formatMs(bitmapMs) + 'ms · OCR ' + formatMs(ocrMs) + 'ms' + (otherMs ? ' · 其他 ' + formatMs(otherMs) + 'ms' : '') + '）';
  }
  function selectMatchMode(mode) {
    stopMonitor(); state.matchMode = mode === 'text' ? 'text' : 'image';
    root.querySelectorAll('.bao-match-mode').forEach(function (button) { button.classList.toggle('bao-active', button.getAttribute('data-match-mode') === state.matchMode); });
    root.querySelector('.bao-image-settings').classList.toggle('bao-hidden', state.matchMode !== 'image');
    root.querySelector('.bao-text-settings').classList.toggle('bao-hidden', state.matchMode !== 'text');
    root.querySelector('.bao-compare').textContent = state.matchMode === 'text' ? '捕获并识别' : '捕获并比对';
    preview.innerHTML = '<span>' + (state.matchMode === 'text' ? '输入文字后捕获页面' : '选择素材后捕获页面') + '</span>';
    resultText.textContent = state.matchMode === 'text' ? 'OCR 在本机离线运行，仅 OCR 版可用' : '选择素材开始测试';
  }
  function ocrRegion() {
    // The detector rectangle belongs to the page's current live CSS viewport.
    // Include that viewport so Automation Core can map it into its fixed logical
    // viewport before capture; the two spaces are intentionally not assumed equal.
    var rect = visibleGameSurfaceRect(); if (!rect) return undefined;
    var x = Math.round(rect.x); var y = Math.round(rect.y);
    var width = Math.round(rect.width); var height = Math.round(rect.height);
    if (width <= 0 || height <= 0) return undefined;
    return { x: Math.max(0, x), y: Math.max(0, y), width, height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }
  async function compareText() {
    var text = String(ocrText.value || '').trim(); if (!text) { resultText.textContent = '请先输入要识别的文字'; ocrText.focus(); return; }
    var score = Math.max(0, Math.min(1, Number(ocrScore.value) || 0)); ocrScore.value = String(score);
    var region = ocrRegion(); var value = await withRecognitionPanelCollapsed(function () { return api.ocrTest(text, { match: ocrMatch.value, minScore: score, region: region }); }); renderOcr(value);
  }
  async function compare() {
    if (state.busy) return;
    if (state.matchMode === 'image') { var pkg = currentPackage(); if (!pkg) { resultText.textContent = '没有 Automation 2.0 包，请先在工作台新建'; return; } if (!selectedAsset) { resultText.textContent = '当前包没有图片素材，请先到“取材”页捕获素材'; return; } }
    state.busy = true; resultText.textContent = '正在捕获当前页面…';
    try {
      await refreshBoundSurfaceIfNeeded();
      if (state.matchMode === 'text') await compareText();
      else { var region = ocrRegion(); var value = await withRecognitionPanelCollapsed(function () { return api.match(pkg.packageId, selectedAsset, { threshold: Number(threshold.value) / 100, region: region }); }); renderMatch(value); }
    }
    catch (error) { resultText.textContent = error.message || String(error); }
    finally { state.busy = false; }
  }
  function stopMonitor() { if (state.monitor) clearInterval(state.monitor); state.monitor = 0; root.querySelector('.bao-monitor').textContent = '连续监测'; }

  function nextAssetName() { var pkg = currentPackage(); var names = pkg ? pkg.assets : []; var index = state.captureIndex; var name; do { name = '截取素材_' + String(index++).padStart(3, '0') + '.png'; } while (names.indexOf(name) >= 0); return name; }
  function cleanName(value) { var text = String(value || '').trim().split('').map(function (character) { return character.charCodeAt(0) < 32 ? '_' : character; }).join('').replace(/[<>:"/\\|?*]/g, '_'); if (!text) text = nextAssetName(); if (!/\.png$/i.test(text)) text += '.png'; return text; }
  function suffixName(name) { var pkg = currentPackage(); var names = pkg ? pkg.assets : []; var base = name.replace(/\.png$/i, '').replace(/_\d{3}$/, ''); var index = 2; var candidate; do { candidate = base + '_' + String(index++).padStart(3, '0') + '.png'; } while (names.indexOf(candidate) >= 0); return candidate; }
  async function beginCapture() {
    var pkg = currentPackage(); if (!pkg) { toast('请先选择自动化脚本'); return; }
    toast('正在捕获当前页面…');
    try {
      await refreshBoundSurfaceIfNeeded();
      state.capture = await api.captureFrame(ocrRegion(), state.gameSurface ? 'surface' : 'viewport'); var image = captureLayer.querySelector('.bao-capture-image'); image.src = state.capture.dataUrl;
      captureLayer.classList.add('bao-active'); captureLayer.querySelector('.bao-selection').style.display = 'none'; captureLayer.querySelector('.bao-save').style.display = 'none'; captureLayer.querySelector('.bao-conflict').classList.remove('bao-show'); captureLayer.querySelector('.bao-capture-name').value = nextAssetName();
    } catch (error) { openPanel('capture'); toast(error.message || String(error)); }
  }
  function cancelCapture() { captureLayer.classList.remove('bao-active'); state.capture = null; state.selection = null; openPanel('capture'); }
  async function saveCapture(overwrite) {
    var pkg = currentPackage(); if (!pkg || !state.capture || !state.selection) return;
    var nameInput = captureLayer.querySelector('.bao-capture-name'); var name = cleanName(nameInput.value); nameInput.value = name;
    try {
      var saved = await api.saveCapture(pkg.packageId, state.capture.token, name, state.selection, Boolean(overwrite));
      if (saved.conflict) { captureLayer.querySelector('.bao-conflict').classList.add('bao-show'); return; }
      var automatic = name.match(/^截取素材_(\d{3})\.png$/i); if (automatic) state.captureIndex = Math.max(state.captureIndex, Number(automatic[1]) + 1); GM.setValue('captureIndex', state.captureIndex);
      captureLayer.classList.remove('bao-active'); state.capture = null; state.selection = null; selectedAsset = saved.asset || name; await refreshPackages(); openPanel('capture'); toast('素材“' + name + '”已保存并选中');
    } catch (error) { toast(error.message || String(error)); }
  }
  function visibleGameSurfaceRect() {
    var rect = state.gameSurface && state.gameSurface.rect; if (!rect) return null;
    var left = Math.max(0, Number(rect.x) || 0); var top = Math.max(0, Number(rect.y) || 0);
    var right = Math.min(innerWidth, (Number(rect.x) || 0) + (Number(rect.width) || 0));
    var bottom = Math.min(innerHeight, (Number(rect.y) || 0) + (Number(rect.height) || 0));
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }
  function rememberSurfaceViewport() { state.surfaceViewport = { width: innerWidth, height: innerHeight }; }
  function surfaceViewportChanged() { return state.gameSurface && (!state.surfaceViewport || state.surfaceViewport.width !== innerWidth || state.surfaceViewport.height !== innerHeight); }
  async function refreshBoundSurfaceIfNeeded(force) {
    if (!state.gameSurface || (!force && !surfaceViewportChanged())) return;
    var detected = await api.detectGameSurfaces();
    if (!detected || !detected.bound) { state.gameSurface = null; state.surfaceViewport = null; updateGameButton(); throw new Error('窗口尺寸变化后未能重新定位游戏画面，请重新选择游戏画面'); }
    state.gameSurface = detected.bound; rememberSurfaceViewport(); updateGameButton();
  }
  function coordinateAt(clientX, clientY) {
    var rect = visibleGameSurfaceRect();
    var left = rect ? rect.x : 0; var top = rect ? rect.y : 0;
    var width = rect ? rect.width : innerWidth; var height = rect ? rect.height : innerHeight;
    var stepX = innerWidth / Math.max(1, Number(state.coordinateViewport.width) || 1280);
    var stepY = innerHeight / Math.max(1, Number(state.coordinateViewport.height) || 720);
    return {
      x: Math.max(0, Math.min(10000, Math.round((clientX - left) / Math.max(1, width - stepX) * 10000))),
      y: Math.max(0, Math.min(10000, Math.round((clientY - top) / Math.max(1, height - stepY) * 10000))),
    };
  }
  function updateCoordinate(event) { var point = coordinateAt(event.clientX, event.clientY); var value = coordinateLayer.querySelector('.bao-coordinate-value'); coordinateLayer.querySelector('.bao-coordinate-x').style.left = event.clientX + 'px'; coordinateLayer.querySelector('.bao-coordinate-y').style.top = event.clientY + 'px'; value.textContent = point.x + ',' + point.y; value.style.left = Math.min(innerWidth - 96, event.clientX + 12) + 'px'; value.style.top = Math.min(innerHeight - 34, event.clientY + 12) + 'px'; return point; }
  async function copyText(text) { try { await window.navigator.clipboard.writeText(text); return; } catch { /* Fall back for pages without clipboard permission. */ } var input = document.createElement('textarea'); input.value = text; input.style.cssText = 'position:fixed;left:-9999px;top:-9999px'; document.documentElement.appendChild(input); input.select(); document.execCommand('copy'); input.remove(); }
  function gameSurfaceFeature(candidate) {
    var rect = candidate && candidate.rect || {}; var clean = function (value) { return String(value || '').split(/[?#]/)[0].slice(0, 600); };
    var payload = { version: 1, kind: candidate.kind, label: String(candidate.label || '').slice(0, 200), source: clean(candidate.source), frameUrl: clean(candidate.frameUrl), width: Math.max(1, Math.round(Number(rect.width) || 1)), height: Math.max(1, Math.round(Number(rect.height) || 1)) };
    var bytes = new window.TextEncoder().encode(JSON.stringify(payload)); var binary = ''; for (var index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return 'BFG1:' + window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function showCoordinateSurface() {
    var marker = coordinateLayer.querySelector('.bao-coordinate-surface'); var rect = visibleGameSurfaceRect();
    coordinateLayer.classList.toggle('bao-surface', Boolean(rect));
    if (!rect) return;
    marker.style.left = rect.x + 'px'; marker.style.top = rect.y + 'px'; marker.style.width = rect.width + 'px'; marker.style.height = rect.height + 'px';
  }
  function closeGameSelect() { gameLayer.classList.remove('bao-active'); gameLayer.querySelector('.bao-game-candidates').innerHTML = ''; gameLayer.querySelector('.bao-game-options').innerHTML = ''; openPanel('capture'); }
  function surfaceLabel(candidate) {
    var kind = candidate.kind === 'flash' ? 'Flash' : candidate.kind === 'ruffle' ? 'Ruffle' : candidate.kind === 'canvas' ? 'Canvas' : '页面区域';
    return kind + ' · ' + (candidate.label || '游戏画面') + (candidate.frameDepth ? ' · 第 ' + candidate.frameDepth + ' 层' : '');
  }
  function updateGameButton() {
    var button = root.querySelector('.bao-game-select');
    root.querySelector('.bao-game-actions').classList.toggle('bao-bound', Boolean(state.gameSurface));
    button.textContent = state.gameSurface ? '已选择：' + surfaceLabel(state.gameSurface) : '选择游戏画面';
    button.title = state.gameSurface ? '坐标和高速识图区域将相对此画面计算；点击可重新选择' : '跨多层 iframe 查找 Flash、Ruffle 或 Canvas 游戏画面';
  }
  async function beginGameSelect() {
    closePanel(); toast('正在查找当前页面中的游戏画面…');
    try {
      var result = await api.detectGameSurfaces(); var candidates = result && Array.isArray(result.candidates) ? result.candidates : [];
      if (result && result.bound) { state.gameSurface = result.bound; updateGameButton(); }
      if (!candidates.length) { openPanel('capture'); toast('没有检测到可见的 Flash、Ruffle 或 Canvas 画面'); return; }
      var host = gameLayer.querySelector('.bao-game-candidates'); var listHost = gameLayer.querySelector('.bao-game-options'); host.innerHTML = ''; listHost.innerHTML = '';
      var list = gameLayer.querySelector('.bao-game-list'); var primaryRect = candidates[0].rect || {};
      var leftSpace = Math.max(0, Number(primaryRect.x) || 0); var rightSpace = Math.max(0, innerWidth - (Number(primaryRect.x) || 0) - (Number(primaryRect.width) || 0));
      var placeLeft = leftSpace > rightSpace; var sideSpace = Math.max(leftSpace, rightSpace);
      list.style.width = Math.max(180, Math.min(330, sideSpace - 16)) + 'px';
      if (placeLeft) { list.style.left = '8px'; list.style.right = 'auto'; } else { list.style.left = 'auto'; list.style.right = '8px'; }
      async function selectCandidate(candidate) {
        try { var bound = await api.bindGameSurface(candidate.id); state.gameSurface = bound.bound; rememberSurfaceViewport(); updateGameButton(); closeGameSelect(); toast('已将坐标和识图区域绑定到所选游戏画面'); }
        catch (error) { toast(error.message || String(error)); }
      }
      candidates.forEach(function (candidate, index) {
        var rect = candidate.rect || {}; var button = document.createElement('button'); button.className = 'bao-game-candidate'; button.type = 'button';
        button.style.left = Math.max(0, Number(rect.x) || 0) + 'px'; button.style.top = Math.max(0, Number(rect.y) || 0) + 'px';
        button.style.width = Math.max(20, Number(rect.width) || 0) + 'px'; button.style.height = Math.max(20, Number(rect.height) || 0) + 'px';
        button.style.zIndex = String(Math.max(1, Math.round(Number(candidate.score) || 1)));
        var label = document.createElement('span'); label.textContent = surfaceLabel(candidate); button.appendChild(label);
        button.addEventListener('click', async function (event) {
          event.preventDefault(); event.stopPropagation();
          await selectCandidate(candidate);
        }); host.appendChild(button);
        var option = document.createElement('button'); option.className = 'bao-game-option'; option.type = 'button';
        var number = document.createElement('b'); number.textContent = String(index + 1); var text = document.createElement('span'); text.textContent = surfaceLabel(candidate);
        var size = document.createElement('small'); size.textContent = Math.round(Number(rect.width) || 0) + ' × ' + Math.round(Number(rect.height) || 0);
        option.append(number, text, size); option.addEventListener('click', function () { void selectCandidate(candidate); }); listHost.appendChild(option);
      });
      gameLayer.classList.add('bao-active');
    } catch (error) { openPanel('capture'); toast(error.message || String(error)); }
  }
  async function beginCoordinatePick() {
    try {
      await refreshBoundSurfaceIfNeeded(true);
      var coordinateSession = await api.beginCoordinatePick();
      if (coordinateSession && coordinateSession.viewport) state.coordinateViewport = coordinateSession.viewport;
      if (state.gameSurface && !visibleGameSurfaceRect()) throw new Error('游戏画面当前不在可见页面内');
      showCoordinateSurface(); coordinateLayer.classList.add('bao-active');
      toast(state.gameSurface ? '坐标以绿色游戏画面为范围，单击即可复制' : '单击目标位置即可复制页面相对坐标');
    } catch (error) { openPanel('capture'); toast(error.message || String(error)); }
  }
  async function endCoordinatePick(reopen) { coordinateLayer.classList.remove('bao-active'); try { await api.endCoordinatePick(); } finally { if (reopen) openPanel('capture'); } }

  root.querySelectorAll('.bao-tab').forEach(function (tab) { tab.addEventListener('click', function () { selectView(tab.getAttribute('data-view')); }); });
  root.addEventListener('pointerup', function (event) { var button = event.target.closest && event.target.closest('button'); if (button) button.blur(); });
  root.querySelector('.bao-collapse').addEventListener('click', closePanel);
  root.querySelector('.bao-refresh').addEventListener('click', function () { void refreshPackages().then(function () { toast('素材列表已刷新'); }); });
  root.querySelectorAll('.bao-match-mode').forEach(function (button) { button.addEventListener('click', function () { selectMatchMode(button.getAttribute('data-match-mode')); }); });
  packageRun.addEventListener('change', function () { selectedAsset = ''; renderAssets(''); void warmSelected(); });
  threshold.addEventListener('input', function () { root.querySelector('.bao-threshold-text').textContent = threshold.value + '%'; });
  ocrText.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); void compare(); } });
  root.querySelector('.bao-compare').addEventListener('click', function () { void compare(); });
  root.querySelector('.bao-monitor').addEventListener('click', function () { if (state.monitor) stopMonitor(); else { void compare(); state.monitor = setInterval(function () { void compare(); }, 1800); root.querySelector('.bao-monitor').textContent = '停止监测'; } });
  startButton.addEventListener('click', async function () { var pkg = currentPackage(); if (!pkg) { toast('没有 Automation 2.0 包，请先在工作台新建'); return; } startButton.disabled = true; try { await api.start(pkg.packageId, 0); toast('自动化脚本已启动'); void pollStatus(); } catch (error) { startButton.disabled = false; toast(error.message || String(error)); } });
  stopButton.addEventListener('click', async function () { try { await api.cancel(); toast('正在停止自动化脚本'); } catch (error) { toast(error.message || String(error)); } });
  root.querySelector('.bao-capture').addEventListener('click', function () { void beginCapture(); });
  root.querySelector('.bao-coordinate').addEventListener('click', function () { void beginCoordinatePick(); });
  root.querySelector('.bao-game-select').addEventListener('click', function () { void beginGameSelect(); });
  root.querySelector('.bao-game-copy').addEventListener('click', function () {
    if (!state.gameSurface) return;
    var feature = gameSurfaceFeature(state.gameSurface);
    void copyText(feature).then(function () { root.querySelector('.bao-game-copy').setAttribute('data-last-copied', feature); toast('已复制游戏画面特征串，请到入口积木中导入'); });
  });
  root.querySelector('.bao-game-clear').addEventListener('click', async function () {
    try { await api.clearGameSurface(); state.gameSurface = null; state.surfaceViewport = null; updateGameButton(); toast('已恢复为整个页面坐标和识图范围'); }
    catch (error) { toast('取消失败：' + (error && error.message ? error.message : String(error))); }
  });
  gameLayer.querySelector('.bao-game-cancel').addEventListener('click', closeGameSelect);
  var dragging = null; var moved = false;
  function placeCollapsedRoot(x, y) {
    var left = Math.max(8, Math.min(innerWidth - 54, x)); var top = Math.max(8, Math.min(innerHeight - 54, y)); var dockRight = left > innerWidth / 2;
    root.classList.toggle('bao-right', dockRight); root.style.top = top + 'px';
    if (dockRight) { root.style.left = 'auto'; root.style.right = Math.max(8, innerWidth - left - 46) + 'px'; }
    else { root.style.left = left + 'px'; root.style.right = 'auto'; }
  }
  orb.addEventListener('pointerdown', function (event) { moved = false; var rect = orb.getBoundingClientRect(); dragging = { x: event.clientX - rect.left, y: event.clientY - rect.top }; orb.setPointerCapture(event.pointerId); });
  orb.addEventListener('pointermove', function (event) { if (!dragging) return; if (Math.abs(event.movementX) + Math.abs(event.movementY) > 2) moved = true; closePanel(); placeCollapsedRoot(event.clientX - dragging.x, event.clientY - dragging.y); });
  orb.addEventListener('pointerup', function (event) { dragging = null; orb.releasePointerCapture(event.pointerId); var rect = orb.getBoundingClientRect(); GM.setValue('position', { x: rect.left, y: rect.top }); });
  orb.addEventListener('click', function () { if (moved) return; if (root.classList.contains('bao-open')) closePanel(); else openPanel(); });

  var selecting = false; var selectionStart = null; var selection = captureLayer.querySelector('.bao-selection'); var saveBox = captureLayer.querySelector('.bao-save');
  captureLayer.addEventListener('pointerdown', function (event) { if (event.target.closest('.bao-save') || event.target.closest('.bao-capture-help')) return; var imageRect = captureLayer.querySelector('.bao-capture-image').getBoundingClientRect(); if (event.clientX < imageRect.left || event.clientX > imageRect.right || event.clientY < imageRect.top || event.clientY > imageRect.bottom) return; selecting = true; selectionStart = { x: event.clientX, y: event.clientY }; selection.style.cssText = 'display:block;left:' + event.clientX + 'px;top:' + event.clientY + 'px;width:0;height:0'; saveBox.style.display = 'none'; });
  captureLayer.addEventListener('pointermove', function (event) { if (!selecting) return; var imageRect = captureLayer.querySelector('.bao-capture-image').getBoundingClientRect(); var x = Math.max(imageRect.left, Math.min(imageRect.right, event.clientX)); var y = Math.max(imageRect.top, Math.min(imageRect.bottom, event.clientY)); var left = Math.min(selectionStart.x, x); var top = Math.min(selectionStart.y, y); var width = Math.abs(x - selectionStart.x); var height = Math.abs(y - selectionStart.y); selection.style.left = left + 'px'; selection.style.top = top + 'px'; selection.style.width = width + 'px'; selection.style.height = height + 'px'; selection.querySelector('.bao-selection-info').textContent = Math.round(width) + ' × ' + Math.round(height); });
  captureLayer.addEventListener('pointerup', function () { if (!selecting) return; selecting = false; var rect = selection.getBoundingClientRect(); if (rect.width < 3 || rect.height < 3) { selection.style.display = 'none'; return; } var imageRect = captureLayer.querySelector('.bao-capture-image').getBoundingClientRect(); state.selection = { x: (rect.left - imageRect.left) * state.capture.previewWidth / imageRect.width, y: (rect.top - imageRect.top) * state.capture.previewHeight / imageRect.height, width: rect.width * state.capture.previewWidth / imageRect.width, height: rect.height * state.capture.previewHeight / imageRect.height }; saveBox.style.display = 'grid'; saveBox.style.left = Math.max(8, Math.min(innerWidth - 300, rect.right - 284)) + 'px'; saveBox.style.top = Math.max(58, Math.min(innerHeight - 190, rect.bottom + 9)) + 'px'; setTimeout(function () { var input = captureLayer.querySelector('.bao-capture-name'); input.focus(); input.select(); }, 0); });
  captureLayer.querySelector('.bao-redo').addEventListener('click', function () { selection.style.display = 'none'; saveBox.style.display = 'none'; state.selection = null; });
  captureLayer.querySelector('.bao-capture-cancel').addEventListener('click', cancelCapture);
  captureLayer.querySelector('.bao-save-crop').addEventListener('click', function () { void saveCapture(false); });
  captureLayer.querySelector('.bao-replace').addEventListener('click', function () { void saveCapture(true); });
  captureLayer.querySelector('.bao-suffix').addEventListener('click', function () { var input = captureLayer.querySelector('.bao-capture-name'); input.value = suffixName(cleanName(input.value)); captureLayer.querySelector('.bao-conflict').classList.remove('bao-show'); void saveCapture(false); });
  captureLayer.querySelector('.bao-capture-name').addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); void saveCapture(false); } else captureLayer.querySelector('.bao-conflict').classList.remove('bao-show'); });
  coordinateLayer.addEventListener('pointermove', updateCoordinate);
  coordinateLayer.addEventListener('click', function (event) { event.preventDefault(); event.stopImmediatePropagation(); var point = updateCoordinate(event); var text = point.x + ',' + point.y; void copyText(text).then(async function () { coordinateLayer.setAttribute('data-last-copied', text); await endCoordinatePick(true); toast('已复制坐标 ' + text); }); });
  coordinateLayer.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  window.addEventListener('keydown', function (event) { if (gameLayer.classList.contains('bao-active') && event.key === 'Escape') { event.preventDefault(); closeGameSelect(); return; } if (coordinateLayer.classList.contains('bao-active') && event.key === 'Escape') { event.preventDefault(); void endCoordinatePick(true); return; } if (event.ctrlKey && event.shiftKey && String(event.key).toLowerCase() === 'a') { event.preventDefault(); openPanel(); } }, true);

  var savedPosition = GM.getValue('position', null); if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) placeCollapsedRoot(savedPosition.x, savedPosition.y);
  window.addEventListener('resize', function () { var rect = orb.getBoundingClientRect(); var wasOpen = root.classList.contains('bao-open'); placeCollapsedRoot(rect.left, rect.top); if (wasOpen) root.classList.add('bao-open'); if (gameLayer.classList.contains('bao-active')) closeGameSelect(); if (state.surfaceRefreshTimer) window.clearTimeout(state.surfaceRefreshTimer); state.surfaceRefreshTimer = window.setTimeout(function () { state.surfaceRefreshTimer = 0; void refreshBoundSurfaceIfNeeded().catch(function (error) { toast(error.message || String(error)); }); }, 180); });
  window.addEventListener('pagehide', function () { gameLayer.classList.remove('bao-active'); if (coordinateLayer.classList.contains('bao-active')) void api.endCoordinatePick(); });
  if (GM.registerMenuCommand) GM.registerMenuCommand('显示自动化助手', function () { openPanel(); });
  void refreshPackages(); void pollStatus(); state.statusTimer = setInterval(function () { void pollStatus(); }, 600);
})();
