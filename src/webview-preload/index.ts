// @ts-nocheck
// webview 注入脚本（guest 页面内运行）
// 职责：1) 识别登录表单 2) 捕获提交的账号密码 3) 按主机指令填充表单
// 通信：guest->host 用 ipcRenderer.sendToHost；host->guest 用 webview.send -> ipcRenderer.on
// 注意：本脚本为独立 CommonJS 文件，不经 webpack（target:web 无法打包 electron）。
var preloadLog = function () {};
try {
  var electron = require('electron');
  var ipcRenderer = electron.ipcRenderer;
  if (ipcRenderer && ipcRenderer.sendToHost) {
    preloadLog = function (msg) { try { ipcRenderer.sendToHost('preload-log', msg); } catch (e) {} };
    preloadLog('loaded:' + location.href);
  }
} catch (e) { return; }

// 仅主框架生效，避免嵌套 iframe 重复触发
if (window.top === window.self) {
  preloadLog('topframe:' + location.href);

  // --- 登录表单识别 ---
  function findLoginInputs() {
    var pwInputs = document.querySelectorAll('input[type=password]');
    if (!pwInputs.length) return null;
    var pwInput = pwInputs[pwInputs.length - 1]; // 取最后一个密码框（通常是确认登录的那一个）
    var form = null;
    if (pwInput.form) {
      form = pwInput.form;
    } else if (pwInput.closest) {
      form = pwInput.closest('form');
    }
    // 用户名输入框：同 form 内优先 email / name 含 user|login|email|account 的 text 输入
    var userInput = null;
    var scope = form || document;
    var candidates = scope.querySelectorAll('input[type=email], input[type=text], input[type=tel]');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var nm = (el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '');
      if (/user|login|email|account|name|acct/i.test(nm)) { userInput = el; break; }
    }
    if (!userInput && candidates.length) userInput = candidates[0];
    return { form: form, userInput: userInput, pwInput: pwInput };
  }

  function readCredentials() {
    var lf = findLoginInputs();
    if (!lf || !lf.pwInput) return null;
    var username = lf.userInput ? (lf.userInput.value || '') : '';
    var password = lf.pwInput.value || '';
    if (!password) return null;
    return {
      username: username,
      password: password,
      formAction: lf.form ? (lf.form.action || '') : ''
    };
  }

  function reportCapture() {
    try {
      var creds = readCredentials();
      if (!creds) return;
      ipcRenderer.sendToHost('login-submitted', {
        url: location.href,
        username: creds.username,
        password: creds.password,
        formAction: creds.formAction
      });
    } catch (err) {
      ipcRenderer.sendToHost('preload-log', 'capture-error: ' + err);
    }
  }

  preloadLog('listeners-attached:' + location.href);

  // 捕获 1：表单 submit（传统表单）
  document.addEventListener('submit', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'FORM') return;
    if (!t.querySelector('input[type=password]')) return;
    reportCapture();
  }, true);

  // 捕获 2：密码框内回车（覆盖 AJAX 登录）
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var lf = findLoginInputs();
    if (!lf || !lf.pwInput) return;
    var active = document.activeElement;
    if (!active) return;
    if (lf.form && !lf.form.contains(active)) return;
    // 延迟到表单处理之后再捕获，确保 value 已就位
    setTimeout(reportCapture, 0);
  }, true);

  // --- 自动填充 ---
  function setInputValue(el, val) {
    if (!el) return;
    try {
      // 直接设置 value（DOM 跨隔离世界共享）
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    } catch (err) {
      ipcRenderer.sendToHost('preload-log', 'fill-set-error: ' + err);
    }
  }

  ipcRenderer.on('fill-credentials', function (event, data) {
    try {
      var lf = findLoginInputs();
      if (!lf) {
        ipcRenderer.sendToHost('fill-result', { ok: false, reason: 'no-form' });
        return;
      }
      if (data && data.username && lf.userInput) {
        setInputValue(lf.userInput, data.username);
      }
      if (data && data.password && lf.pwInput) {
        setInputValue(lf.pwInput, data.password);
      }
      ipcRenderer.sendToHost('fill-result', { ok: true });
    } catch (err) {
      ipcRenderer.sendToHost('fill-result', { ok: false, reason: String(err) });
    }
  });

  // host 询问当前页面是否有可填充的登录表单
  ipcRenderer.on('query-login-form', function () {
    var lf = findLoginInputs();
    ipcRenderer.sendToHost('login-form-found', {
      url: location.href,
      hasForm: !!lf
    });
  });

  // DOM 就绪后回报一次（便于 host 决定是否填充）
  function notifyReady() {
    try {
      var lf = findLoginInputs();
      ipcRenderer.sendToHost('login-form-found', {
        url: location.href,
        hasForm: !!lf
      });
    } catch (e) {}
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(notifyReady, 100);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(notifyReady, 100); });
  }

  // --- Ctrl+滚轮缩放 ---
  // 缩放由 host 通过 executeJavaScript 注入，不在此处理（避免 file:// 页面 preload 限制）

}
