// Page-world bridge (D5). PAGE_BRIDGE_SOURCE is injected into the page MAIN
// world as early as document-start (inlined by the fixture server in the demo;
// via CDP Page.addScriptToEvaluateOnNewDocument in the real product). The
// isolated preload world cannot reach the page world directly, so unsafeWindow
// traffic is forwarded over window.postMessage and executed synchronously on
// the page side, which keeps call ordering strict.
//
// Protocol: requests and replies share { __bf: 1, seq, ... }. The bridge only
// answers messages whose event.source is its own window and whose op it knows.
// seq starts from a random offset on the caller side, so a page script cannot
// forge a reply that the isolated world would accept.
//
// The bridge holds no credentials and no Node access; a hostile page can do
// nothing through it that it could not do with the plain window object.

export const BRIDGE_MARKER = '__bfBridge';

export const PAGE_BRIDGE_SOURCE = `(function () {
  var MARKER = ${JSON.stringify(BRIDGE_MARKER)};
  if (window[MARKER] && window[MARKER].ready) return;
  function resolvePath(path) {
    var target = window;
    var last = null;
    for (var i = 0; i < path.length; i++) {
      var key = path[i];
      if (key == null || target == null) return { target: null, key: null, broken: true };
      last = target;
      target = target[key];
    }
    return { target: last, key: path.length ? path[path.length - 1] : null, broken: false };
  }
  function restoreArg(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.__bfFn !== undefined) {
      try {
        // eslint-disable-next-line no-new-func
        return Function('return (' + value.__bfFn + ')')();
      } catch (_e) {
        return undefined;
      }
    }
    return value;
  }
  function dispatch(op, path, args) {
    var r = resolvePath(path);
    if (r.broken) return undefined;
    if (window.__bfDiag) {
      window.__bfDiag.last = { op: op, path: path.slice(-2), err: null };
    }
    if (op === 'get') return r.target == null ? undefined : r.target[r.key];
    if (op === 'set') {
      try {
        if (r.target != null) r.target[r.key] = restoreArg(args[0]);
      } catch (error) {
        if (window.__bfDiag) window.__bfDiag.last.err = String((error && error.message) || error);
      }
      return undefined;
    }
    if (op === 'del') { if (r.target != null) delete r.target[r.key]; return undefined; }
    if (op === 'call') {
      var fn = r.target == null ? undefined : r.target[r.key];
      if (typeof fn !== 'function') return undefined;
      var callArgs = [];
      for (var i = 0; i < (args || []).length; i++) callArgs.push(restoreArg(args[i]));
      try {
        return fn.apply(r.target, callArgs);
      } catch (error) {
        if (window.__bfDiag) window.__bfDiag.last.err = String((error && error.message) || error);
        return undefined;
      }
    }
    if (op === 'keys') {
      var obj = r.target == null ? undefined : r.target[r.key];
      if (obj == null) return [];
      return Object.keys(obj);
    }
    if (op === 'handshake') return { ready: true, marker: MARKER };
    return undefined;
  }
  window.addEventListener('message', function (event) {
    var msg = event.data;
    // Replies are posted to the same window, so this listener would see its
    // own replies as well. Without this guard every reply would be treated as
    // a request and trigger another reply — an unbounded message loop.
    if (!msg || msg.__bf !== 1 || msg.reply) return;
    if (window.__bfDiag) {
      window.__bfDiag.count = (window.__bfDiag.count || 0) + 1;
      window.__bfDiag.sourceOk = event.source === window;
      window.__bfDiag.sourceType = typeof event.source;
      window.__bfDiag.ops = window.__bfDiag.ops || {};
      window.__bfDiag.ops[msg.op] = (window.__bfDiag.ops[msg.op] || 0) + 1;
    }
    if (event.source !== window) return;
    var result;
    var err = null;
    try {
      result = dispatch(msg.op, msg.path, msg.args);
    } catch (error) {
      err = String((error && error.message) || error);
      result = undefined;
    }
    try {
      window.postMessage({ __bf: 1, reply: true, seq: msg.seq, result: result, err: err }, '*');
    } catch (_cloneError) {
      window.postMessage({ __bf: 1, reply: true, seq: msg.seq, result: undefined, err: 'clone-failed' }, '*');
    }
  });
  window[MARKER] = { ready: true, id: Math.random().toString(36).slice(2) };
  window.__bfDiag = { injected: true };
})();`;
