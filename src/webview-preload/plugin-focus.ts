/**
 * Plugin focus — runs in EVERY frame of a PPAPI tab.
 *
 * A PPAPI <embed> only receives keyboard input once it is the document's
 * activeElement. `webContents.focus()` hands focus to the top document only, so
 * keystrokes end up on `document.body` and the plugin never sees them (measured
 * on the real site: `first keydown tag=BODY`).
 *
 * The game sits in a CROSS-ORIGIN iframe (news.7k7k.com → web.7k7k.com), so the
 * main frame cannot reach the embed at all. This preload runs inside every frame
 * (`nodeIntegrationInSubFrames: true`) and focuses its OWN plugin.
 *
 * Why a synchronous IPC handshake instead of `postMessage`: measured with a
 * cross-origin fixture, a `message` event posted from the parent frame does NOT
 * reach a listener registered in the isolated preload world. Asking the main
 * process "is this tab the focused one?" is deterministic instead.
 *
 * Measured with a real SWF fixture: `embed.focus()` is enough — synthesized keys
 * then target the EMBED element. No synthetic mouse click is required.
 */

const QUESTION_CHANNEL = 'plugin-focus-allowed';
const ACK_CHANNEL = 'plugin-focus-ack';

/** Ads and decorative embeds are excluded by size; the game surface always wins. */
const MIN_PLUGIN_SIZE = 80;

/**
 * Portal pages insert the game iframe late, and the view's focus is dropped
 * while the new document commits (measured: isFocused() false ~200ms after the
 * navigation, true again once the shell re-asserts it on load). This window
 * therefore spans both events.
 */
const RETRY_DELAYS = [0, 400, 1000, 2000, 3500, 6000, 10000];

export interface PluginFocusResult {
  found: boolean;
  tag: string;
  focused: boolean;
  size: string;
}

interface IpcRendererLike {
  sendSync: (channel: string, ...args: unknown[]) => unknown;
  send: (channel: string, payload: unknown) => void;
}

function ipc(): IpcRendererLike | null {
  try {
    // Electron 11 preload runtime requires CommonJS here; a static import would
    // change module timing for the whole preload bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ipcRenderer } = require('electron') as typeof import('electron');
    return ipcRenderer as unknown as IpcRendererLike;
  } catch {
    return null;
  }
}

function isFlashLike(el: HTMLElement): boolean {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (!type) return true; // untagged embed/object — let the size gate decide
  return type.includes('shockwave') || type.includes('flash');
}

function findLargestPlugin(): { el: HTMLElement; size: string } | null {
  let best: HTMLElement | null = null;
  let bestArea = 0;
  let bestSize = '';
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('embed, object'))) {
    if (!isFlashLike(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_PLUGIN_SIZE || rect.height < MIN_PLUGIN_SIZE) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
      bestSize = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    }
  }
  return best ? { el: best, size: bestSize } : null;
}

export function focusPluginInThisFrame(): PluginFocusResult {
  const match = findLargestPlugin();
  if (!match) return { found: false, tag: '', focused: false, size: '' };
  const { el, size } = match;
  // Skip a redundant focus() when it is already active: re-focusing mid-typing
  // would cancel an in-progress IME composition inside the plugin.
  if (document.activeElement !== el) {
    if (el.tabIndex < 0) el.tabIndex = 0;
    el.focus();
  }
  return { found: true, tag: el.tagName, focused: document.activeElement === el, size };
}

/** true = stop retrying (focused, or nothing to focus in this frame). */
function attemptFocus(bridge: IpcRendererLike): boolean {
  // Never steal the caret from a real editable field the page focused itself
  // (login forms, in-page search). Only a "nobody is focused" state is ours.
  const active = document.activeElement as HTMLElement | null;
  const tag = active?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return true;
  const plugin = findLargestPlugin();
  if (!plugin) return false;
  let allowed = false;
  try {
    // The size lets the main process identify the owning iframe in the top
    // document and move the browser's focused FRAME down first.
    allowed = bridge.sendSync(QUESTION_CHANNEL, plugin.size) === true;
  } catch {
    return false;
  }
  // The view loses focus while the new document commits, so a "not now" answer
  // keeps retrying: the shell re-asserts focus once the page finished loading.
  if (!allowed) return false;
  // Deferred: focusing the parent iframe resets this document's activeElement to
  // <body>, so the embed must be focused AFTER the parent moved the focused frame.
  setTimeout(() => {
    try {
      const result = focusPluginInThisFrame();
      if (result.found) bridge.send(ACK_CHANNEL, result);
    } catch { /* diagnostics must never break the page */ }
  }, 150);
  return false;
}

export function installPluginFocusRelay(): void {
  const bridge = ipc();
  if (!bridge) return;
  const run = (index: number): void => {
    let done = false;
    try {
      done = attemptFocus(bridge);
    } catch { /* page DOM races must never break the tab */ }
    const next = index + 1;
    if (!done && next < RETRY_DELAYS.length) setTimeout(() => run(next), RETRY_DELAYS[next]);
  };
  const start = (): void => { run(0); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
