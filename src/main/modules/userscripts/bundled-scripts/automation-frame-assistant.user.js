// ==UserScript==
// @name         BaoFlash 页面悬浮相框助手
// @namespace    bao-flash-browser
// @version      2.0.2
// @description  网页内自动化悬浮球：运行控制、素材识别与截图取材。
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
    packages: [], busy: false, monitor: 0, statusTimer: 0, lastState: 'idle',
    capture: null, selection: null, captureIndex: Number(GM.getValue('captureIndex', 1)) || 1,
  };
  var style = document.createElement('style');
  style.id = 'bao-automation-assistant-style';
  style.textContent = `
#bao-automation-frame-assistant{all:initial;position:fixed;z-index:2147483645;left:18px;top:92px;width:54px;height:54px;color:#eef5ff;font:12px/1.4 Inter,"Microsoft YaHei",system-ui,sans-serif;transition:width .28s cubic-bezier(.2,.8,.2,1),height .28s cubic-bezier(.2,.8,.2,1);color-scheme:dark;touch-action:none}
#bao-automation-frame-assistant *{box-sizing:border-box}
#bao-automation-frame-assistant.bao-open{width:398px;height:min(720px,calc(100vh - 108px))}
#bao-automation-frame-assistant.bao-right{left:auto;right:18px}
#bao-automation-frame-assistant button,#bao-automation-frame-assistant select,#bao-automation-frame-assistant input{font:inherit}
#bao-automation-frame-assistant button:focus-visible,#bao-automation-frame-assistant select:focus-visible,#bao-automation-frame-assistant input:focus-visible{outline:2px solid #77b3ff;outline-offset:2px}
#bao-automation-frame-assistant .bao-orb{position:absolute;z-index:3;left:-8px;top:0;display:grid;width:56px;height:56px;place-items:center;border:1px solid #9ec9ff66;border-radius:50%;background:radial-gradient(circle at 36% 28%,#72b4ff,#2c5cae 58%,#15294d);box-shadow:0 8px 30px #0008,0 0 0 5px #80b8ff19;color:#fff;cursor:grab;transition:transform .2s,box-shadow .2s}
#bao-automation-frame-assistant.bao-right .bao-orb{left:auto;right:-8px}
#bao-automation-frame-assistant .bao-orb:hover{transform:scale(1.06);box-shadow:0 10px 36px #0009,0 0 0 7px #80b8ff24}
#bao-automation-frame-assistant .bao-orb:active{cursor:grabbing}
#bao-automation-frame-assistant .bao-orb-icon{font-size:23px;line-height:1}
#bao-automation-frame-assistant .bao-ring{position:absolute;inset:-5px;border:3px solid transparent;border-radius:50%;opacity:0}
#bao-automation-frame-assistant.bao-running .bao-ring{border-top-color:#7bb8ff;border-right-color:#7bb8ff;opacity:1;animation:bao-spin 1s linear infinite}
#bao-automation-frame-assistant.bao-success .bao-ring{border-color:#45d18a;opacity:1}
#bao-automation-frame-assistant.bao-failed .bao-ring{border-color:#ff6b72;opacity:1}
@keyframes bao-spin{to{transform:rotate(360deg)}}
#bao-automation-frame-assistant .bao-drawer{position:absolute;left:0;top:0;width:398px;height:100%;overflow:hidden;border:1px solid #9bc1ef42;border-radius:0 22px 22px 0;background:linear-gradient(145deg,#192841ed,#0d182be6);box-shadow:0 24px 70px #000a,inset 0 1px #ffffff16;backdrop-filter:blur(12px) saturate(1.15);transform:translateX(calc(-100% - 28px));opacity:0;pointer-events:none;transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .22s}
#bao-automation-frame-assistant.bao-open .bao-drawer{transform:none;opacity:1;pointer-events:auto}
#bao-automation-frame-assistant.bao-right .bao-drawer{left:auto;right:0;border-radius:22px 0 0 22px;transform:translateX(calc(100% + 28px))}
#bao-automation-frame-assistant.bao-right.bao-open .bao-drawer{transform:none}
#bao-automation-frame-assistant.bao-peek .bao-drawer{opacity:.24}#bao-automation-frame-assistant.bao-peek .bao-drawer:hover{opacity:.93}
#bao-automation-frame-assistant .bao-handle{position:absolute;z-index:-1;right:-18px;top:18px;width:35px;height:78px;border:1px solid #9cc4ec33;border-left:0;border-radius:0 28px 28px 0;background:#122137e8;box-shadow:10px 8px 28px #0005}
#bao-automation-frame-assistant.bao-right .bao-handle{left:-18px;right:auto;transform:scaleX(-1)}
#bao-automation-frame-assistant .bao-head{display:flex;height:64px;align-items:center;gap:8px;padding:0 14px 0 61px;border-bottom:1px solid #9cbbee2b}
#bao-automation-frame-assistant.bao-right .bao-head{padding:0 61px 0 14px}
#bao-automation-frame-assistant .bao-title{min-width:0;flex:1}#bao-automation-frame-assistant .bao-title strong{display:block;font-size:14px}#bao-automation-frame-assistant .bao-title small{display:block;overflow:hidden;margin-top:2px;color:#9cafc7;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
#bao-automation-frame-assistant .bao-icon{display:grid;width:30px;height:30px;place-items:center;border:1px solid transparent;border-radius:8px;background:transparent;color:#afc1d8;cursor:pointer}#bao-automation-frame-assistant .bao-icon:hover{border-color:#9cbbee2b;background:#ffffff0d;color:white}
#bao-automation-frame-assistant .bao-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;padding:10px 12px 0}#bao-automation-frame-assistant .bao-tab{padding:8px 5px;border:0;border-radius:8px;background:transparent;color:#8fa3ba;cursor:pointer}#bao-automation-frame-assistant .bao-tab.bao-active{background:#6c9eff1c;color:#c6dcff;box-shadow:inset 0 0 0 1px #77aaff30}
#bao-automation-frame-assistant .bao-views{height:calc(100% - 108px);overflow:auto;padding:12px}#bao-automation-frame-assistant .bao-view{display:none}#bao-automation-frame-assistant .bao-view.bao-active{display:block}
#bao-automation-frame-assistant .bao-card{margin-bottom:10px;padding:12px;border:1px solid #9cbbee2b;border-radius:12px;background:#07132252}#bao-automation-frame-assistant .bao-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}#bao-automation-frame-assistant .bao-card-head strong{font-size:12px}#bao-automation-frame-assistant .bao-card-head small{color:#9cafc7;font-size:10px}
#bao-automation-frame-assistant .bao-field{display:grid;gap:5px;margin-bottom:9px}#bao-automation-frame-assistant .bao-field label{color:#9eb0c5;font-size:10px}#bao-automation-frame-assistant select,#bao-automation-frame-assistant input[type=text],#bao-automation-frame-assistant input[type=number]{width:100%;height:34px;padding:0 10px;border:1px solid #95bce526;border-radius:8px;background:#071524d9;color:#e9f2ff}
#bao-automation-frame-assistant input[type=range]{width:100%;accent-color:#5998ff}
#bao-automation-frame-assistant .bao-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}#bao-automation-frame-assistant .bao-button{height:35px;padding:0 12px;border:1px solid #8eb8e22b;border-radius:9px;background:#10223a;color:#c8d7ea;cursor:pointer}#bao-automation-frame-assistant .bao-button:hover{background:#183254}#bao-automation-frame-assistant .bao-button.bao-primary{border-color:#699fff;background:linear-gradient(#4b8bff,#3971db);color:#fff;box-shadow:0 5px 18px #397ce933}#bao-automation-frame-assistant .bao-button.bao-danger{color:#ffabb0}#bao-automation-frame-assistant .bao-button:disabled{opacity:.45;cursor:not-allowed}
#bao-automation-frame-assistant .bao-run-state{display:flex;align-items:center;gap:11px}#bao-automation-frame-assistant .bao-run-dot{width:11px;height:11px;border-radius:50%;background:#6d7f94;box-shadow:0 0 0 5px #6d7f9422}#bao-automation-frame-assistant .bao-run-state.bao-live .bao-run-dot{background:#6ea8ff;box-shadow:0 0 0 5px #6ea8ff20;animation:bao-pulse 1s ease-in-out infinite}@keyframes bao-pulse{50%{transform:scale(.72);opacity:.6}}
#bao-automation-frame-assistant .bao-run-copy{min-width:0;flex:1}#bao-automation-frame-assistant .bao-run-copy b{display:block}#bao-automation-frame-assistant .bao-run-copy span{display:block;overflow:hidden;margin-top:3px;color:#9cafc7;font-size:10px;text-overflow:ellipsis;white-space:nowrap}#bao-automation-frame-assistant .bao-step{color:#9cafc7;font-size:10px}
#bao-automation-frame-assistant .bao-progress{height:5px;margin-top:11px;overflow:hidden;border-radius:99px;background:#ffffff10}#bao-automation-frame-assistant .bao-progress i{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#4489ff,#69d8e8);transition:width .35s}
#bao-automation-frame-assistant .bao-log{display:grid;gap:7px}#bao-automation-frame-assistant .bao-log-row{display:grid;grid-template-columns:48px 1fr;gap:8px;color:#9fb0c3;font-size:10px}#bao-automation-frame-assistant .bao-log-row time{color:#668098}#bao-automation-frame-assistant .bao-log-row.bao-good span{color:#76dba8}#bao-automation-frame-assistant .bao-log-row.bao-bad span{color:#ff858c}
#bao-automation-frame-assistant .bao-assets{display:flex;gap:7px;overflow:auto;padding:2px 1px 7px}#bao-automation-frame-assistant .bao-asset{position:relative;display:grid;flex:0 0 78px;height:70px;place-items:center;overflow:hidden;border:1px solid #91b9df24;border-radius:9px;background:#071320;color:#a9bbcf;cursor:pointer}#bao-automation-frame-assistant .bao-asset.bao-selected{border-color:#73aaff;box-shadow:0 0 0 2px #73aaff22}#bao-automation-frame-assistant .bao-asset img{max-width:54px;max-height:42px;object-fit:contain}#bao-automation-frame-assistant .bao-asset span{position:absolute;right:3px;bottom:2px;left:3px;overflow:hidden;font-size:8px;text-align:center;text-overflow:ellipsis;white-space:nowrap}
#bao-automation-frame-assistant .bao-preview{display:grid;min-height:150px;place-items:center;overflow:auto;border:4px solid #6e5138;border-radius:7px;background:#07101d;box-shadow:inset 0 0 0 2px #be946b}#bao-automation-frame-assistant .bao-image{position:relative;max-width:100%}#bao-automation-frame-assistant .bao-image img{display:block;width:100%;max-height:285px;object-fit:contain}#bao-automation-frame-assistant .bao-hit{position:absolute;border:2px solid #ffca28;background:#ffca2826;box-shadow:0 0 8px #ffca28;pointer-events:none}#bao-automation-frame-assistant .bao-hit.bao-ok{border-color:#31d17c;background:#31d17c26;box-shadow:0 0 8px #31d17c}#bao-automation-frame-assistant .bao-hit b{position:absolute;left:-2px;bottom:100%;padding:1px 3px;background:#ffca28;color:#172033;font-size:9px;white-space:nowrap}#bao-automation-frame-assistant .bao-hit.bao-ok b{background:#31d17c}
#bao-automation-frame-assistant .bao-result{margin:8px 0 0;color:#9fb1c7;font-size:10px}#bao-automation-frame-assistant .bao-score{color:#72dba5;font-size:25px;font-weight:700}#bao-automation-frame-assistant .bao-tip{padding:10px;border-radius:9px;background:#4b79d414;color:#b6c9e1;font-size:10px;line-height:1.6}
#bao-automation-frame-assistant .bao-mode-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}#bao-automation-frame-assistant .bao-mode{padding:9px 4px;border:1px solid #9cbbee2b;border-radius:9px;background:#081728;color:#91a5bc;font-size:10px;cursor:pointer}#bao-automation-frame-assistant .bao-mode.bao-active{border-color:#669eff66;background:#2d65bc25;color:#d7e8ff}
#bao-automation-assistant-toasts{all:initial;position:fixed;z-index:2147483647;top:18px;left:50%;display:grid;gap:8px;transform:translateX(-50%);pointer-events:none;font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif}#bao-automation-assistant-toasts .bao-toast{min-width:280px;padding:11px 15px;border:1px solid #9ec5ed38;border-radius:10px;background:#102039ee;box-shadow:0 12px 40px #0008;color:#dbeaff;animation:bao-toast-in .25s both}@keyframes bao-toast-in{from{transform:translateY(-12px);opacity:0}}
#bao-automation-capture-layer{all:initial;position:fixed;z-index:2147483646;inset:0;display:none;overflow:hidden;background:#020914ed;color:#eef5ff;font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif;cursor:crosshair}#bao-automation-capture-layer.bao-active{display:block}#bao-automation-capture-layer *{box-sizing:border-box}#bao-automation-capture-layer .bao-capture-image{position:absolute;max-width:100vw;max-height:100vh;object-fit:contain;left:50%;top:50%;transform:translate(-50%,-50%)}#bao-automation-capture-layer .bao-capture-help{position:absolute;z-index:4;top:64px;left:50%;display:flex;align-items:center;gap:10px;padding:7px 8px 7px 16px;transform:translateX(-50%);border:1px solid #b3d2f055;border-radius:999px;background:#10223ef2;box-shadow:0 10px 40px #0008;white-space:nowrap}#bao-automation-capture-layer .bao-capture-cancel{height:28px;padding:0 11px;border-color:#ff9b9b55;background:#5f2637;color:#ffdce2;cursor:pointer}#bao-automation-capture-layer .bao-selection{position:absolute;z-index:2;display:none;border:2px solid #78b5ff;background:#64a4ff16;box-shadow:0 0 0 9999px #02091399}#bao-automation-capture-layer .bao-selection-info{position:absolute;left:-2px;bottom:calc(100% + 7px);padding:4px 7px;border-radius:5px;background:#3779cf;color:white;font-size:10px;white-space:nowrap}
#bao-automation-capture-layer .bao-save{position:absolute;z-index:3;display:none;width:292px;gap:8px;padding:10px;border:1px solid #9ec6ee44;border-radius:12px;background:#0f2038f5;box-shadow:0 15px 45px #000b;cursor:default}#bao-automation-capture-layer .bao-save label{display:grid;gap:5px;color:#a9bbd0;font-size:10px}#bao-automation-capture-layer .bao-save input{width:100%;height:34px;padding:0 10px;border:1px solid #90b9e23d;border-radius:8px;background:#061321;color:#eff6ff}#bao-automation-capture-layer .bao-save small{color:#7890aa;font-size:9px}#bao-automation-capture-layer .bao-save-buttons,#bao-automation-capture-layer .bao-conflict-buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px}#bao-automation-capture-layer button{height:34px;border:1px solid #8eb8e22b;border-radius:8px;background:#142843;color:#dce9f8;cursor:pointer}#bao-automation-capture-layer button.bao-primary{background:#397cec;color:#fff}#bao-automation-capture-layer .bao-conflict{display:none;gap:7px;padding:8px;border:1px solid #ffb15b3b;border-radius:8px;background:#9a5b191f;color:#ffd2a0;font-size:10px}#bao-automation-capture-layer .bao-conflict.bao-show{display:grid}
`;
  (document.head || document.documentElement).appendChild(style);

  var root = document.createElement('section');
  root.id = 'bao-automation-frame-assistant';
  root.innerHTML = '<button class="bao-orb" aria-label="展开自动化助手"><i class="bao-ring"></i><span class="bao-orb-icon">⌘</span></button><aside class="bao-drawer"><i class="bao-handle"></i><header class="bao-head"><div class="bao-title"><strong>BaoFlash 自动化</strong><small>当前网页内控制中心</small></div><button class="bao-icon bao-peek" title="自动淡化">◐</button><button class="bao-icon bao-collapse" title="收起">×</button></header><nav class="bao-tabs"><button class="bao-tab bao-active" data-view="run">执行</button><button class="bao-tab" data-view="match">识别</button><button class="bao-tab" data-view="capture">取材</button></nav><div class="bao-views">'
    + '<section class="bao-view bao-active" data-panel="run"><div class="bao-card"><div class="bao-field"><label>自动化脚本</label><select class="bao-package-run"></select></div><div class="bao-run-state"><i class="bao-run-dot"></i><div class="bao-run-copy"><b class="bao-state-title">可以开始</b><span class="bao-state-detail">正在读取运行状态…</span></div><small class="bao-step">0 步</small></div><div class="bao-progress"><i></i></div></div><div class="bao-two"><button class="bao-button bao-primary bao-start">▶ 开始脚本</button><button class="bao-button bao-danger bao-stop" disabled>■ 停止</button></div><div class="bao-card" style="margin-top:10px"><div class="bao-card-head"><strong>最近运行信息</strong><small>关键事件会显示提示</small></div><div class="bao-log"><div class="bao-log-row"><time>--:--:--</time><span>等待启动脚本</span></div></div></div><div class="bao-card"><div class="bao-card-head"><strong>显示方式</strong><small>不会改变游戏尺寸</small></div><div class="bao-mode-grid"><button class="bao-mode bao-active" data-mode="glass">磨砂</button><button class="bao-mode" data-mode="fade">自动淡化</button><button class="bao-mode" data-mode="compact">仅悬浮球</button></div></div></section>'
    + '<section class="bao-view" data-panel="match"><div class="bao-card"><div class="bao-card-head"><strong>UI 素材</strong><button class="bao-icon bao-refresh" title="刷新素材">↻</button></div><div class="bao-assets"></div><div class="bao-field"><label>识别阈值 <b class="bao-threshold-text">90%</b></label><input class="bao-threshold" type="range" min="50" max="100" value="90"></div><div class="bao-preview"><span>选择素材后捕获当前页面</span></div><p class="bao-result">助手只在截图瞬间隐藏，比对期间保持显示。</p><div class="bao-two"><button class="bao-button bao-primary bao-compare">⌖ 捕获并比对</button><button class="bao-button bao-monitor">连续监测</button></div></div><div class="bao-tip">动图目标建议只截取稳定部分，可显著提高识别率。</div></section>'
    + '<section class="bao-view" data-panel="capture"><div class="bao-card"><div class="bao-card-head"><strong>页面内截图取材</strong><small>支持 Flash 游戏</small></div><p style="margin:0 0 12px;color:#9fb1c7;font-size:11px;line-height:1.7">冻结当前 BrowserView 画面，然后直接框选单个 UI 素材，无需第三方截图软件。</p><button class="bao-button bao-primary bao-capture" style="width:100%">▣ 进入框选取材</button></div><div class="bao-card"><div class="bao-card-head"><strong>命名规则</strong></div><div class="bao-tip">默认使用“截取素材_001.png”自动递增；框选后可以修改名称，按 Enter 保存。</div></div><div class="bao-card"><div class="bao-card-head"><strong>最近保存</strong><small>保存后立即刷新</small></div><div class="bao-assets bao-recent"></div></div></section>'
    + '</div></aside>';
  document.documentElement.appendChild(root);

  var toasts = document.createElement('div'); toasts.id = 'bao-automation-assistant-toasts'; document.documentElement.appendChild(toasts);
  var captureLayer = document.createElement('div'); captureLayer.id = 'bao-automation-capture-layer';
  captureLayer.innerHTML = '<img class="bao-capture-image" alt=""><div class="bao-capture-help"><span>拖动框选需要识别的 UI 素材</span><button class="bao-capture-cancel" type="button">取消</button></div><div class="bao-selection"><span class="bao-selection-info">0 × 0</span></div><div class="bao-save"><label>素材名称<input class="bao-capture-name" type="text" autocomplete="off" spellcheck="false"></label><small>默认名称自动递增，也可以直接修改；按 Enter 保存</small><div class="bao-conflict"><span>该名称已经存在，要如何处理？</span><div class="bao-conflict-buttons"><button class="bao-replace">替换原素材</button><button class="bao-suffix">自动追加编号</button></div></div><div class="bao-save-buttons"><button class="bao-redo">重新框选</button><button class="bao-primary bao-save-crop">保存素材</button></div></div>';
  document.documentElement.appendChild(captureLayer);

  var orb = root.querySelector('.bao-orb');
  var packageRun = root.querySelector('.bao-package-run');
  var assetsHost = root.querySelector('[data-panel="match"] .bao-assets');
  var recentHost = root.querySelector('.bao-recent');
  var threshold = root.querySelector('.bao-threshold');
  var preview = root.querySelector('.bao-preview');
  var resultText = root.querySelector('.bao-result');
  var startButton = root.querySelector('.bao-start');
  var stopButton = root.querySelector('.bao-stop');
  var selectedAsset = '';

  function toast(text) {
    var item = document.createElement('div'); item.className = 'bao-toast'; item.textContent = text; toasts.appendChild(item);
    setTimeout(function () { item.remove(); }, 2800);
  }
  function openPanel(view) {
    root.classList.add('bao-open');
    if (view) selectView(view);
    void refreshPackages();
  }
  function closePanel() { root.classList.remove('bao-open', 'bao-peek'); }
  function selectView(view) {
    root.querySelectorAll('.bao-tab,.bao-view').forEach(function (item) { item.classList.remove('bao-active'); });
    var tab = root.querySelector('[data-view="' + view + '"]'); var panel = root.querySelector('[data-panel="' + view + '"]');
    if (tab) tab.classList.add('bao-active'); if (panel) panel.classList.add('bao-active');
    if (view === 'match' || view === 'capture') void refreshPackages();
  }
  function currentPackage() { return state.packages.find(function (item) { return item.packageId === packageRun.value; }); }
  function messageText(message) {
    if (!message) return '';
    var p = message.params || {};
    var map = {
      'status.scriptCompleted': '脚本执行完成', 'status.scriptStopped': '脚本已停止', 'status.stepNext': '可以执行下一步',
      'status.imageMatch': '识别到 ' + (p.asset || '') + ' · ' + (p.score || '') + '%',
      'status.runFailed': '运行失败：' + (p.detail || ''), 'status.readyCheckFailed': '就绪检查失败：' + (p.detail || ''),
      'step.clickImage': '点击图片：' + (p.asset || ''), 'step.waitImage': '等待图片：' + (p.asset || ''),
      'step.moveToImage': '移动到图片：' + (p.asset || ''), 'step.delay': '等待 ' + (p.ms || 0) + 'ms',
      'step.keyPress': '按键：' + (p.key || ''), 'step.textInput': '输入文本', 'step.scroll': '滚动页面',
      'step.navigate': '打开页面', 'step.reload': '刷新页面', 'step.ifImage': '判断图片：' + (p.asset || ''),
      'step.ifCondition': '判断组合条件', 'step.waitCondition': '等待组合条件', 'step.repeat': '循环 ' + (p.times || 0) + ' 次',
    };
    return map[message.key] || (message.key === 'raw' ? String(p.text || '') : message.key);
  }
  function renderStatus(status) {
    var active = ['checking', 'countdown', 'running'].indexOf(status.state) >= 0;
    root.classList.toggle('bao-running', active); root.classList.toggle('bao-success', status.state === 'completed'); root.classList.toggle('bao-failed', status.state === 'failed');
    root.querySelector('.bao-run-state').classList.toggle('bao-live', active);
    var titles = { idle: '可以开始', checking: '检查入口条件', ready: '已经就绪', countdown: '倒计时启动', running: '正在执行', completed: '执行完成', failed: '执行失败', cancelled: '已停止' };
    root.querySelector('.bao-state-title').textContent = titles[status.state] || status.state;
    root.querySelector('.bao-state-detail').textContent = messageText(status.currentStep) || messageText(status.message) || (status.workflowName || '等待启动脚本');
    root.querySelector('.bao-step').textContent = String(status.executedSteps || 0) + ' 步';
    root.querySelector('.bao-progress i').style.width = active ? Math.min(92, 14 + (status.executedSteps || 0) * 8) + '%' : status.state === 'completed' ? '100%' : '0';
    startButton.disabled = active; stopButton.disabled = !active;
    var logs = (status.logs || []).slice(-6).reverse(); var logHost = root.querySelector('.bao-log'); logHost.innerHTML = '';
    logs.forEach(function (entry) { var row = document.createElement('div'); row.className = 'bao-log-row ' + (entry.level === 'success' ? 'bao-good' : entry.level === 'error' ? 'bao-bad' : ''); var time = document.createElement('time'); time.textContent = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false }); var text = document.createElement('span'); text.textContent = messageText(entry.message); row.append(time, text); logHost.appendChild(row); });
    if (!logs.length) logHost.innerHTML = '<div class="bao-log-row"><time>--:--:--</time><span>等待启动脚本</span></div>';
    if (state.lastState !== status.state && status.state === 'completed') toast('自动化脚本执行完成');
    if (state.lastState !== status.state && status.state === 'failed') toast(messageText(status.message) || '自动化脚本执行失败');
    state.lastState = status.state;
  }
  async function pollStatus() { try { renderStatus(await api.status()); } catch { /* Page teardown or disabled service. */ } }

  async function refreshPackages() {
    var previousPackage = packageRun.value; var previousAsset = selectedAsset;
    try { state.packages = await api.listPackages(); } catch (error) { resultText.textContent = error.message || String(error); return; }
    packageRun.innerHTML = '';
    state.packages.forEach(function (pkg) { var option = document.createElement('option'); option.value = pkg.packageId; option.textContent = pkg.name; packageRun.appendChild(option); });
    if (state.packages.some(function (item) { return item.packageId === previousPackage; })) packageRun.value = previousPackage;
    renderAssets(previousAsset);
  }
  function renderAssets(preferred) {
    var pkg = currentPackage(); var assets = pkg ? pkg.assets : []; if (assets.indexOf(preferred) >= 0) selectedAsset = preferred; else if (assets.indexOf(selectedAsset) < 0) selectedAsset = assets[0] || '';
    assetsHost.innerHTML = '';
    assets.forEach(function (asset) {
      var button = document.createElement('button'); button.className = 'bao-asset' + (asset === selectedAsset ? ' bao-selected' : ''); button.title = asset; var image = document.createElement('img'); var label = document.createElement('span'); label.textContent = asset; button.append(image, label);
      button.addEventListener('click', function () { selectedAsset = asset; renderAssets(asset); void warmSelected(); }); assetsHost.appendChild(button);
      void api.assetPreview(pkg.packageId, asset).then(function (value) { image.src = value.dataUrl; }).catch(function () {});
    });
    if (!assets.length) assetsHost.innerHTML = '<span style="color:#8fa3ba;font-size:10px">当前脚本没有图片素材</span>';
    if (selectedAsset) void warmSelected();
  }
  async function warmSelected() { var pkg = currentPackage(); if (!pkg || !selectedAsset) return; try { await api.warmup(pkg.packageId, selectedAsset); } catch { /* Best-effort idle warmup. */ } }
  function renderMatch(value) {
    preview.innerHTML = ''; var wrap = document.createElement('div'); wrap.className = 'bao-image'; var image = document.createElement('img'); image.src = value.dataUrl; wrap.appendChild(image);
    if (value.candidate) { var hit = document.createElement('span'); hit.className = 'bao-hit' + (value.matched ? ' bao-ok' : ''); hit.style.left = value.candidate.x / value.sourceWidth * 100 + '%'; hit.style.top = value.candidate.y / value.sourceHeight * 100 + '%'; hit.style.width = value.candidate.width / value.sourceWidth * 100 + '%'; hit.style.height = value.candidate.height / value.sourceHeight * 100 + '%'; var badge = document.createElement('b'); badge.textContent = (value.candidate.score * 100).toFixed(1) + '%'; hit.appendChild(badge); wrap.appendChild(hit); resultText.textContent = (value.matched ? '匹配成功' : '最佳候选低于阈值') + ' · 坐标 ' + Math.round(value.candidate.x) + ', ' + Math.round(value.candidate.y) + ' · ' + (value.candidate.matchMs || 0) + 'ms'; }
    else resultText.textContent = '没有找到匹配候选'; preview.appendChild(wrap);
  }
  async function compare() {
    if (state.busy) return; await refreshPackages(); var pkg = currentPackage(); if (!pkg || !selectedAsset) return;
    state.busy = true; resultText.textContent = '正在捕获当前页面…';
    try { var value = await api.match(pkg.packageId, selectedAsset, { threshold: Number(threshold.value) / 100, scales: [.75, 1, 1.25], mask: 'none' }); renderMatch(value); }
    catch (error) { resultText.textContent = error.message || String(error); }
    finally { state.busy = false; }
  }
  function stopMonitor() { if (state.monitor) clearInterval(state.monitor); state.monitor = 0; root.querySelector('.bao-monitor').textContent = '连续监测'; }

  function nextAssetName() { var pkg = currentPackage(); var names = pkg ? pkg.assets : []; var index = state.captureIndex; var name; do { name = '截取素材_' + String(index++).padStart(3, '0') + '.png'; } while (names.indexOf(name) >= 0); return name; }
  function cleanName(value) { var text = String(value || '').trim().split('').map(function (character) { return character.charCodeAt(0) < 32 ? '_' : character; }).join('').replace(/[<>:"/\\|?*]/g, '_'); if (!text) text = nextAssetName(); if (!/\.png$/i.test(text)) text += '.png'; return text; }
  function suffixName(name) { var pkg = currentPackage(); var names = pkg ? pkg.assets : []; var base = name.replace(/\.png$/i, '').replace(/_\d{3}$/, ''); var index = 2; var candidate; do { candidate = base + '_' + String(index++).padStart(3, '0') + '.png'; } while (names.indexOf(candidate) >= 0); return candidate; }
  async function beginCapture() {
    var pkg = currentPackage(); if (!pkg) { toast('请先选择自动化脚本'); return; }
    closePanel(); toast('正在捕获当前页面…');
    try {
      state.capture = await api.captureFrame(); var image = captureLayer.querySelector('.bao-capture-image'); image.src = state.capture.dataUrl;
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
      captureLayer.classList.remove('bao-active'); state.capture = null; state.selection = null; await refreshPackages(); renderRecent(name); openPanel('capture'); toast('素材“' + name + '”已保存并选中'); selectedAsset = name;
    } catch (error) { toast(error.message || String(error)); }
  }
  function renderRecent(name) { var button = document.createElement('button'); button.className = 'bao-asset'; var label = document.createElement('span'); label.textContent = name; button.appendChild(label); recentHost.prepend(button); while (recentHost.children.length > 6) recentHost.lastChild.remove(); }

  root.querySelectorAll('.bao-tab').forEach(function (tab) { tab.addEventListener('click', function () { selectView(tab.getAttribute('data-view')); }); });
  root.querySelector('.bao-collapse').addEventListener('click', closePanel); root.querySelector('.bao-peek').addEventListener('click', function () { root.classList.toggle('bao-peek'); });
  root.querySelector('.bao-refresh').addEventListener('click', function () { void refreshPackages().then(function () { toast('素材列表已刷新'); }); });
  packageRun.addEventListener('change', function () { selectedAsset = ''; renderAssets(''); void warmSelected(); });
  threshold.addEventListener('input', function () { root.querySelector('.bao-threshold-text').textContent = threshold.value + '%'; });
  root.querySelector('.bao-compare').addEventListener('click', function () { void compare(); });
  root.querySelector('.bao-monitor').addEventListener('click', function () { if (state.monitor) stopMonitor(); else { void compare(); state.monitor = setInterval(function () { void compare(); }, 1800); root.querySelector('.bao-monitor').textContent = '停止监测'; } });
  startButton.addEventListener('click', async function () { var pkg = currentPackage(); if (!pkg) return; startButton.disabled = true; try { await api.start(pkg.packageId, 0); toast('自动化脚本已启动'); void pollStatus(); } catch (error) { startButton.disabled = false; toast(error.message || String(error)); } });
  stopButton.addEventListener('click', async function () { try { await api.cancel(); toast('正在停止自动化脚本'); } catch (error) { toast(error.message || String(error)); } });
  root.querySelector('.bao-capture').addEventListener('click', function () { void beginCapture(); });
  root.querySelectorAll('.bao-mode').forEach(function (button) { button.addEventListener('click', function () { root.querySelectorAll('.bao-mode').forEach(function (item) { item.classList.remove('bao-active'); }); button.classList.add('bao-active'); var mode = button.getAttribute('data-mode'); root.classList.toggle('bao-peek', mode === 'fade'); if (mode === 'compact') closePanel(); GM.setValue('displayMode', mode); }); });

  var dragging = null; var moved = false;
  orb.addEventListener('pointerdown', function (event) { moved = false; var rect = root.getBoundingClientRect(); dragging = { x: event.clientX - rect.left, y: event.clientY - rect.top }; orb.setPointerCapture(event.pointerId); });
  orb.addEventListener('pointermove', function (event) { if (!dragging) return; if (Math.abs(event.movementX) + Math.abs(event.movementY) > 2) moved = true; closePanel(); var x = Math.max(8, Math.min(innerWidth - 64, event.clientX - dragging.x)); var y = Math.max(60, Math.min(innerHeight - 64, event.clientY - dragging.y)); root.style.left = x + 'px'; root.style.right = 'auto'; root.style.top = y + 'px'; root.classList.toggle('bao-right', x > innerWidth / 2); });
  orb.addEventListener('pointerup', function (event) { dragging = null; orb.releasePointerCapture(event.pointerId); var rect = root.getBoundingClientRect(); GM.setValue('position', { x: rect.left, y: rect.top }); });
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
  window.addEventListener('keydown', function (event) { if (event.ctrlKey && event.shiftKey && String(event.key).toLowerCase() === 'a') { event.preventDefault(); openPanel(); } }, true);

  var savedPosition = GM.getValue('position', null); if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) { root.style.left = Math.max(8, Math.min(innerWidth - 64, savedPosition.x)) + 'px'; root.style.top = Math.max(60, Math.min(innerHeight - 64, savedPosition.y)) + 'px'; root.classList.toggle('bao-right', savedPosition.x > innerWidth / 2); }
  var displayMode = GM.getValue('displayMode', 'glass'); if (displayMode === 'fade') root.classList.add('bao-peek');
  if (GM.registerMenuCommand) GM.registerMenuCommand('显示自动化助手', function () { openPanel(); });
  void refreshPackages(); void pollStatus(); state.statusTimer = setInterval(function () { void pollStatus(); }, 600);
})();
