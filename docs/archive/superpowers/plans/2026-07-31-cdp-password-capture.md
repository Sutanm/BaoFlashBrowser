# CDP Password Capture + Password Manager Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate CDP-based password capture into BaoFlashBrowser with user-controlled save confirmation, master-password-protected password vault, and sidebar password management panel. Password plaintext never leaves main process.

**Architecture:** Main-process `password-capture.ts` attaches CDP to BrowserViews and injects capture scripts. Captured credentials are held in main-process memory keyed by `captureId`; renderer receives only `{ host, username, captureId }`. User-confirmed saves happen via IPC and write directly from main process to `password-store.ts` (AES-256-GCM encrypted). `activePanelAtom` (Jotai) allows any component to trigger sidebar navigation.

**Tech Stack:** Electron 11 (Chromium 87 CDP 1.3), React 17 + Jotai + Dexie, TypeScript 4.9

## Global Constraints

- Electron 11.5.0 locked (last PPAPI Flash support)
- Node 12.x built-in runtime
- All IPC channels must be added to preload whitelist (`ALLOWED_ON_CHANNELS` / `ALLOWED_INVOKE_CHANNELS`)
- `password-store.ts` existing public API must not change signatures — only add new exports
- Toast system uses existing `toastQueueAtom` + `pushToastAtom` queue
- Sidebar panels follow existing pattern (FavoritesPanel, HistoryPanel, etc.)
- CDP `debugger.attach` conflicts with DevTools — must handle `devtools-opened`/`devtools-closed`
- Password plaintext never sent to renderer process
- `_enabled` flag persists via a `meta` table key in password-store's electron-store

## Actual API Signatures (verified against source)

| Function | File:Line | Real Signature |
|----------|-----------|---------------|
| `setupMaster` | password-store.ts:80 | `async (password: string): Promise<boolean>` |
| `init` | password-store.ts:60 | `async (): Promise<void>` |
| `isInitialized` | password-store.ts:51 | `(): boolean` |
| `unlockWithMaster` | password-store.ts:116 | `(password: string): boolean` |
| `lock` | password-store.ts:127 | `(): void` |
| `isUnlocked` | password-store.ts:139 | `(): boolean` |
| `listEntries` | password-store.ts:147 | `(): EntryMeta[]` — **returns EntryMeta[], NO password field** |
| `addEntry` | password-store.ts:167 | `(opts: {host, username, password, origin?, title?}): string` |
| `deleteEntry` | password-store.ts:223 | `(id: string): boolean` |
| `getDecryptedPassword` | password-store.ts:229 | `(id: string): string \| null` |
| `getEntriesForHost` | password-store.ts:238 | `(host: string): {username: string; password: string}[]` |
| `getMetaForHost` | password-store.ts:252 | `(host: string): {id: string; username: string}[]` |
| `resetAll` | password-store.ts:291 | `(): void` |
| `dispose` | password-store.ts:304 | `(): void` |
| `dpapi.isAvailable` | dpapi.ts:21 | `(): boolean` |

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/main/modules/password-capture.ts` | CDP attach/detach (idempotent), script injection, credential extraction, in-memory pending store |
| `src/main/ipc/password.ipc.ts` | IPC handlers — all async handlers use `await`, captureId-based save flow |
| `src/renderer/components/panels/PasswordsPanel.tsx` | Password list UI — password fetched via `getDecryptedPassword(id)` per-entry |
| `src/renderer/hooks/usePasswordListener.ts` | Listen for `password:captured` → render toast with save/ignore buttons |
| `src/shared/types/passwords.ts` | `EntryMeta` (re-export), `PasswordStoreStatus`, `PendingCapture` types |
| `src/main/modules/tabs.ts` | Integration: call `setupCapture`/`teardownCapture` in tab lifecycle |
| `src/main/index.ts` | Import and call `registerPasswordIPC()`; call `passwordStore.init()` |
| `src/main/modules/password-store.ts` | Add `toggleEnabled()`, `setDefault(id)`, `isEnabled()`, persist `_enabled` |
| `src/preload/index.ts` | `pwd:` namespace methods + channel whitelist entries |
| `src/renderer/atoms/data.atom.ts` | `passwordsAtom`, `passwordStoreStatusAtom`, `activePanelAtom` |
| `src/renderer/App.tsx` | Call `usePasswordListener()`, use `activePanelAtom` for panel state |
| `src/renderer/components/layout/DrawerSidebar.tsx` | PANELS add "密码" (Key icon), render PasswordsPanel; use `activePanelAtom` |
| `src/renderer/components/layout/TopBar.tsx` | Refactor address bar toast from `<input>` to overlay `<div>`; action toasts don't update `addressValue` |
| `src/renderer/styles.css` | `.toast-overlay`, `.toast-actions`, `.pwd-*` panel styles |

---

### Task 1: Shared Types + Atom Definitions + activePanelAtom

**Files:**
- Create: `src/shared/types/passwords.ts`
- Modify: `src/renderer/atoms/data.atom.ts`

**Interfaces:**
- Produces: `PasswordEntry`, `PasswordStoreStatus`, `CaptureNotification` types
- Produces: `passwordsAtom`, `passwordStoreStatusAtom`, `activePanelAtom` Jotai atoms

- [ ] **Step 1: Create shared types file**

```typescript
// src/shared/types/passwords.ts

export interface PasswordEntry {
  id: string;
  host: string;
  origin: string;
  title: string;
  username: string;
  updatedAt: number;
  // Note: password-store.ts EntryMeta has no createdAt. Panel does not use createdAt.
}

export interface PasswordStoreStatus {
  initialized: boolean;
  unlocked: boolean;
  enabled: boolean;
  dpapiAvailable: boolean;
}

/** Sent from main → renderer via password:captured. Does NOT contain password. */
export interface CaptureNotification {
  captureId: string;
  host: string;
  username: string;
}

export type ActivePanel = 'favorites' | 'history' | 'downloads' | 'settings' | 'passwords' | null;
```

- [ ] **Step 2: Add atoms to data.atom.ts**

```typescript
// src/renderer/atoms/data.atom.ts
// Add imports at top:
import type { PasswordEntry, PasswordStoreStatus, ActivePanel } from '@shared/types/passwords';

// Add atoms after existing declarations:
export const passwordsAtom = atom<PasswordEntry[]>([]);
export const passwordStoreStatusAtom = atom<PasswordStoreStatus>({
  initialized: false,
  unlocked: false,
  enabled: false,
  dpapiAvailable: false,
});
export const activePanelAtom = atom<ActivePanel>(null);
```

- [ ] **Step 3: Build renderer to verify no type errors**

```bash
npx webpack --config webpack.renderer.config.js 2>&1 | Select-Object -Last 5
```

Expected: `compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/passwords.ts src/renderer/atoms/data.atom.ts
git commit -m "feat: add password types, atoms, and activePanelAtom"
```

---

### Task 2: Password Store Extensions

**Files:**
- Modify: `src/main/modules/password-store.ts`

**Interfaces:**
- Produces: `toggleEnabled(): boolean`, `setDefault(id: string): void`, `isEnabled(): boolean`
- Persists `_enabled` to electron-store meta table

- [ ] **Step 1: Verify current store structure for meta writes**

```bash
rg -n "store\.set\(" src/main/modules/password-store.ts | Select-Object -First 10
```

Expected: existing entries use `store.set('entries', ...)`, `store.set('salt', ...)`, `store.set('dekMasterEnc', ...)`, etc.

- [ ] **Step 2: Add new exports**

```typescript
// src/main/modules/password-store.ts
// Add these exports at the end of the file, before dispose():

let _enabled = true;

/**
 * Read enabled state from store meta on module load.
 * Called once during init() or manually in bootstrap.
 */
function _loadEnabled(): void {
  const val = store.get('_enabled');
  if (typeof val === 'boolean') _enabled = val;
}

function _saveEnabled(): void {
  store.set('_enabled', _enabled);
}

// Schema: add _enabled: boolean to PasswordStoreSchema interface + defaults._enabled = true

export function isEnabled(): boolean {
  return _enabled;
}

export function toggleEnabled(): boolean {
  _enabled = !_enabled;
  _saveEnabled();
  if (!_enabled) lock(); // disable → lock to clear in-memory DEKs
  return _enabled;
}

export function setDefault(id: string): void {
  const entries = store.get('entries') || [];
  const idx = entries.findIndex((e: StoredEntry) => e.id === id);
  if (idx < 0) return;
  entries[idx].updatedAt = Date.now();
  store.set('entries', entries);
}
```

- [ ] **Step 3: Call _loadEnabled in init()**

```typescript
// src/main/modules/password-store.ts, inside init():
export async function init(): Promise<void> {
  _loadEnabled();  // ← add as first line
  // ... existing code for DPAPI DEK loading ...
}
```

- [ ] **Step 4: Build main process**

```bash
npx webpack --config webpack.main.config.js 2>&1 | Select-Object -Last 5
```

Expected: `compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/password-store.ts
git commit -m "feat: add isEnabled/toggleEnabled/setDefault with persistence to password-store"
```

---

### Task 3: CDP Password Capture Module (idempotent, captureId-based)

**Files:**
- Create: `src/main/modules/password-capture.ts`

**Interfaces:**
- Produces: `setupCapture(wc: WebContents): void` — idempotent, safe to call multiple times
- Produces: `teardownCapture(wc: WebContents): void` — cleans all listeners and timers
- Produces: `getPendingCredential(captureId: string): {host, username, password, origin, title} \| null` — for save-confirm IPC
- Produces: `removePendingCredential(captureId: string): void`

- [ ] **Step 1: Create password-capture.ts**

```typescript
// src/main/modules/password-capture.ts
import { WebContents } from 'electron';  // TS syntax: import type not required — ts-loader handles .ts in main.config
import log from 'electron-log';
import { getMainWindow } from './window';

interface CaptureState {
  wc: WebContents;
  destroyed: boolean;
  injectTimer: ReturnType<typeof setTimeout> | null;
  contexts: Set<number>;
  capturedSet: Set<string>;
  /** captureId → {host, username, password, origin, title} — passwords NEVER leave main process */
  pendingCredentials: Map<string, { host: string; username: string; password: string; origin: string; title: string }>;
  /** event listener refs for cleanup */
  onDevtoolsOpen: () => void;
  onDevtoolsClose: () => void;
  onDebuggerMessage: (_event: any, method: string, params: any) => void;
}

const captures = new Map<number, CaptureState>();

function sendToRenderer(channel: string, payload: Record<string, unknown>): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

const CAPTURE_SCRIPT = `
(function() {
  if (window.__baop_pw_capture) return;
  window.__baop_pw_capture = true;

  var _rawUser = '';
  var _rawPass = '';

  function findUserInput(container) {
    var selectors = [
      'input[type="text"]', 'input[type="email"]', 'input[type="tel"]',
      'input[name*="user"]', 'input[name*="login"]', 'input[name*="account"]',
      'input[name*="username"]', 'input[name*="name"]',
      'input[id*="user"]', 'input[id*="login"]', 'input[id*="name"]',
      'input[autocomplete="username"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = container.querySelector(selectors[i]);
      if (el && el.value && el.type !== 'password' && el.type !== 'hidden') return el;
    }
    return null;
  }

  function report(source) {
    if (!_rawPass || _rawPass.length < 2) return;
    console.log(JSON.stringify({
      _type: 'baop_capture',
      user: _rawUser || '',
      pass: _rawPass,
      host: location.hostname,
      origin: location.href,
      title: document.title,
      source: source,
    }));
    _rawPass = '';
    _rawUser = '';
  }

  // Strategy A: capture phase form submit
  document.addEventListener('submit', function(e) {
    var pw = e.target.querySelector('input[type="password"]');
    if (!pw || !pw.value || pw.value.length < 2) return;
    var user = findUserInput(e.target);
    _rawUser = user ? user.value : '';
    _rawPass = pw.value;
    report('form-submit');
  }, true);

  // Strategy B: track raw password as user types; report on beforeunload
  var _pwInput = null;
  setInterval(function() {
    var pw = document.querySelector('input[type="password"]');
    if (pw !== _pwInput) {
      _pwInput = pw;
      if (pw && !pw.dataset.baopBound) {
        pw.dataset.baopBound = '1';
        var _p = pw;
        _p.addEventListener('input', function() {
          _rawPass = _p.value;
          var container = _p.closest('form') || _p.closest('[class*="login"]') || _p.closest('[class*="con"]') || _p.closest('[class*="pop"]') || document;
          var user = findUserInput(container);
          if (user) _rawUser = user.value;
        });
      }
    }
  }, 1000);

  // Strategy C: beforeunload = page refresh after login (7k7k pattern)
  window.addEventListener('beforeunload', function() {
    if (_rawPass && _rawPass.length >= 2) report('beforeunload');
  });
})()
`;

async function injectAllFrames(state: CaptureState): Promise<void> {
  if (state.destroyed || !state.wc || state.wc.isDestroyed()) return;
  const promises: Promise<void>[] = [];
  for (const ctxId of state.contexts) {
    promises.push(
      state.wc.debugger.sendCommand('Runtime.evaluate', {
        expression: CAPTURE_SCRIPT,
        awaitPromise: false,
        contextId: ctxId,
      }).catch(() => {})
    );
  }
  try { await Promise.all(promises); } catch {}
}

function attachDebugger(state: CaptureState): boolean {
  if (state.destroyed) return false;
  try { state.wc.debugger.attach('1.3'); return true; }
  catch (e: any) { log.warn('[PasswordCapture] attach failed:', e.message); return false; }
}

export function setupCapture(wc: WebContents): void {
  if (!wc || wc.isDestroyed()) return;

  // Idempotent: teardown any existing capture for this webContents
  if (captures.has(wc.id)) {
    teardownCapture(wc);
  }

  const state: CaptureState = {
    wc,
    destroyed: false,
    injectTimer: null,
    contexts: new Set(),
    capturedSet: new Set(),
    pendingCredentials: new Map(),
    onDevtoolsOpen: () => {},
    onDevtoolsClose: () => {},
    onDebuggerMessage: () => {},
  };

  if (!attachDebugger(state)) { captures.delete(wc.id); return; }

  // Wire debugger message listener
  state.onDebuggerMessage = (_event: any, method: string, params: any) => {
    if (state.destroyed) return;

    if (method === 'Runtime.executionContextCreated') {
      const ctxId = params.context.id;
      state.contexts.add(ctxId);
      wc.debugger.sendCommand('Runtime.evaluate', {
        expression: CAPTURE_SCRIPT,
        awaitPromise: false,
        contextId: ctxId,
      }).catch(() => {});
    }

    if (method === 'Runtime.executionContextDestroyed') {
      state.contexts.delete(params.executionContextId);
    }

    if (method !== 'Runtime.consoleAPICalled') return;
    const args = params.args || [];
    for (const arg of args) {
      const text = String(arg.value || '');
      if (!text.startsWith('{"_type":"baop_capture"')) continue;
      try {
        const data = JSON.parse(text);
        if (!data.user || !data.pass || data.pass.length < 2) continue;
        const key = `${data.host}/${data.user}`;
        if (state.capturedSet.has(key)) continue;
        // Limit capturedSet to 200 entries to prevent memory leak
        if (state.capturedSet.size > 200) {
          const first = state.capturedSet.values().next().value;
          if (first) state.capturedSet.delete(first);
        }
        state.capturedSet.add(key);

        // Generate captureId and store password in main process ONLY
        const captureId = 'cap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        state.pendingCredentials.set(captureId, {
          host: data.host,
          username: data.user,
          password: data.pass,
          origin: data.origin || '',
          title: data.title || '',
        });

        // Send renderer only host + username + captureId (NO password)
        sendToRenderer('password:captured', {
          captureId,
          host: data.host,
          username: data.user,
        });

        // Limit pending credentials to 50 entries, evict oldest
        if (state.pendingCredentials.size > 50) {
          const firstKey = state.pendingCredentials.keys().next().value;
          if (firstKey) state.pendingCredentials.delete(firstKey);
        }
      } catch {}
    }
  };
  wc.debugger.on('message', state.onDebuggerMessage);

  // Wire DevTools conflict handlers
  state.onDevtoolsOpen = () => {
    if (!state.destroyed) {
      try { wc.debugger.detach(); } catch {}
    }
  };
  state.onDevtoolsClose = () => {
    if (state.destroyed || state.wc.isDestroyed()) return;
    setTimeout(() => setupCapture(state.wc), 1000);
  };
  wc.on('devtools-opened', state.onDevtoolsOpen);
  wc.on('devtools-closed', state.onDevtoolsClose);

  // Enable Runtime domain and eager-inject main frame
  wc.debugger.sendCommand('Runtime.enable').then(() => {
    wc.debugger.sendCommand('Runtime.evaluate', {
      expression: CAPTURE_SCRIPT,
      awaitPromise: false,
    }).catch(() => {});
  }).catch(() => {});

  // Bulk injection schedule
  state.injectTimer = setTimeout(async () => {
    await injectAllFrames(state);
    state.injectTimer = setTimeout(() => injectAllFrames(state), 4000);
  }, 3000);

  captures.set(wc.id, state);
}

export function teardownCapture(wc: WebContents): void {
  if (!wc || wc.isDestroyed()) return;
  const state = captures.get(wc.id);
  if (!state) return;

  state.destroyed = true;

  // Clear timer
  if (state.injectTimer) clearTimeout(state.injectTimer);

  // Remove all event listeners
  try { wc.debugger.detach(); } catch {}
  wc.debugger.removeListener('message', state.onDebuggerMessage);
  wc.removeListener('devtools-opened', state.onDevtoolsOpen);
  wc.removeListener('devtools-closed', state.onDevtoolsClose);

  captures.delete(wc.id);
}

export function getPendingCredential(captureId: string): { host: string; username: string; password: string; origin: string; title: string } | null {
  for (const [, state] of captures) {
    if (state.pendingCredentials.has(captureId)) {
      return state.pendingCredentials.get(captureId)!;
    }
  }
  return null;
}

export function removePendingCredential(captureId: string): void {
  for (const [, state] of captures) {
    state.pendingCredentials.delete(captureId);
  }
}
```

- [ ] **Step 2: Build main process**

```bash
npx webpack --config webpack.main.config.js 2>&1 | Select-Object -Last 5
```

Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/main/modules/password-capture.ts
git commit -m "feat: add idempotent CDP password capture module with captureId-based flow"
```

---

### Task 4: Password IPC Handlers + Preload Bridge + Bootstrap init()

**Files:**
- Create: `src/main/ipc/password.ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces: `registerPasswordIPC()`
- Consumes: password-store exports, password-capture exports

- [ ] **Step 1: Create password IPC handlers**

```typescript
// src/main/ipc/password.ipc.ts
import log from 'electron-log';
import { createHandler } from '../utils/ipc-wrapper';
import {
  init, isInitialized, unlockWithMaster, lock, isUnlocked, setupMaster,
  addEntry, listEntries, deleteEntry,
  getDecryptedPassword,
  setDefault, toggleEnabled, isEnabled, dpapiAvailable,
} from '../modules/password-store';
import { getPendingCredential, removePendingCredential } from '../modules/password-capture';

export function registerPasswordIPC(): void {
  createHandler('password:status', () => ({
    initialized: isInitialized(),
    unlocked: isUnlocked(),
    enabled: isEnabled(),
    dpapiAvailable: dpapiAvailable(),
  }));

  createHandler('password:setup', async ({ password }: { password: string }) => {
    const ok = await setupMaster(password);
    return { success: ok };
  });

  createHandler('password:unlock', ({ password }: { password: string }) => {
    const ok = unlockWithMaster(password);
    return { success: ok };
  });

  createHandler('password:lock', () => {
    lock();
    return { success: true };
  });

  createHandler('password:toggle-enabled', async () => {
    const wasEnabled = isEnabled();
    const newState = toggleEnabled();
    if (!wasEnabled && newState) {
      try { await init(); } catch (e: any) { log.warn('[Password] re-init failed:', e.message); }
    }
    return { enabled: newState };
  });

  createHandler('password:list', () => {
    if (!isUnlocked()) return [];
    return listEntries();
  });

  createHandler('password:save-confirm', ({ captureId }: { captureId: string }) => {
    if (!isEnabled()) return { success: false, error: 'Password store is disabled' };
    if (!isUnlocked()) return { success: false, error: 'Password store is locked — unlock to save' };
    const cred = getPendingCredential(captureId);
    if (!cred) return { success: false, error: 'Credentials expired or not found' };
    try {
      addEntry({
        host: cred.host,
        username: cred.username,
        password: cred.password,
        origin: cred.origin || undefined,
        title: cred.title || undefined,
      });
      removePendingCredential(captureId);
      return { success: true };
    } catch (e: any) {
      log.error('[Password] save failed:', e.message);
      return { success: false, error: e.message };
    }
  });

  createHandler('password:ignore', ({ captureId }: { captureId: string }) => {
    removePendingCredential(captureId);
    return { success: true };
  });

  createHandler('password:delete', ({ id }: { id: string }) => {
    const ok = deleteEntry(id);
    return { success: ok };
  });

  createHandler('password:get-password', ({ id }: { id: string }) => {
    if (!isUnlocked()) return null;
    return getDecryptedPassword(id);
  });

  createHandler('password:set-default', ({ id }: { id: string }) => {
    setDefault(id);
    return { success: true };
  });

  log.info('[Password] IPC registered');
}
```

- [ ] **Step 2: Register in main/index.ts and call init()**

```typescript
// src/main/index.ts
// Add import near other IPC imports:
import { registerPasswordIPC } from './ipc/password.ipc';
import { init as initPasswordStore } from './modules/password-store';

// In app.whenReady(), add after registerDownloadIPC():
initPasswordStore().catch((e) => log.warn('[App] password store init failed:', e?.message));
registerPasswordIPC();
```

- [ ] **Step 3: Add preload bridge methods + whitelist channels**

In `src/preload/index.ts`:

```typescript
// Add to ALLOWED_ON_CHANNELS:
'password:captured',

// Add to ALLOWED_INVOKE_CHANNELS:
'password:status', 'password:setup', 'password:unlock', 'password:lock',
'password:toggle-enabled', 'password:list', 'password:save-confirm',
'password:ignore', 'password:delete', 'password:get-password', 'password:set-default',
```

```typescript
// In electronAPI object, after dl: { ... }, add:
pwd: {
  status: () => ipcRenderer.invoke('password:status'),
  setup: (password: string) => ipcRenderer.invoke('password:setup', { password }),
  unlock: (password: string) => ipcRenderer.invoke('password:unlock', { password }),
  lock: () => ipcRenderer.invoke('password:lock'),
  toggleEnabled: () => ipcRenderer.invoke('password:toggle-enabled'),
  list: () => ipcRenderer.invoke('password:list'),
  saveConfirm: (captureId: string) => ipcRenderer.invoke('password:save-confirm', { captureId }),
  ignore: (captureId: string) => ipcRenderer.invoke('password:ignore', { captureId }),
  delete: (id: string) => ipcRenderer.invoke('password:delete', { id }),
  getPassword: (id: string) => ipcRenderer.invoke('password:get-password', { id }),
  setDefault: (id: string) => ipcRenderer.invoke('password:set-default', { id }),
},
```

- [ ] **Step 4: Build both processes**

```bash
npx webpack --config webpack.main.config.js 2>&1 | Select-Object -Last 3
npx webpack --config webpack.renderer.config.js 2>&1 | Select-Object -Last 3
```

Expected: both `compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/password.ipc.ts src/preload/index.ts src/main/index.ts
git commit -m "feat: add async-safe password IPC handlers, preload bridge, and bootstrap init()"
```

---

### Task 5: tabs.ts Integration

**Files:**
- Modify: `src/main/modules/tabs.ts`

**Interfaces:**
- Consumes: `setupCapture(wc)`, `teardownCapture(wc)` from `password-capture.ts`

- [ ] **Step 1: Add import**

```typescript
// src/main/modules/tabs.ts, add at top:
import { setupCapture, teardownCapture } from './password-capture';
```

- [ ] **Step 2: Wire capture into did-stop-loading**

Find the `did-stop-loading` handler in `create()`. Add `setupCapture(wc)` call after existing logic:

```typescript
// inside create() → wc.on('did-stop-loading', ...):
wc.on('did-stop-loading', () => {
  this.send('tab:updated', { tabId, isLoading: false });
  // ... existing fallback for title/favicon ...
  setupCapture(wc);  // ← ADD THIS
});
```

Same pattern in `setRuffleMode()` → the new BrowserView's `did-stop-loading` handler (approximately tabs.ts:214). **Add `setupCapture(wc)` as the last line of the existing handler** (after the `this.send('tab:updated', { tabId, isLoading: false })` and existing title/favicon fallback block).

- [ ] **Step 3: Wire teardown into _destroyView**

```typescript
// inside _destroyView():
private _destroyView(tab: TabEntry): void {
  teardownCapture(tab.browserView.webContents);  // ← ADD as first line
  this.wcToId.delete(tab.browserView.webContents.id);
  // ... existing destroy logic ...
}
```

- [ ] **Step 4: Build main process**

```bash
npx webpack --config webpack.main.config.js 2>&1 | Select-Object -Last 3
```

Expected: `compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/tabs.ts
git commit -m "feat: integrate password capture into tab lifecycle"
```

---

### Task 6: Toast Overlay Refactor

**Files:**
- Modify: `src/renderer/components/layout/TopBar.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/atoms/data.atom.ts`

- [ ] **Step 1: Extend AddressToast type**

```typescript
// src/renderer/atoms/data.atom.ts
// Replace existing AddressToast interface:

export interface ToastAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface AddressToast {
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
  color?: string;
  /** ms before auto-dismiss. If null OR actions present, persists until user action. */
  duration?: number | null;
  actions?: ToastAction[];
}
```

- [ ] **Step 2: Refactor TopBar address bar area**

Replace the `<input>` element wrapper — wrap it with a relative div + toast overlay:

```tsx
// src/renderer/components/layout/TopBar.tsx
// Replace the existing <input> with:

<div style={{ position: 'relative', flex: 1 }}>
  <input
    ref={addressInputRef}
    type="text"
    value={addressValue}
    onChange={(e) => setAddressValue(e.target.value)}
    onKeyDown={handleAddressKeyDown}
    placeholder="输入网址或搜索..."
    className="input-text no-drag"
    spellCheck={false}
    autoComplete="off"
  />
  {currentToast && (
    <div
      className={`toast-overlay ${flipping ? 'address-flip' : ''}`}
      style={{
        background: toastColor || (
          currentToast.type === 'success' ? '#27ae60'
          : currentToast.type === 'info' ? '#3498db'
          : currentToast.type === 'warning' ? '#f39c12'
          : '#e74c3c'
        ),
      }}
    >
      <span style={{ flex: 1 }}>{currentToast.message}</span>
      {currentToast.actions && (
        <div className="toast-actions">
          {currentToast.actions.map((action, i) => (
            <button
              key={i}
              className={action.primary ? 'toast-btn-primary' : ''}
              onClick={(e) => { e.stopPropagation(); action.onClick(); }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )}
</div>
```

- [ ] **Step 3: Update the toast animation effect**

Replace the existing `useEffect` that handles toast animation:

```typescript
// TopBar.tsx — replace existing toast animation useEffect:
const currentToast = toastQueue[0];
// Note: setToastQueue is already declared in TopBar (existing line ~82). Reuse it — do NOT add a second declaration.

useEffect(() => {
  const toast = currentToast;
  if (!toast) {
    prevHadToastRef.current = false;
    return;
  }
  clearTimeout(toastTimerRef.current);

  if (!prevHadToastRef.current) {
    savedUrlRef.current = addressValue;
  }
  prevHadToastRef.current = true;

  const bg = toast.color || (
    toast.type === 'success' ? '#27ae60'
    : toast.type === 'info' ? '#3498db'
    : toast.type === 'warning' ? '#f39c12'
    : '#e74c3c'
  );

  // Action toasts: persistent, don't touch addressValue
  if (toast.actions && toast.actions.length > 0) {
    setToastColor(bg);
    return; // No auto-dismiss — action.onClick() will shift the queue
  }

  // Normal auto-dismiss toast: flip animation
  setFlipping(true);
  setTimeout(() => {
    setAddressValue(toast.message);
    setToastColor(bg);
    setFlipping(false);
  }, 150);

  const duration = typeof toast.duration === 'number' ? toast.duration : 1500;
  toastTimerRef.current = setTimeout(() => {
    setFlipping(true);
    setTimeout(() => {
      setAddressValue(savedUrlRef.current);
      setToastColor(null);
      setFlipping(false);
      setToastQueue((prev: AddressToast[]) => prev.slice(1));
    }, 150);
  }, duration);

  return () => clearTimeout(toastTimerRef.current);
}, [currentToast, setToastQueue]);
```

- [ ] **Step 4: Add CSS styles**

```css
/* src/renderer/styles.css — add after the .address-flip keyframes */

.toast-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-radius: 8px;
  z-index: 10;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
}

.toast-actions {
  display: flex;
  gap: 6px;
  margin-left: 12px;
  flex-shrink: 0;
}
.toast-actions button {
  padding: 3px 10px;
  border: 1px solid rgba(255,255,255,.4);
  border-radius: 4px;
  background: rgba(255,255,255,.15);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.toast-actions button:hover {
  background: rgba(255,255,255,.3);
}
.toast-actions .toast-btn-primary {
  background: rgba(255,255,255,.35);
  border-color: rgba(255,255,255,.6);
  font-weight: 600;
}
```

- [ ] **Step 5: Clean up TopBarProps (remove stale items)**

The TopBarProps interface does NOT need a `toast` prop (TopBar reads `toastQueueAtom` directly). No changes needed.

- [ ] **Step 6: Build renderer**

```bash
npx webpack --config webpack.renderer.config.js 2>&1 | Select-Object -Last 5
```

Expected: `compiled successfully`

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/layout/TopBar.tsx src/renderer/styles.css src/renderer/atoms/data.atom.ts
git commit -m "feat: refactor address bar toast to overlay div with action buttons"
```

---

### Task 7: Password Listener Hook

**Files:**
- Create: `src/renderer/hooks/usePasswordListener.ts`

**Interfaces:**
- Consumes: `password:captured` IPC event (receive `{ captureId, host, username }` only)
- Consumes: `activePanelAtom` for navigating to password panel
- Consumes: `pushToastAtom`, `toastQueueAtom`

- [ ] **Step 1: Create usePasswordListener.ts**

```typescript
// src/renderer/hooks/usePasswordListener.ts
import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { pushToastAtom, passwordStoreStatusAtom, activePanelAtom, toastQueueAtom } from '@renderer/atoms/data.atom';
import type { CaptureNotification } from '@shared/types/passwords';
import type { AddressToast } from '@renderer/atoms/data.atom';

export function usePasswordListener(): void {
  const pushToast = useSetAtom(pushToastAtom);
  const setStoreStatus = useSetAtom(passwordStoreStatusAtom);
  const setActivePanel = useSetAtom(activePanelAtom);
  const setToastQueue = useSetAtom(toastQueueAtom);

  // Query store status on mount
  useEffect(() => {
    (window as any).electronAPI?.pwd?.status().then((s: any) => {
      if (s) setStoreStatus(s);
    }).catch(() => {});
  }, [setStoreStatus]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;

    const unsub = api.on('password:captured', (data: CaptureNotification) => {
      const { captureId, host } = data;

      // Query current store status
      api.pwd?.status().then((s: any) => {
        if (!s || !s.initialized) {
          // Not set up — guide user to enable
          pushToast({
            message: '检测到登录信息，可启用密码本保存',
            type: 'info',
            actions: [{
              label: '启用密码本',
              primary: true,
              onClick: () => {
                setActivePanel('passwords');
                // Don't ignore yet — user will set up master pw and can then save via panel
              },
            }, {
              label: '忽略',
              onClick: () => { api.pwd?.ignore(captureId); },
            }],
          });
          return;
        }

        if (!s.enabled) {
          api.pwd?.ignore(captureId); // Clean up — no save, but don't leak
          return;
        }

        // Queue: show save confirmation
        pushToast({
          message: `为 ${host} 保存密码？`,
          type: 'info',
          actions: [{
            label: '保存',
            primary: true,
            onClick: async () => {
              await api.pwd?.saveConfirm(captureId);
              // Remove this toast from queue
              setToastQueue((prev: AddressToast[]) => prev.slice(1));
            },
          }, {
            label: '忽略',
            onClick: () => {
              api.pwd?.ignore(captureId);
              setToastQueue((prev: AddressToast[]) => prev.slice(1));
            },
          }],
        });
      }).catch(() => {});
    });

    return () => { if (unsub) unsub(); };
  }, [pushToast, setStoreStatus, setActivePanel, setToastQueue]);
}
```

- [ ] **Step 2: Build renderer**

```bash
npx webpack --config webpack.renderer.config.js 2>&1 | Select-Object -Last 5
```

Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/usePasswordListener.ts
git commit -m "feat: add password capture listener hook with activePanelAtom navigation"
```

---

### Task 8: Passwords Sidebar Panel

**Files:**
- Create: `src/renderer/components/panels/PasswordsPanel.tsx`

**Interfaces:**
- Consumes: `pwd.*` preload methods
- EntryMeta (from password-store `listEntries()`) has NO `password` field — must call `getDecryptedPassword(id)` per-entry

- [ ] **Step 1: Create PasswordsPanel.tsx**

```typescript
// src/renderer/components/panels/PasswordsPanel.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { Trash2, Copy, Key } from 'lucide-react';
import type { PasswordEntry } from '@shared/types/passwords';

function maskMiddle(str: string, keepStart: number, keepEnd: number): string {
  if (str.length <= keepStart + keepEnd + 2) return str;
  return str.slice(0, keepStart) + '******' + str.slice(-keepEnd);
}

interface StoreStatus { initialized: boolean; unlocked: boolean; enabled: boolean; dpapiAvailable: boolean; }

const PasswordsPanel: React.FC = () => {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [entries, setEntries] = useState<PasswordEntry[]>([]);
  const [unlockPwd, setUnlockPwd] = useState('');
  const [setupPwd, setSetupPwd] = useState('');
  const [setupPwd2, setSetupPwd2] = useState('');
  const [unlockError, setUnlockError] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  /** entry id → decrypted password (fetched on demand) */
  const [decryptedPasswords, setDecryptedPasswords] = useState<Map<string, string>>(new Map());

  const api = (window as any).electronAPI?.pwd;

  const refreshStatus = useCallback(async () => {
    if (!api) return;
    const s: StoreStatus = await api.status();
    setStatus(s);
    if (s.unlocked) {
      const list: PasswordEntry[] = await api.list();
      setEntries(list);
    } else {
      setEntries([]);
      setDecryptedPasswords(new Map());
    }
  }, [api]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const handleUnlock = async () => {
    const result = await api.unlock(unlockPwd);
    if (result.success) { setUnlockError(false); refreshStatus(); }
    else { setUnlockError(true); }
  };

  const handleSetup = async () => {
    if (setupPwd !== setupPwd2) { setSetupError('两次密码不一致'); return; }
    if (setupPwd.length < 8) { setSetupError('密码至少 8 位'); return; }
    if (!/[A-Z]/.test(setupPwd) || !/[a-z]/.test(setupPwd) || !/\d/.test(setupPwd)) {
      setSetupError('密码需包含大写、小写和数字'); return;
    }
    const result = await api.setup(setupPwd);
    if (result.success) { setSetupError(''); refreshStatus(); }
    else { setSetupError(result.error || '设置失败'); }
  };

  const handleToggleEnabled = async () => {
    await api.toggleEnabled();
    refreshStatus();
  };

  const handleDelete = async (id: string) => {
    await api.delete(id);
    refreshStatus();
  };

  const handleTogglePassword = async (id: string) => {
    if (decryptedPasswords.has(id)) {
      setDecryptedPasswords((prev) => { const m = new Map(prev); m.delete(id); return m; });
    } else {
      const pwd = await api.getPassword(id);
      if (pwd) {
        setDecryptedPasswords((prev) => new Map(prev).set(id, pwd));
      }
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const toggleHost = (host: string) => {
    setExpandedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(host)) next.delete(host); else next.add(host);
      return next;
    });
  };

  if (!status) return <div className="sidebar-empty">加载中...</div>;

  // Not set up
  if (!status.initialized) {
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ textAlign: 'center', paddingTop: 24 }}>
          <Key className="w-8 h-8" style={{ color: 'var(--text-secondary)', margin: '0 auto' }} />
          <p style={{ marginTop: 8, fontSize: 14, color: 'var(--text-primary)' }}>尚未设置主密码</p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>设置后可保存和查看密码</p>
        </div>
        <input type="password" className="input-text" placeholder="设置主密码 (8位, 含大小写+数字)" value={setupPwd}
          onChange={(e) => setSetupPwd(e.target.value)} style={{ width: '100%' }} />
        <input type="password" className="input-text" placeholder="确认主密码" value={setupPwd2}
          onChange={(e) => setSetupPwd2(e.target.value)} style={{ width: '100%' }} />
        {setupError && <span style={{ color: '#e74c3c', fontSize: 12 }}>{setupError}</span>}
        <button onClick={handleSetup} className="btn-secondary" style={{ width: '100%' }}>设置主密码</button>
      </div>
    );
  }

  // Locked
  if (!status.unlocked) {
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="pwd-settings-bar">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={status.enabled} onChange={handleToggleEnabled} />
            启用密码本
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="password" className="input-text" placeholder="输入主密码解锁" value={unlockPwd}
            onChange={(e) => setUnlockPwd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
            style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={handleUnlock}>解锁</button>
        </div>
        {unlockError && <span style={{ color: '#e74c3c', fontSize: 12 }}>密码错误</span>}
      </div>
    );
  }

  // Unlocked
  const grouped = new Map<string, PasswordEntry[]>();
  for (const e of entries) {
    const arr = grouped.get(e.host) || [];
    arr.push(e);
    grouped.set(e.host, arr);
  }
  for (const [, arr] of grouped) {
    arr.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const hosts = [...grouped.keys()].sort();

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div className="pwd-settings-bar" style={{ borderBottom: '1px solid var(--border-light)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={status.enabled} onChange={handleToggleEnabled} />
          启用密码本
        </label>
        <button className="btn-secondary" onClick={async () => { await api.lock(); refreshStatus(); }}
          style={{ marginLeft: 'auto', fontSize: 12, padding: '2px 8px' }}>锁定</button>
      </div>
      {hosts.length === 0 ? (
        <div className="sidebar-empty">暂无保存的密码</div>
      ) : (
        hosts.map((host) => {
          const items = grouped.get(host)!;
          // Most recent entry is the "default" for autofill
          const defaultId = items[0]?.id;
          return (
            <div key={host} className="pwd-host-group">
              <div className="pwd-host-header" onClick={() => toggleHost(host)}>
                <span>{expandedHosts.has(host) ? '▾' : '▸'} {host}</span>
              </div>
              {expandedHosts.has(host) && items.map((entry) => (
                <div key={entry.id} className="pwd-entry" style={{ padding: '6px 12px 6px 24px', fontSize: 13 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: 'var(--text-primary)' }}>
                      {status.unlocked ? entry.username : maskMiddle(entry.username, 3, 2)}
                    </span>
                    {entry.id === defaultId && <span style={{ fontSize: 10, color: '#f39c12' }}>★</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 80 }}>
                      {decryptedPasswords.has(entry.id) ? decryptedPasswords.get(entry.id) : '••••••••'}
                    </span>
                    <button className="btn-secondary" style={{ fontSize: 11, padding: '1px 6px' }}
                      onClick={() => handleTogglePassword(entry.id)}>
                      {decryptedPasswords.has(entry.id) ? '隐藏' : '查看'}
                    </button>
                    {decryptedPasswords.has(entry.id) && (
                      <button className="btn-secondary" style={{ fontSize: 11, padding: '1px 6px' }}
                        onClick={() => handleCopy(decryptedPasswords.get(entry.id)!)}>
                        <Copy className="w-3 h-3" />
                      </button>
                    )}
                    <button className="btn-secondary" style={{ fontSize: 11, padding: '1px 6px' }}
                      onClick={async () => { await api.setDefault(entry.id); refreshStatus(); }}>
                      设为默认
                    </button>
                    <button className="btn-secondary" style={{ fontSize: 11, padding: '1px 6px', color: '#e74c3c' }}
                      onClick={() => handleDelete(entry.id)}>
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
};

export default PasswordsPanel;
```

- [ ] **Step 2: Build renderer**

```bash
npx webpack --config webpack.renderer.config.js 2>&1 | Select-Object -Last 5
```

Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/panels/PasswordsPanel.tsx
git commit -m "feat: add password management sidebar panel with per-entry decryption"
```

---

### Task 9: Sidebar + App Integration

**Files:**
- Modify: `src/renderer/components/layout/DrawerSidebar.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Update DrawerSidebar — remove activePanel/onTogglePanel props, use atom directly**

DrawerSidebar currently receives `activePanel` and `onTogglePanel` as **props from App.tsx**. Change it to read/write the Jotai atom directly.

```typescript
// src/renderer/components/layout/DrawerSidebar.tsx
// Add imports:
import { Key } from 'lucide-react';
import { useAtom } from 'jotai';
import { activePanelAtom } from '@renderer/atoms/data.atom';
import PasswordsPanel from '../panels/PasswordsPanel';

// Inside DrawerSidebarProps interface, REMOVE these two lines:
//   activePanel: ... | null;
//   onTogglePanel: (panel: ...) => void;

// Inside DrawerSidebar component destructuring, REMOVE:
//   activePanel, onTogglePanel,

// Inside DrawerSidebar component body, ADD:
const [activePanel, setActivePanel] = useAtom(activePanelAtom);

// Replace all onTogglePanel(id) calls with setActivePanel(id)
// Replace all onTogglePanel(panel) calls with:
//   setActivePanel((v) => v === panel ? null : panel)
// Find: onClose={() => setActivePanel(null)} — keep as-is (already correct)
// (activePanel/onTogglePanel props are removed from DrawerSidebarProps — no need to update their types)
const PANELS = [
  { id: 'favorites' as const, label: '收藏夹', icon: Star },
  { id: 'history' as const, label: '历史记录', icon: Clock },
  { id: 'downloads' as const, label: '下载', icon: Download },
  { id: 'passwords' as const, label: '密码', icon: Key },
  { id: 'settings' as const, label: '设置', icon: SettingsIcon },
];

// (activePanel/onTogglePanel props removed — see Step 1 above)

// Add panel rendering:
{activePanel === 'passwords' && <PasswordsPanel />}
```

- [ ] **Step 2: Update App.tsx — use activePanelAtom, remove props to DrawerSidebar, add listener**

```typescript
// src/renderer/App.tsx
// Add imports:
import { useAtom } from 'jotai';
import { activePanelAtom } from './atoms/data.atom';
import { usePasswordListener } from './hooks/usePasswordListener';

// Replace the local useState for activePanel:
// REMOVE: const [activePanel, setActivePanel] = useState<...>(null);
// ADD:
const [activePanel, setActivePanel] = useAtom(activePanelAtom);

// REMOVE these props from the DrawerSidebar JSX:
//   activePanel={activePanel}
//   onTogglePanel={(panel) => setActivePanel((v) => v === panel ? null : panel)}
// (DrawerSidebar now reads them from the atom)

// Add hook call:
usePasswordListener();
```

- [ ] **Step 3: Build renderer**

```bash
npx webpack --config webpack.renderer.config.js 2>&1 | Select-Object -Last 5
```

Expected: `compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/layout/DrawerSidebar.tsx src/renderer/App.tsx
git commit -m "feat: integrate password panel into sidebar with activePanelAtom"
```

---

### Task 10: Panel Styles + Full Build

**Files:**
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Add password panel CSS**

```css
/* src/renderer/styles.css — add at end */

.pwd-settings-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.pwd-host-group {
  border-bottom: 1px solid var(--border-light);
}

.pwd-host-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}
.pwd-host-header:hover {
  background: var(--bg-hover);
}
```

- [ ] **Step 2: Run full build**

```bash
npx webpack --config webpack.main.config.js 2>&1 | Select-Object -Last 3
npx webpack --config webpack.renderer.config.js 2>&1 | Select-Object -Last 3
```

Expected: both `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat: add password panel styles"
```

---

## Self-Review v4

### API signature verification:

| Plan usage | Actual source | Match? |
|-----------|---------------|:---:|
| `await setupMaster(password)` returns `Promise<boolean>` | password-store.ts:80 | ✅ |
| `await init()` returns `Promise<void>` | password-store.ts:60 | ✅ |
| `isInitialized()` returns `boolean` | password-store.ts:51 | ✅ |
| `unlockWithMaster(password)` returns `boolean` | password-store.ts:116 | ✅ |
| `lock()` returns `void` | password-store.ts:127 | ✅ |
| `getDecryptedPassword(id)` returns `string \| null` | password-store.ts:229 | ✅ |
| `addEntry(opts)` returns `string` | password-store.ts:167 | ✅ |
| `createHandler(channel, fn)` exists | ipc-wrapper.ts:5 | ✅ |

### Critical fixes vs v3:

| Issue | Fix | Verified? |
|-------|-----|:---:|
| P1-1 removeListener 调错对象 | `wc.debugger.removeListener` | ✅ |
| P1-2 disabled 凭据孤儿 | `api.pwd?.ignore(captureId)` | ✅ |
| P1-3 DrawerSidebar prop/atom 双源 | Props removed, atom-only | ✅ |
| P1-4 createHandler 约定 | All 11 handlers use `createHandler()` | ✅ |
| P1-5 origin/title 丢弃 | `pendingCredentials` + `save-confirm` full chain | ✅ |
| P2-1 username display | `status.unlocked ? entry.username : maskMiddle(...)` | ✅ |
| P2-6 unused imports | Only `init/isInitialized/setupMaster/addEntry/...` imported | ✅ |
| P2-7 setToastQueue reuse | Note to reuse existing declaration | ✅ |
| P2-8 setRuffleMode clarity | Explicit "add as last line of existing handler" | ✅ |
| P2-9 captureId not-initialized recovery | `ignore(captureId)` called; panel refresh re-queries status | ✅ |
