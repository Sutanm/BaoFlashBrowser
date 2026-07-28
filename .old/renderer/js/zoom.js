// 缩放管理模块
var tabManager = require('./tab-manager');
var state = require('./state');

var btnZoomIn, btnZoomOut, btnZoomReset, zoomDisplay;
var zoomIndicator;
var zoomHideTimer = null; 

// 初始化（接收UI元素引用）
function init(opts) {
  btnZoomIn = opts.btnZoomIn;
  btnZoomOut = opts.btnZoomOut;
  btnZoomReset = opts.btnZoomReset;
  zoomDisplay = opts.zoomDisplay;

  // 绑定UI按钮事件
  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', zoomIn);
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', zoomOut);
  }
  if (btnZoomReset) {
    btnZoomReset.addEventListener('click', zoomReset);
  }

  // 接收主进程转发的快捷键事件（Ctrl++/Ctrl+-/Ctrl+0）
  if (window.electronAPI && window.electronAPI.onZoomShortcut) {
    window.electronAPI.onZoomShortcut(function (action) {
      if (action === 'in') zoomIn();
      else if (action === 'out') zoomOut();
      else if (action === 'reset') zoomReset();
    });
  }

  // 注册Ctrl+滚轮缩放（监听主窗口document）
  registerWheelZoom();

  // 初始化显示（设置面板label，不弹浮窗）
  updateZoomDisplay(state.defaultZoomFactor);
}

// 放大（当前标签页）
function zoomIn() {
  var tab = tabManager.getActiveTab();
  if (!tab) return;
  var newFactor = Math.min(5.0, tab.zoomFactor + state.zoomStep);
  applyZoom(tab, newFactor);
}

// 缩小（当前标签页）
function zoomOut() {
  var tab = tabManager.getActiveTab();
  if (!tab) return;
  var newFactor = Math.max(0.25, tab.zoomFactor - state.zoomStep);
  applyZoom(tab, newFactor);
}

// 重置为100%
function zoomReset() {
  var tab = tabManager.getActiveTab();
  if (!tab) return;
  applyZoom(tab, 1.0);
}

// 应用缩放到指定标签页
function applyZoom(tab, factor) {
  if (!tab || !tab.webview) return;
  try {
    tab.webview.setZoomFactor(factor);
    tab.zoomFactor = factor;
    updateZoomDisplay(factor);
    showZoomPopup(Math.round(factor * 100));
  } catch (e) {
    console.error('Zoom failed:', e);
  }
}

// 更新设置面板中的缩放比例显示
function updateZoomDisplay(factor) {
  if (zoomDisplay) {
    var percentage = Math.round(factor * 100);
    zoomDisplay.textContent = percentage + '%';
  }
}

// 缩放指示器浮窗（类 Chrome，1秒无变化后淡出）
function showZoomPopup(percentage) {
  if (!zoomIndicator) {
    zoomIndicator = document.getElementById('zoom-indicator');
    if (!zoomIndicator) return;
  }
  zoomIndicator.textContent = percentage + '%';
  zoomIndicator.classList.add('show');
  if (zoomHideTimer) clearTimeout(zoomHideTimer);
  zoomHideTimer = setTimeout(function () {
    zoomIndicator.classList.remove('show');
  }, 1000);
}

// 注册Ctrl+滚轮缩放（仅在主窗口document上）
function registerWheelZoom() {
  document.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.deltaY < 0) {
      zoomIn();  // 向上滚动 = 放大
    } else {
      zoomOut(); // 向下滚动 = 缩小
    }
  }, { capture: true, passive: false });
}

module.exports = {
  init: init,
  zoomIn: zoomIn,
  zoomOut: zoomOut,
  zoomReset: zoomReset,
  applyZoom: applyZoom
};