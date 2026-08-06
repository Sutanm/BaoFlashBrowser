// Isolated-world side of the D5 page-world bridge. `unsafeWindow` from the
// userscript sandbox is a Proxy that forwards reads/writes/calls to the page
// world over window.postMessage (see page-bridge.ts for the page-side half).
//
// Tier-1 semantics:
// - set: forwarded, the page world really receives the value (functions are
//   stringified because postMessage cannot clone them).
// - call: forwarded in strict order; results are cached per path so later
//   reads hit the cache.
// - get: cache hit returns the cached value; otherwise a path Wrapper is
//   returned (truthy, chainable). Synchronous reads of complex values are a
//   documented boundary — the wrapper is not the real value.
//
// Timing: the page bridge script registers its listener while the head is
// parsed, which may be AFTER document-start userscript code has already run.
// Operations issued before the handshake completes are queued and flushed in
// order once the bridge answers. The handshake is retried until
// BRIDGE_GRACE_MS elapses; if no bridge ever answers, the proxy goes dead and
// falls back to the isolated-world window (pre-bridge behaviour), keeping
// non-bridged pages unchanged.

const BRIDGE_GRACE_MS = 5000;
const HANDSHAKE_RETRY_MS = 50;

type Path = string[];

interface QueuedMessage {
  op: string;
  path: Path;
  args?: unknown[];
  seq: number;
}

function serializeArg(value: unknown): unknown {
  if (typeof value === 'function') return { __bfFn: Function.prototype.toString.call(value) };
  return value;
}

export function createUnsafeWindowProxy(window: Window): unknown {
  let seq = Math.floor(Math.random() * 1e9) + 1;
  let dead = false;
  let ready = false;
  let handshakeSeq = 0;
  const cache = new Map<string, unknown>();
  const pending = new Map<number, Path>();
  const expected = new Set<number>();
  const queue: QueuedMessage[] = [];

  const post = (op: string, path: Path, args: unknown[] | undefined, messageSeq: number): void => {
    const message: Record<string, unknown> = { __bf: 1, op, path, seq: messageSeq };
    if (args !== undefined) message.args = args;
    try {
      window.postMessage(message, '*');
    } catch {
      /* window is tearing down */
    }
  };

  const send = (op: string, path: Path, args?: unknown[]): number => {
    if (dead) return 0;
    seq += 1;
    if (op === 'call' || op === 'get' || op === 'keys') pending.set(seq, path);
    expected.add(seq);
    if (ready) {
      post(op, path, args, seq);
    } else {
      queue.push({ op, path, args, seq });
    }
    return seq;
  };

  // The handshake must never be queued: it exists to discover the bridge, so
  // it is posted directly and retried until the bridge answers or we go dead.
  const sendHandshake = (): number => {
    if (dead) return 0;
    seq += 1;
    expected.add(seq);
    post('handshake', [], undefined, seq);
    return seq;
  };

  window.addEventListener('message', (event) => {
    const msg = event.data as { __bf?: number; reply?: boolean; seq?: number; result?: unknown; err?: string | null } | null;
    // Only bridge replies are processed here. The proxy's own requests are
    // posted to the same window and would otherwise be treated as replies
    // (they lack `reply` and `err`, so the ready handshake would never fire
    // and the expected-set would be consumed before the real reply arrives).
    if (!msg || msg.__bf !== 1 || msg.reply !== true || typeof msg.seq !== 'number') return;
    if (!expected.has(msg.seq)) return;
    expected.delete(msg.seq);
    const path = pending.get(msg.seq);
    if (path) {
      if (msg.err !== 'clone-failed') cache.set(path.join('.'), msg.result);
      pending.delete(msg.seq);
    }
    if (msg.seq === handshakeSeq && msg.err === null) {
      ready = true;
      for (const queued of queue) post(queued.op, queued.path, queued.args, queued.seq);
      queue.length = 0;
    }
  });

  handshakeSeq = sendHandshake();
  const started = Date.now();
  const retryTimer = window.setInterval(() => {
    if (ready) {
      window.clearInterval(retryTimer);
      return;
    }
    if (Date.now() - started >= BRIDGE_GRACE_MS) {
      dead = true;
      queue.length = 0;
      window.clearInterval(retryTimer);
      return;
    }
    handshakeSeq = sendHandshake();
  }, HANDSHAKE_RETRY_MS);

  const makeWrapper = (path: Path): unknown =>
    // A function target makes the wrapper callable in addition to being an
    // object, so `unsafeWindow.fn()` works while `unsafeWindow.obj.key`
    // chaining also stays possible.
    new Proxy(function () { /* wrapper */ }, {
      get: (_target, key) => {
        if (dead) return Reflect.get(window, key);
        if (typeof key === 'symbol') return undefined;
        const name = String(key);
        // ToPrimitive coercion (String(wrapper), template literals, ==) must
        // not recurse into wrappers forever: toString yields the path so
        // diagnostics stay readable, valueOf returns the wrapper itself.
        if (name === 'toString') return () => `unsafeWindow(${[...path, name].join('.')})`;
        if (name === 'valueOf') return () => makeWrapper(path);
        const cacheKey = [...path, name].join('.');
        if (cache.has(cacheKey)) return cache.get(cacheKey);
        return makeWrapper([...path, name]);
      },
      set: (_target, key, value) => {
        if (dead) return Reflect.set(window, key, value);
        if (typeof key === 'symbol') return false;
        send('set', [...path, String(key)], [serializeArg(value)]);
        return true;
      },
      apply: (_target, _thisArg, args) => {
        if (dead) return undefined;
        send('call', path, args.map(serializeArg));
        return makeWrapper(path);
      },
      has: (_target, key) => {
        if (dead) return key in window;
        return typeof key === 'symbol' ? false : true;
      },
      deleteProperty: (_target, key) => {
        if (dead) return delete (window as unknown as Record<string, unknown>)[String(key)];
        if (typeof key === 'symbol') return false;
        send('del', [...path, String(key)]);
        return true;
      },
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
    });

  return makeWrapper([]);
}
