// 密码本：面板状态机 + 自动填充调度 + 捕获保存
var tabManager = require('./tab-manager');
var dom = require('./utils/dom');

var els = {};
var _unlocked = false;          // 本会话主密码解锁态镜像
var _initialized = false;       // 密码本是否已初始化
var _editingId = null;          // 当前编辑条目 id（null=新增）
var _revealedIds = {};          // id -> true 已显示明文
var _pendingCapture = null;     // 当前 toast 待保存的捕获
var _neverList = {};            // 'host|username' -> true（本会话不再提示）
var _toastTimer = null;
var _unlockCallback = null;     // 解锁成功回调

function init(opts) {
  els.panel = opts.passwordPanel;
  els.btn = opts.btnPasswords;
  els.btnClose = opts.btnPasswordsClose;
  els.body = opts.passwordPanelBody;
  els.toast = opts.passwordSaveToast;
  els.favPanel = opts.favPanel;
  els.settingsPanel = opts.settingsPanel;

  if (els.btn) {
    els.btn.addEventListener('click', togglePanel);
  }
  if (els.btnClose) {
    els.btnClose.addEventListener('click', function () { els.panel.classList.add('hidden'); });
  }

  tabManager.onWebviewReady(handleWebviewReady);
  tabManager.onLoginCaptured(handleLoginCaptured);
}

// ---------- 面板开关 ----------
function togglePanel() {
  if (els.panel.classList.contains('hidden')) {
    // 关闭其它面板
    if (els.favPanel) els.favPanel.classList.add('hidden');
    if (els.settingsPanel) els.settingsPanel.classList.add('hidden');
    els.panel.classList.remove('hidden');
    refresh();
  } else {
    els.panel.classList.add('hidden');
  }
}

// ---------- 状态拉取与渲染 ----------
function refresh() {
  if (!window.electronAPI || !window.electronAPI.getPasswordStatus) return;
  window.electronAPI.getPasswordStatus().then(function (st) {
    _initialized = !!st.initialized;
    _unlocked = !!st.unlocked;
    if (!_initialized) {
      renderSetup();
    } else {
      renderList();
    }
  }).catch(function () {});
}

function renderSetup() {
  els.body.innerHTML =
    '<div class="pw-setup-form">' +
      '<div class="pw-setup-title">首次使用密码本</div>' +
      '<div class="pw-setup-tip">设置一个主密码，仅用于查看已保存的明文密码。自动填充无需主密码。</div>' +
      '<label>主密码</label>' +
      '<input type="password" id="pw-master-new" class="pw-input" placeholder="至少 4 位">' +
      '<label>确认主密码</label>' +
      '<input type="password" id="pw-master-confirm" class="pw-input" placeholder="再次输入">' +
      '<div id="pw-setup-err" class="pw-err"></div>' +
      '<button id="pw-setup-submit" class="btn-primary">启用密码本</button>' +
    '</div>';
  document.getElementById('pw-setup-submit').addEventListener('click', function () {
    var a = document.getElementById('pw-master-new').value;
    var b = document.getElementById('pw-master-confirm').value;
    var err = document.getElementById('pw-setup-err');
    if (a.length < 4) { err.textContent = '主密码至少 4 位'; return; }
    if (a !== b) { err.textContent = '两次输入不一致'; return; }
    window.electronAPI.setupPassword(a).then(function () {
      _unlocked = true;
      // 若来自 toast 的首次保存，自动写入捕获的密码
      if (_postSetupCapture) {
        var cap = _postSetupCapture;
        _postSetupCapture = null;
        window.electronAPI.savePassword({
          host: cap.host, origin: cap.origin, title: cap.title,
          username: cap.username, password: cap.password
        }).then(function () { renderList(); }).catch(function () { renderList(); });
      } else {
        renderList();
      }
    }).catch(function (e) {
      err.textContent = '启用失败：' + (e && e.message ? e.message : e);
    });
  });
}

function renderList() {
  window.electronAPI.listPasswords().then(function (entries) {
    renderListFrom(entries || []);
  }).catch(function () { renderListFrom([]); });
}

function renderListFrom(entries) {
  var lockBtn = _unlocked
    ? '<button id="pw-lock-btn" class="pw-mini-btn" title="锁定后查看明文需重新输入主密码">🔒 锁定</button>'
    : '<span class="pw-locked-tag">已锁定</span>';
  var html =
    '<div class="pw-toolbar">' +
      '<button id="pw-add-btn" class="pw-mini-btn">➕ 添加</button>' +
      '<button id="pw-refresh-btn" class="pw-mini-btn">🔄</button>' +
      '<span class="pw-toolbar-spacer"></span>' +
      lockBtn +
    '</div>' +
    '<div id="pw-unlock-box" class="pw-unlock hidden">' +
      '<input type="password" id="pw-unlock-input" class="pw-input" placeholder="主密码">' +
      '<button id="pw-unlock-submit" class="btn-primary">解锁</button>' +
      '<button id="pw-unlock-cancel" class="pw-mini-btn">取消</button>' +
    '</div>' +
    '<div id="pw-form-box" class="pw-form hidden">' +
      '<input type="text" id="pw-f-title" class="pw-input" placeholder="标题（如：GitHub）">' +
      '<input type="text" id="pw-f-host" class="pw-input" placeholder="主机名（如 github.com）">' +
      '<input type="text" id="pw-f-user" class="pw-input" placeholder="用户名/邮箱">' +
      '<input type="text" id="pw-f-pwd" class="pw-input" placeholder="密码">' +
      '<div class="pw-form-actions">' +
        '<button id="pw-f-save" class="btn-primary">保存</button>' +
        '<button id="pw-f-cancel" class="pw-mini-btn">取消</button>' +
      '</div>' +
    '</div>' +
    '<div id="pw-list" class="pw-list"></div>';
  els.body.innerHTML = html;

  // 工具栏事件
  document.getElementById('pw-add-btn').addEventListener('click', function () { openForm(null); });
  document.getElementById('pw-refresh-btn').addEventListener('click', renderList);
  if (_unlocked) {
    document.getElementById('pw-lock-btn').addEventListener('click', function () {
      window.electronAPI.lockPassword().then(function () {
        _unlocked = false;
        _revealedIds = {};
        renderList();
      });
    });
  }

  // 解锁框
  bindUnlockBox();

  // 表单
  bindFormBox();

  // 列表
  var listEl = document.getElementById('pw-list');
  if (!entries.length) {
    listEl.innerHTML = '<div class="pw-empty">暂无密码条目</div>';
    return;
  }
  for (var i = 0; i < entries.length; i++) {
    listEl.appendChild(buildEntryRow(entries[i]));
  }
  bindEntryEvents();
}

function buildEntryRow(e) {
  var row = document.createElement('div');
  row.className = 'pw-item';
  row.setAttribute('data-id', e.id);
  var pwdDisplay = _revealedIds[e.id] ? '••••••' : '••••••';
  var revealLabel = _revealedIds[e.id] ? '隐藏' : '显示';
  row.innerHTML =
    '<div class="pw-item-main">' +
      '<div class="pw-item-title">' + dom.escapeHtml(e.title || e.host) + '</div>' +
      '<div class="pw-item-meta">' + dom.escapeHtml(e.host) + ' · ' + dom.escapeHtml(e.username || '') + '</div>' +
      '<div class="pw-item-pwd" data-id="' + dom.escapeHtml(e.id) + '">' + pwdDisplay + '</div>' +
    '</div>' +
    '<div class="pw-actions">' +
      '<button class="pw-mini-btn pw-reveal" data-id="' + dom.escapeHtml(e.id) + '">' + revealLabel + '</button>' +
      '<button class="pw-mini-btn pw-copy" data-id="' + dom.escapeHtml(e.id) + '" title="复制密码">复制</button>' +
      '<button class="pw-mini-btn pw-edit" data-id="' + dom.escapeHtml(e.id) + '">编辑</button>' +
      '<button class="pw-mini-btn pw-del" data-id="' + dom.escapeHtml(e.id) + '">删除</button>' +
    '</div>';
  return row;
}

function bindEntryEvents() {
  var listEl = document.getElementById('pw-list');
  if (!listEl) return;

  var revealBtns = listEl.querySelectorAll('.pw-reveal');
  for (var i = 0; i < revealBtns.length; i++) {
    revealBtns[i].addEventListener('click', function () { toggleReveal(this.getAttribute('data-id')); });
  }
  var copyBtns = listEl.querySelectorAll('.pw-copy');
  for (var j = 0; j < copyBtns.length; j++) {
    copyBtns[j].addEventListener('click', function () { copyPassword(this.getAttribute('data-id')); });
  }
  var editBtns = listEl.querySelectorAll('.pw-edit');
  for (var k = 0; k < editBtns.length; k++) {
    editBtns[k].addEventListener('click', function () { startEdit(this.getAttribute('data-id')); });
  }
  var delBtns = listEl.querySelectorAll('.pw-del');
  for (var m = 0; m < delBtns.length; m++) {
    delBtns[m].addEventListener('click', function () { removeEntry(this.getAttribute('data-id')); });
  }
}

// ---------- 显示/隐藏明文 ----------
function toggleReveal(id) {
  if (_revealedIds[id]) {
    delete _revealedIds[id];
    renderList();
    return;
  }
  if (!_unlocked) {
    showUnlockBox(function () { toggleReveal(id); });
    return;
  }
  window.electronAPI.revealPassword(id).then(function (res) {
    if (!res || res.error) {
      if (res && res.error === 'locked') { _unlocked = false; showUnlockBox(function(){ toggleReveal(id); }); }
      return;
    }
    _revealedIds[id] = true;
    // 直接显示明文
    var span = document.querySelector('.pw-item-pwd[data-id="' + cssEscape(id) + '"]');
    if (span) span.textContent = res.password;
    var btn = document.querySelector('.pw-reveal[data-id="' + cssEscape(id) + '"]');
    if (btn) btn.textContent = '隐藏';
    // 暂存明文供复制
    _revealedPlain[id] = res.password;
  }).catch(function () {});
}
var _revealedPlain = {};

function copyPassword(id) {
  var pw = _revealedPlain[id];
  if (!pw) {
    // 需解锁后取明文
    if (!_unlocked) { showUnlockBox(function () { copyPassword(id); }); return; }
    window.electronAPI.revealPassword(id).then(function (res) {
      if (res && res.password) {
        _revealedPlain[id] = res.password;
        doCopy(res.password);
      }
    });
    return;
  }
  doCopy(pw);
}

function doCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (e) {}
}

// ---------- 解锁框 ----------
function bindUnlockBox() {
  var box = document.getElementById('pw-unlock-box');
  if (!box) return;
  document.getElementById('pw-unlock-submit').addEventListener('click', submitUnlock);
  document.getElementById('pw-unlock-cancel').addEventListener('click', function () {
    box.classList.add('hidden');
    _unlockCallback = null;
  });
  document.getElementById('pw-unlock-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitUnlock();
  });
}

function showUnlockBox(onSuccess) {
  _unlockCallback = onSuccess;
  var box = document.getElementById('pw-unlock-box');
  if (!box) return;
  box.classList.remove('hidden');
  var input = document.getElementById('pw-unlock-input');
  if (input) { input.value = ''; input.focus(); }
}

function submitUnlock() {
  var input = document.getElementById('pw-unlock-input');
  if (!input) return;
  var pwd = input.value;
  window.electronAPI.unlockPassword(pwd).then(function (ok) {
    if (ok) {
      _unlocked = true;
      var box = document.getElementById('pw-unlock-box');
      if (box) box.classList.add('hidden');
      var cb = _unlockCallback;
      _unlockCallback = null;
      // 先刷新列表（切换工具栏），再执行回调，避免回调的 DOM 更新被刷新覆盖
      window.electronAPI.listPasswords().then(function (entries) {
        renderListFrom(entries || []);
        if (cb) cb();
      }).catch(function () { if (cb) cb(); });
    } else {
      input.value = '';
      input.focus();
      input.placeholder = '主密码错误';
    }
  });
}

// ---------- 添加/编辑表单 ----------
function bindFormBox() {
  var box = document.getElementById('pw-form-box');
  if (!box) return;
  document.getElementById('pw-f-save').addEventListener('click', submitForm);
  document.getElementById('pw-f-cancel').addEventListener('click', function () {
    closeForm();
  });
}

function openForm(entry) {
  _editingId = entry ? entry.id : null;
  var box = document.getElementById('pw-form-box');
  if (!box) return;
  box.classList.remove('hidden');
  document.getElementById('pw-f-title').value = entry ? (entry.title || '') : '';
  document.getElementById('pw-f-host').value = entry ? (entry.host || '') : '';
  document.getElementById('pw-f-user').value = entry ? (entry.username || '') : '';
  document.getElementById('pw-f-pwd').value = '';
  // 新增时若需加密但未解锁且无 DPAPI：提示。但常见情况 DPAPI 已就绪，无需解锁。
  document.getElementById('pw-f-title').focus();
}

function closeForm() {
  _editingId = null;
  var box = document.getElementById('pw-form-box');
  if (box) box.classList.add('hidden');
}

function submitForm() {
  var title = document.getElementById('pw-f-title').value.trim();
  var host = document.getElementById('pw-f-host').value.trim();
  var user = document.getElementById('pw-f-user').value.trim();
  var pwd = document.getElementById('pw-f-pwd').value;
  if (!host || !user) { alert('主机名和用户名必填'); return; }
  if (!pwd && !_editingId) { alert('密码必填'); return; }

  if (_editingId) {
    var fields = { title: title, username: user };
    if (pwd) fields.password = pwd;
    window.electronAPI.updatePassword(_editingId, fields).then(function () {
      closeForm();
      renderList();
    }).catch(function (e) { alert('保存失败：' + (e && e.message ? e.message : e)); });
  } else {
    window.electronAPI.savePassword({
      host: host, origin: 'https://' + host, title: title || host,
      username: user, password: pwd
    }).then(function () {
      closeForm();
      renderList();
    }).catch(function (e) { alert('保存失败：' + (e && e.message ? e.message : e)); });
  }
}

function startEdit(id) {
  // 取列表项当前字段（明文不取，密码留空表示不改）
  window.electronAPI.listPasswords().then(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) { openForm(entries[i]); break; }
    }
  });
}

function removeEntry(id) {
  if (!confirm('删除该密码条目？')) return;
  window.electronAPI.deletePassword(id).then(function () {
    delete _revealedIds[id];
    delete _revealedPlain[id];
    renderList();
  });
}

// ---------- 自动填充 ----------
function safeHost(url) {
  if (!url || typeof url !== 'string') return null;
  if (url === 'about:blank' || url.indexOf('newtab.html') !== -1) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    var u = new URL(url);
    return u.hostname || null;
  } catch (e) { return null; }
}

function isAutofillAllowed(url) {
  return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(url);
}

function handleWebviewReady(tab) {
  if (!tab || !tab.url) return;
  var url = tab.url;
  if (!isAutofillAllowed(url)) return;
  var host = safeHost(url);
  if (!host) return;
  // 延迟以等待登录表单渲染
  setTimeout(function () { tryFill(tab, host); }, 500);
  // SPA 二次尝试
  setTimeout(function () { tryFill(tab, host); }, 1800);
}

function tryFill(tab, host) {
  if (!tab || !tab.webview) return;
  if (!window.electronAPI || !window.electronAPI.getPasswordsForHost) return;
  window.electronAPI.getPasswordsForHost(host).then(function (entries) {
    if (!entries || !entries.length) return;
    var e = entries[0];
    try {
      tab.webview.send('fill-credentials', { username: e.username, password: e.password });
    } catch (err) {}
  }).catch(function () {});
}

// ---------- 捕获保存 ----------
function handleLoginCaptured(tab, payload) {
  if (!payload || !payload.url || !payload.password) return;
  var host = safeHost(payload.url);
  if (!host) return;
  var key = host + '|' + (payload.username || '');
  if (_neverList[key]) return;
  if (!_initialized) {
    // 密码本未启用：提示用户启用（首次）
    showSaveToast({
      tab: tab, host: host, origin: payload.url,
      username: payload.username || '', password: payload.password,
      title: (tab && tab.title) || host, mode: 'setup'
    });
    return;
  }
  window.electronAPI.getPasswordMetaForHost(host).then(function (meta) {
    var existingId = null;
    if (meta) {
      for (var i = 0; i < meta.length; i++) {
        if (meta[i].username === (payload.username || '')) { existingId = meta[i].id; break; }
      }
    }
    showSaveToast({
      tab: tab, host: host, origin: payload.url,
      username: payload.username || '', password: payload.password,
      title: (tab && tab.title) || host,
      mode: existingId ? 'update' : 'save'
    });
  }).catch(function () {});
}

function showSaveToast(capture) {
  _pendingCapture = capture;
  if (!els.toast) return;
  var verb = capture.mode === 'update' ? '更新' : (capture.mode === 'setup' ? '启用并保存' : '保存');
  els.toast.innerHTML =
    '<div class="pw-toast-content">' +
      '<span class="pw-toast-text">' + verb + '密码 for <b>' + dom.escapeHtml(capture.host) + '</b>？</span>' +
      '<button id="pw-toast-save" class="btn-primary">' + verb + '</button>' +
      '<button id="pw-toast-never" class="pw-mini-btn">永不</button>' +
      '<button id="pw-toast-close" class="pw-mini-btn">×</button>' +
    '</div>';
  els.toast.classList.remove('hidden');
  els.toast.classList.add('pw-toast-show');

  document.getElementById('pw-toast-save').addEventListener('click', function () {
    confirmSaveToast(capture);
  });
  document.getElementById('pw-toast-never').addEventListener('click', function () {
    _neverList[capture.host + '|' + capture.username] = true;
    hideToast();
  });
  document.getElementById('pw-toast-close').addEventListener('click', hideToast);

  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, 12000);
}

function confirmSaveToast(capture) {
  if (capture.mode === 'setup') {
    // 首次：需先设置主密码。打开面板进入向导。
    hideToast();
    if (els.favPanel) els.favPanel.classList.add('hidden');
    if (els.settingsPanel) els.settingsPanel.classList.add('hidden');
    els.panel.classList.remove('hidden');
    refresh();
    // 暂存捕获，向导完成后自动保存
    _postSetupCapture = capture;
    return;
  }
  window.electronAPI.savePassword({
    host: capture.host, origin: capture.origin, title: capture.title,
    username: capture.username, password: capture.password
  }).then(function () {
    hideToast();
  }).catch(function (e) {
    alert('保存失败：' + (e && e.message ? e.message : e));
  });
}
var _postSetupCapture = null;

function hideToast() {
  if (!els.toast) return;
  els.toast.classList.add('hidden');
  els.toast.classList.remove('pw-toast-show');
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
}

// ---------- 工具 ----------
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
}

module.exports = {
  init: init,
  refresh: refresh
};
