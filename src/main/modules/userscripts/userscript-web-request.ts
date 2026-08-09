// GM_webRequest OBSERVATION-ONLY observer.
// Never intercepts or modifies requests: before-request events are dispatched
// from session-manager's SINGLE onBeforeRequest listener (Electron 11 webRequest
// listeners replace each other on re-registration, so only one may exist);
// onCompleted / onErrorOccurred are unoccupied and registered here directly.
// Events are filtered by the script's @match rules and URLs are redacted.

import { compileRules, matchesUrl } from './userscript-matcher';
import { redactUrlForLog } from './userscript-request';
import type { GmWebRequestEvent } from '../../../shared/userscript-types';

export interface WebRequestRegistration {
  wcId: number;
  documentId: string;
  scriptId: string;
}

export interface WebRequestObserver {
  attach(sess: Electron.Session): void;
  notifyBeforeRequest(details: { url: string; method: string; webContentsId: number }): void;
  register(r: WebRequestRegistration): void;
  unregister(wcId: number, documentId: string, scriptId: string): void;
  /** Drop every registration belonging to a destroyed view. */
  unregisterForWc(wcId: number): void;
  setMatch(scriptId: string, rules: { match: string[]; include: string[]; exclude: string[]; excludeMatch: string[] }): void;
  clearMatches(): void;
  setSend(send: (wcId: number, channel: string, payload: unknown) => void): void;
}

export function createWebRequestObserver(): WebRequestObserver {
  const registrations = new Map<string, WebRequestRegistration>();
  const matches = new Map<string, ReturnType<typeof compileRules>>();
  let send: (wcId: number, channel: string, payload: unknown) => void = () => {};
  let attached = false;

  const dispatch = (
    phase: GmWebRequestEvent['phase'],
    details: { url: string; method: string; webContentsId: number; statusCode?: number; error?: string },
  ): void => {
    for (const [, reg] of Array.from(registrations)) {
      if (reg.wcId !== details.webContentsId) continue;
      const rules = matches.get(reg.scriptId);
      if (!rules || !matchesUrl(rules, details.url)) continue;
      const event: GmWebRequestEvent = {
        phase,
        url: redactUrlForLog(details.url),
        method: details.method,
        statusCode: details.statusCode,
        error: details.error,
      };
      try {
        send(reg.wcId, 'userscript:web-request-event', { scriptId: reg.scriptId, documentId: reg.documentId, event });
      } catch {
        // View gone: drop every registration belonging to this wc (lazy cleanup).
        for (const [k, r] of registrations) {
          if (r.wcId === reg.wcId) registrations.delete(k);
        }
      }
    }
  };

  return {
    attach(sess) {
      if (attached) return;
      attached = true;
      sess.webRequest.onCompleted({ urls: ['*://*/*'] }, (details: Electron.OnCompletedListenerDetails) => {
        dispatch('completed', {
          url: String(details.url ?? ''),
          method: String(details.method ?? ''),
          webContentsId: Number(details.webContentsId),
          statusCode: details.statusCode,
        });
      });
      sess.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details: Electron.OnErrorOccurredListenerDetails) => {
        dispatch('error-occurred', {
          url: String(details.url ?? ''),
          method: String(details.method ?? ''),
          webContentsId: Number(details.webContentsId),
          error: String(details.error ?? ''),
        });
      });
    },
    notifyBeforeRequest(details) {
      dispatch('before-request', details);
    },
    register(r) {
      registrations.set(`${r.wcId}:${r.documentId}:${r.scriptId}`, r);
    },
    unregister(wcId, documentId, scriptId) {
      registrations.delete(`${wcId}:${documentId}:${scriptId}`);
    },
    unregisterForWc(wcId) {
      for (const [key, r] of registrations) {
        if (r.wcId === wcId) registrations.delete(key);
      }
    },
    setMatch(scriptId, rules) {
      matches.set(scriptId, compileRules(rules));
    },
    clearMatches() {
      matches.clear();
    },
    setSend(fn) {
      send = fn;
    },
  };
}
