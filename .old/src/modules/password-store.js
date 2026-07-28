// 密码本加密存储与业务逻辑
// 模型：DEK（数据加密密钥）保护密码条目；DEK 由两条路径保护：
//   1) dekMasterEnc = AES-256-GCM(KEK=PBKDF2(masterPwd,salt), DEK)  —— 主密码解锁后查看明文
//   2) dekDpapiEnc  = DPAPI(DEK)                                   —— 启动时常驻内存，供无密码自动填充
var crypto = require('crypto');
var Store = require('electron-store');
var log = require('electron-log');
var dpapi = require('./dpapi');

var PBKDF2_ITER = 250000;
var SALT_LEN = 16;
var KEY_LEN = 32;   // AES-256
var IV_LEN = 12;    // GCM 推荐 12 字节

var store = new Store({
  name: 'password-store',
  defaults: {
    version: 1,
    salt: null,
    dekMasterEnc: null,
    dekDpapiEnc: null,
    entries: []
  }
});

// 内存中的 DEK（不要落盘）
var _dekFromDpapi = null;   // 启动时由 DPAPI 解出，自动填充用
var _dekFromMaster = null;  // 主密码解锁后，查看明文用
var _initialized = null;

function _b64(buf) { return buf.toString('base64'); }
function _unb64(s) { return Buffer.from(s, 'base64'); }

function _deriveKek(masterPwd, salt) {
  return crypto.pbkdf2Sync(masterPwd, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

// 字符串加解密（密码明文）
function _encryptStr(key, plaintext) {
  var iv = crypto.randomBytes(IV_LEN);
  var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  var ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  var tag = cipher.getAuthTag();
  return { iv: _b64(iv), ct: _b64(ct), tag: _b64(tag) };
}
function _decryptStr(key, blob) {
  try {
    var decipher = crypto.createDecipheriv('aes-256-gcm', key, _unb64(blob.iv));
    decipher.setAuthTag(_unb64(blob.tag));
    var pt = Buffer.concat([decipher.update(_unb64(blob.ct)), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    return null; // 密钥错误或数据损坏
  }
}

// Buffer 加解密（DEK 本身）
function _encryptBuf(key, buf) {
  var iv = crypto.randomBytes(IV_LEN);
  var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  var ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  var tag = cipher.getAuthTag();
  return { iv: _b64(iv), ct: _b64(ct), tag: _b64(tag) };
}
function _decryptBuf(key, blob) {
  try {
    var decipher = crypto.createDecipheriv('aes-256-gcm', key, _unb64(blob.iv));
    decipher.setAuthTag(_unb64(blob.tag));
    var pt = Buffer.concat([decipher.update(_unb64(blob.ct)), decipher.final()]);
    return pt;
  } catch (e) {
    return null;
  }
}

function _genId() { return crypto.randomBytes(16).toString('hex'); }

function isInitialized() {
  if (_initialized !== null) return _initialized;
  _initialized = !!(store.get('salt') && store.get('dekMasterEnc'));
  return _initialized;
}

function dpapiAvailable() { return dpapi.isAvailable(); }

// App 启动时调用：尝试用 DPAPI 解出 DEK 常驻内存，供自动填充
function init() {
  if (!isInitialized()) return;
  var dekDpapiEnc = store.get('dekDpapiEnc');
  if (!dekDpapiEnc || !dpapi.isAvailable()) {
    log.warn('[PasswordStore] DPAPI DEK 不可用，自动填充需主密码解锁后启用');
    return;
  }
  try {
    var dek = dpapi.unprotect(_unb64(dekDpapiEnc));
    if (dek && dek.length === KEY_LEN) {
      _dekFromDpapi = dek;
      log.info('[PasswordStore] DPAPI DEK 已加载，自动填充就绪');
    } else {
      log.warn('[PasswordStore] DPAPI 解出的 DEK 长度异常');
    }
  } catch (e) {
    log.warn('[PasswordStore] DPAPI unprotect 失败：' + e.message);
  }
}

function setupMaster(password) {
  if (!password || password.length < 4) throw new Error('主密码至少 4 位');
  if (isInitialized()) throw new Error('密码本已初始化');
  var dek = crypto.randomBytes(KEY_LEN);
  var salt = crypto.randomBytes(SALT_LEN);
  var kek = _deriveKek(password, salt);
  var dekMasterEnc = _encryptBuf(kek, dek);
  var dekDpapiEnc = null;
  if (dpapi.isAvailable()) {
    try {
      dekDpapiEnc = _b64(dpapi.protect(dek));
      _dekFromDpapi = dek;
    } catch (e) {
      log.warn('[PasswordStore] DPAPI protect 失败：' + e.message);
    }
  }
  store.set('version', 1);
  store.set('salt', _b64(salt));
  store.set('dekMasterEnc', dekMasterEnc);
  store.set('dekDpapiEnc', dekDpapiEnc);
  store.set('entries', []);
  _dekFromMaster = dek; // 刚设置完，保持解锁态
  _initialized = true;
  return true;
}

function unlockWithMaster(password) {
  if (!isInitialized()) return false;
  var salt = _unb64(store.get('salt'));
  var kek = _deriveKek(password, salt);
  var dek = _decryptBuf(kek, store.get('dekMasterEnc'));
  if (!dek) return false;
  _dekFromMaster = dek;
  if (!_dekFromDpapi) _dekFromDpapi = dek; // DPAPI 缺失时，解锁后亦启用自动填充
  return true;
}

function lock() {
  if (_dekFromMaster) { try { _dekFromMaster.fill(0); } catch (e) {} _dekFromMaster = null; }
  // 注意：不清除 _dekFromDpapi，自动填充不依赖主密码解锁
}

function isUnlocked() { return !!_dekFromMaster; }

// 写入（加密新密码）所需 DEK：优先主密码路径，退而 DPAPI 路径
function _getDekForWrite() { return _dekFromMaster || _dekFromDpapi; }

function listEntries() {
  var entries = store.get('entries') || [];
  return entries.map(function (e) {
    return {
      id: e.id, host: e.host, origin: e.origin,
      title: e.title, username: e.username, updatedAt: e.updatedAt
    };
  });
}

function _findEntryIndex(id) {
  var entries = store.get('entries') || [];
  for (var i = 0; i < entries.length; i++) { if (entries[i].id === id) return i; }
  return -1;
}

// 新增或按 host+username 更新
function addEntry(opts) {
  if (!opts || !opts.host || !opts.username || !opts.password) throw new Error('参数不完整');
  var dek = _getDekForWrite();
  if (!dek) throw new Error('密码本未解锁且 DPAPI 不可用');
  var entries = store.get('entries') || [];
  var idx = -1;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].host === opts.host && entries[i].username === opts.username) { idx = i; break; }
  }
  var now = Date.now();
  var entry = {
    id: idx >= 0 ? entries[idx].id : _genId(),
    host: opts.host,
    origin: opts.origin || ('https://' + opts.host),
    title: opts.title || opts.host,
    username: opts.username,
    passwordEnc: _encryptStr(dek, opts.password),
    createdAt: idx >= 0 ? entries[idx].createdAt : now,
    updatedAt: now
  };
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  store.set('entries', entries);
  return entry.id;
}

function updateEntry(id, fields) {
  var entries = store.get('entries') || [];
  var idx = _findEntryIndex(id);
  if (idx < 0) return false;
  var entry = entries[idx];
  if (fields.title !== undefined) entry.title = fields.title;
  if (fields.username !== undefined) entry.username = fields.username;
  if (fields.password !== undefined) {
    var dek = _getDekForWrite();
    if (!dek) throw new Error('密码本未解锁且 DPAPI 不可用');
    entry.passwordEnc = _encryptStr(dek, fields.password);
  }
  entry.updatedAt = Date.now();
  entries[idx] = entry;
  store.set('entries', entries);
  return true;
}

function deleteEntry(id) {
  var entries = store.get('entries') || [];
  entries = entries.filter(function (e) { return e.id !== id; });
  store.set('entries', entries);
  return true;
}

// 查看明文（需主密码解锁）
function getDecryptedPassword(id) {
  if (!_dekFromMaster) return null;
  var entries = store.get('entries') || [];
  var idx = _findEntryIndex(id);
  if (idx < 0) return null;
  return _decryptStr(_dekFromMaster, entries[idx].passwordEnc);
}

// 自动填充查询（用 DPAPI 路径 DEK，无需主密码）
function getEntriesForHost(host) {
  if (!_dekFromDpapi) return [];
  var entries = store.get('entries') || [];
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].host === host) {
      var pw = _decryptStr(_dekFromDpapi, entries[i].passwordEnc);
      if (pw !== null) out.push({ username: entries[i].username, password: pw });
    }
  }
  return out;
}

// 查询某 host 是否已有条目（含用户名列表，供捕获保存决策；不含明文）
function getMetaForHost(host) {
  var entries = store.get('entries') || [];
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].host === host) out.push({ id: entries[i].id, username: entries[i].username });
  }
  return out;
}

function changeMaster(oldPwd, newPwd) {
  if (!newPwd || newPwd.length < 4) throw new Error('新主密码至少 4 位');
  if (!unlockWithMaster(oldPwd)) return false;
  var dek = _dekFromMaster; // DEK 不变，只重新加密其主密码保护形态
  var salt = crypto.randomBytes(SALT_LEN);
  var kek = _deriveKek(newPwd, salt);
  store.set('salt', _b64(salt));
  store.set('dekMasterEnc', _encryptBuf(kek, dek));
  // dekDpapiEnc 不变（同一 DEK）
  return true;
}

function resetAll() {
  store.clear();
  if (_dekFromDpapi) { try { _dekFromDpapi.fill(0); } catch (e) {} _dekFromDpapi = null; }
  if (_dekFromMaster) { try { _dekFromMaster.fill(0); } catch (e) {} _dekFromMaster = null; }
  _initialized = false;
}

// 退出前清理内存
function dispose() {
  if (_dekFromMaster) { try { _dekFromMaster.fill(0); } catch (e) {} _dekFromMaster = null; }
}

module.exports = {
  init: init,
  isInitialized: isInitialized,
  dpapiAvailable: dpapiAvailable,
  setupMaster: setupMaster,
  unlockWithMaster: unlockWithMaster,
  lock: lock,
  isUnlocked: isUnlocked,
  listEntries: listEntries,
  addEntry: addEntry,
  updateEntry: updateEntry,
  deleteEntry: deleteEntry,
  getDecryptedPassword: getDecryptedPassword,
  getEntriesForHost: getEntriesForHost,
  getMetaForHost: getMetaForHost,
  changeMaster: changeMaster,
  resetAll: resetAll,
  dispose: dispose
};
