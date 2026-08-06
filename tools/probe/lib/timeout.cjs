// Probe toolkit — timeout primitives. Every wait in this toolkit MUST go
// through these helpers so no probe can hang past its budget (the original
// pain: smoke scripts hanging until a 5-minute default timeout killed them).
'use strict';

const DEFAULT_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT) || 90_000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Race a promise against a timeout. Rejects with a clear label on expiry.
function withTimeout(promise, ms, label) {
  const budget = ms === undefined ? DEFAULT_TIMEOUT_MS : ms;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label || 'operation'} timed out after ${budget}ms`));
    }, budget);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// Poll `fn` (sync or promise) until truthy or the budget expires.
async function waitFor(fn, { timeoutMs, intervalMs = 200, label = 'condition' } = {}) {
  const budget = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  const deadline = Date.now() + budget;
  let last;
  for (;;) {
    last = await Promise.resolve(fn());
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(`${label} not satisfied within ${budget}ms (last: ${String(last)})`);
    }
    await wait(intervalMs);
  }
}

// Host-level watchdog: arms a global timer that force-exits the process so a
// buggy probe can never hang the whole run past the budget.
function createWatchdog(ms = DEFAULT_TIMEOUT_MS) {
  let timer = null;
  return {
    arm() {
      timer = setTimeout(() => {
        console.error(`[probe] WATCHDOG: run exceeded ${ms}ms, forcing exit (set SMOKE_TIMEOUT to raise)`);
        process.exit(3);
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    },
    disarm() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { DEFAULT_TIMEOUT_MS, wait, withTimeout, waitFor, createWatchdog };
