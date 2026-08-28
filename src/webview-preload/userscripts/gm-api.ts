// GM API construction. All APIs are injected lexically into the script
// execution scope; nothing is placed on the page global.
// Mirrors the planned src/webview-preload/userscripts/gm-api.ts.

import type { GMSerializable, GmCookie, GmWebRequestEvent, SnapshotScript } from '../../shared/userscript-types';
import { isSerializableValue } from '../../main/modules/userscripts/userscript-values';
import type { GmRequestDetails, GmRequestResult } from '../../main/modules/userscripts/userscript-request-service';

export interface GmApiBridge {
  send(channel: string, payload: unknown): void;
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

export interface GmApiContext {
  script: SnapshotScript;
  documentId: string;
  isMainFrame: boolean;
  values: Record<string, GMSerializable>;
  resources?: Record<string, { text: string; url: string }>;
  bridge: GmApiBridge;
  /** Flash runtime the tab is running: 'ppapi' (native Flash) or 'ruffle'. */
  flashRuntime: 'ppapi' | 'ruffle';
}

export interface GmApi {
  getValue(key: string, fallback?: unknown): unknown;
  setValue(key: string, value: unknown): void;
  deleteValue(key: string): void;
  listValues(): string[];
  getValues(): Record<string, GMSerializable>;
  getResourceText(name: string): string | undefined;
  getResourceURL(name: string): string | undefined;
  addStyle(css: string): HTMLElement;
  addElement: (...args: unknown[]) => HTMLElement;
  registerMenuCommand(title: string, callback: () => void): number;
  unregisterMenuCommand(commandId: number): void;
  openInTab(url: string, openInBackground?: boolean): void;
  xmlhttpRequest(details: GmRequestDetails): { abort(): void };
  download(details: string | { url?: string; name?: string; onload?: () => void; onerror?: () => void; onprogress?: () => void }): { abort(): void };
  addValueChangeListener(key: string, callback: (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void): number;
  removeValueChangeListener(listenerId: number): void;
  setClipboard(text: string, info?: unknown): void;
  notification(details: string | { text?: string; title?: string; onclick?: () => void }): void;
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
  cookie: {
    list(details: { url?: string; domain?: string; name?: string }, ondone: (cookies: GmCookie[]) => void): void;
    get(details: { url: string; name: string }, ondone: (cookie: GmCookie | null) => void): void;
  };
  webRequest(details: {
    onBeforeRequest?: (event: GmWebRequestEvent) => void;
    onCompleted?: (event: GmWebRequestEvent) => void;
    onErrorOccurred?: (event: GmWebRequestEvent) => void;
  }): void;
  baoAutomation: {
    listPackages(): Promise<Array<{ packageId: string; name: string; assets: string[] }>>;
    match(packageId: string, asset: string, options?: { threshold?: number; scales?: number[]; mask?: 'auto' | 'none' | 'alpha' }): Promise<unknown>;
    status(): Promise<unknown>;
    start(packageId: string, countdownMs?: number): Promise<unknown>;
    cancel(): Promise<unknown>;
    warmup(packageId: string, asset?: string): Promise<unknown>;
    assetPreview(packageId: string, asset: string): Promise<unknown>;
    captureFrame(): Promise<unknown>;
    saveCapture(packageId: string, token: string, asset: string, rect: { x: number; y: number; width: number; height: number }, overwrite?: boolean): Promise<unknown>;
    detectGameSurfaces(): Promise<unknown>;
    bindGameSurface(candidateId: string): Promise<unknown>;
    clearGameSurface(): Promise<unknown>;
    beginCoordinatePick(): Promise<unknown>;
    endCoordinatePick(): Promise<unknown>;
  };
  handleWebRequestEvent(event: GmWebRequestEvent): void;
  info: Record<string, unknown>;
  handleMenuInvoke(commandId: number): boolean;
  handleValueChanged(key: string, oldValue: unknown, newValue: unknown): void;
  handleNotificationClick(documentId: string, notificationId: number): void;
  legacy: Record<string, unknown>;
}

export interface GrantedGmApi {
  modern: Record<string, unknown>;
  legacy: Record<string, unknown>;
  info: Record<string, unknown> | undefined;
  unsafeWindow: boolean;
}

// Metadata permissions are an execution boundary, not merely UI metadata.
// Accept both classic (`GM_getValue`) and modern (`GM.getValue`) spellings,
// while exposing privileged capabilities only when the script declared them.
export function grantGmApi(api: GmApi, rawGrants: string[] | undefined): GrantedGmApi {
  const grants = new Set((rawGrants ?? []).map((grant) => String(grant).trim()));
  const allowed = (legacy: string, modern: string): boolean =>
    grants.has(legacy) || grants.has(`GM.${modern}`);
  const modern: Record<string, unknown> = {};
  const legacy: Record<string, unknown> = {};
  const expose = (legacyName: string, modernName: string, value: unknown, aliases: string[] = []): void => {
    if (!allowed(legacyName, modernName)) return;
    legacy[legacyName] = value;
    modern[modernName] = value;
    for (const alias of aliases) modern[alias] = value;
  };

  expose('GM_getValue', 'getValue', api.getValue);
  expose('GM_setValue', 'setValue', api.setValue);
  expose('GM_deleteValue', 'deleteValue', api.deleteValue);
  expose('GM_listValues', 'listValues', api.listValues);
  expose('GM_getValues', 'getValues', api.getValues);
  expose('GM_getResourceText', 'getResourceText', api.getResourceText);
  expose('GM_getResourceURL', 'getResourceUrl', api.getResourceURL, ['getResourceURL']);
  expose('GM_addStyle', 'addStyle', api.addStyle);
  expose('GM_addElement', 'addElement', api.addElement);
  expose('GM_registerMenuCommand', 'registerMenuCommand', api.registerMenuCommand);
  expose('GM_unregisterMenuCommand', 'unregisterMenuCommand', api.unregisterMenuCommand);
  expose('GM_openInTab', 'openInTab', api.openInTab);
  expose('GM_xmlhttpRequest', 'xmlHttpRequest', api.xmlhttpRequest, ['xmlhttpRequest']);
  expose('GM_download', 'download', api.download);
  expose('GM_addValueChangeListener', 'addValueChangeListener', api.addValueChangeListener);
  expose('GM_removeValueChangeListener', 'removeValueChangeListener', api.removeValueChangeListener);
  expose('GM_setClipboard', 'setClipboard', api.setClipboard);
  expose('GM_notification', 'notification', api.notification);
  expose('GM_cookie', 'cookie', api.cookie);
  expose('GM_webRequest', 'webRequest', api.webRequest);
  if (grants.has('GM_baoAutomation')) modern.baoAutomation = api.baoAutomation;

  // Compatibility baseline: these two APIs are non-privileged. GM_info is
  // read-only script/runtime metadata, and GM_log is already rate-limited in
  // the main process. Older userscripts commonly use both without @grant.
  legacy.GM_log = api.log;
  modern.log = api.log;
  modern.info = api.info;
  return {
    modern,
    legacy,
    info: api.info,
    unsafeWindow: grants.has('unsafeWindow'),
  };
}

function applyAttributes(element: HTMLElement, attributes: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'function') {
      element.addEventListener(key, value as EventListener);
    } else if (value !== undefined && value !== null) {
      element.setAttribute(key, String(value));
    }
  }
}

export function createGmApi(context: GmApiContext): GmApi {
  const { script, documentId, isMainFrame, values, resources, bridge, flashRuntime } = context;
  let nextCommandId = 1;
  const menuCallbacks = new Map<number, () => void>();
  let openedTabCount = 0;

  const getValue = (key: string, fallback?: unknown): unknown => {
    const keyText = String(key);
    return keyText in values ? values[keyText] : fallback;
  };

  const setValue = (key: string, value: unknown): void => {
    if (!isSerializableValue(value)) return;
    const keyText = String(key);
    const oldValue = values[keyText];
    values[keyText] = value;
    bridge.send('userscript:set-value', { scriptId: script.id, key: keyText, value });
    fireLocalValueListeners(keyText, oldValue, value, false);
  };

  const deleteValue = (key: string): void => {
    const keyText = String(key);
    const oldValue = values[keyText];
    delete values[keyText];
    bridge.send('userscript:delete-value', { scriptId: script.id, key: keyText });
    fireLocalValueListeners(keyText, oldValue, undefined, false);
  };

  const listValues = (): string[] => Object.keys(values);

  const getValues = (): Record<string, GMSerializable> => ({ ...values });

  // --- value change listeners ------------------------------------------------
  const valueListeners = new Map<number, { key: string; callback: (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void }>();
  let nextListenerId = 1;

  function fireLocalValueListeners(key: string, oldValue: unknown, newValue: unknown, remote: boolean): void {
    for (const entry of valueListeners.values()) {
      if (entry.key !== key) continue;
      try {
        entry.callback(key, oldValue, newValue, remote);
      } catch { /* listener errors are isolated */ }
    }
  }

  const addValueChangeListener = (
    key: string,
    callback: (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void,
  ): number => {
    const listenerId = nextListenerId++;
    valueListeners.set(listenerId, { key: String(key), callback });
    bridge.send('userscript:value-listener-add', { scriptId: script.id, key: String(key), listenerId });
    return listenerId;
  };

  const removeValueChangeListener = (listenerId: number): void => {
    valueListeners.delete(listenerId);
    bridge.send('userscript:value-listener-remove', { scriptId: script.id, listenerId });
  };

  const handleValueChanged = (key: string, oldValue: unknown, newValue: unknown): void => {
    fireLocalValueListeners(key, oldValue, newValue, true);
  };

  // --- clipboard / notification ----------------------------------------------
  const setClipboard = (text: string, _info?: unknown): void => {
    void bridge.invoke('userscript:set-clipboard', {
      scriptId: script.id,
      text: String(text ?? '').slice(0, 1024 * 1024),
    });
  };

  // --- GM_log ---------------------------------------------------------------
  const log = (message: string, level?: 'info' | 'warn' | 'error'): void => {
    bridge.send('userscript:log', {
      scriptId: script.id,
      level: level ?? 'info',
      message: String(message ?? '').slice(0, 4000),
    });
  };

  const baoAutomation = {
    listPackages: async (): Promise<Array<{ packageId: string; name: string; assets: string[] }>> => {
      const result = await bridge.invoke('userscript:automation-list', { scriptId: script.id });
      return Array.isArray(result) ? result as Array<{ packageId: string; name: string; assets: string[] }> : [];
    },
    match: (packageId: string, asset: string, options?: { threshold?: number; scales?: number[]; mask?: 'auto' | 'none' | 'alpha' }): Promise<unknown> =>
      bridge.invoke('userscript:automation-match', { scriptId: script.id, packageId, asset, options: options ?? {} }),
    status: (): Promise<unknown> => bridge.invoke('userscript:automation-status', { scriptId: script.id }),
    start: (packageId: string, countdownMs = 0): Promise<unknown> =>
      bridge.invoke('userscript:automation-start', { scriptId: script.id, packageId, countdownMs }),
    cancel: (): Promise<unknown> => bridge.invoke('userscript:automation-cancel', { scriptId: script.id }),
    warmup: (packageId: string, asset?: string): Promise<unknown> =>
      bridge.invoke('userscript:automation-warmup', { scriptId: script.id, packageId, asset }),
    assetPreview: (packageId: string, asset: string): Promise<unknown> =>
      bridge.invoke('userscript:automation-asset-preview', { scriptId: script.id, packageId, asset }),
    captureFrame: (): Promise<unknown> => bridge.invoke('userscript:automation-capture-frame', { scriptId: script.id }),
    saveCapture: (packageId: string, token: string, asset: string, rect: { x: number; y: number; width: number; height: number }, overwrite = false): Promise<unknown> =>
      bridge.invoke('userscript:automation-save-capture', { scriptId: script.id, packageId, token, asset, rect, overwrite }),
    detectGameSurfaces: (): Promise<unknown> => bridge.invoke('userscript:automation-game-surfaces', { scriptId: script.id }),
    bindGameSurface: (candidateId: string): Promise<unknown> => bridge.invoke('userscript:automation-game-surface-bind', { scriptId: script.id, candidateId }),
    clearGameSurface: (): Promise<unknown> => bridge.invoke('userscript:automation-game-surface-clear', { scriptId: script.id }),
    beginCoordinatePick: (): Promise<unknown> => bridge.invoke('userscript:automation-coordinate-begin', { scriptId: script.id }),
    endCoordinatePick: (): Promise<unknown> => bridge.invoke('userscript:automation-coordinate-end', { scriptId: script.id }),
  };

  // --- GM_webRequest (OBSERVATION ONLY: no interception, no modification) ----
  let webRequestCallbacks: Partial<Record<GmWebRequestEvent['phase'], (event: GmWebRequestEvent) => void>> | null = null;

  const webRequest = (details: {
    onBeforeRequest?: (event: GmWebRequestEvent) => void;
    onCompleted?: (event: GmWebRequestEvent) => void;
    onErrorOccurred?: (event: GmWebRequestEvent) => void;
  }): void => {
    webRequestCallbacks = {
      'before-request': details?.onBeforeRequest,
      completed: details?.onCompleted,
      'error-occurred': details?.onErrorOccurred,
    };
    bridge.send('userscript:web-request-register', { scriptId: script.id, documentId });
  };

  const handleWebRequestEvent = (event: GmWebRequestEvent): void => {
    const cb = webRequestCallbacks?.[event?.phase];
    try { if (cb) cb(event); } catch { /* isolated */ }
  };

  // --- GM_cookie (READ-ONLY: list/get only; host gated by @connect) ----------
  const cookie = {
    list: (details: { url?: string; domain?: string; name?: string }, ondone: (cookies: GmCookie[]) => void): void => {
      void bridge.invoke('userscript:cookie-list', {
        scriptId: script.id,
        pageUrl: String(window.location.href || ''),
        url: details?.url,
        domain: details?.domain,
        name: details?.name,
      }).then((raw) => {
        const result = raw as { ok: boolean; cookies?: GmCookie[] };
        ondone(Array.isArray(result?.cookies) ? result.cookies : []);
      });
    },
    get: (details: { url: string; name: string }, ondone: (cookie: GmCookie | null) => void): void => {
      void bridge.invoke('userscript:cookie-get', {
        scriptId: script.id,
        pageUrl: String(window.location.href || ''),
        url: details?.url,
        name: details?.name,
      }).then((raw) => {
        const result = raw as { ok: boolean; cookie?: GmCookie | null };
        ondone(result?.cookie ?? null);
      });
    },
  };

  // --- GM_download ------------------------------------------------------------
  const downloadCallbacks = new Map<number, { onload?: () => void; onerror?: () => void; onprogress?: () => void }>();
  let nextDownloadId = 1;

  const download = (
    detailsOrUrl: string | { url?: string; name?: string; onload?: () => void; onerror?: () => void; onprogress?: () => void },
  ): { abort(): void } => {
    const raw = typeof detailsOrUrl === 'string' ? { url: detailsOrUrl } : (detailsOrUrl || {});
    const localId = nextDownloadId++;
    const callbacks = {
      onload: typeof raw.onload === 'function' ? raw.onload : undefined,
      onerror: typeof raw.onerror === 'function' ? raw.onerror : undefined,
      onprogress: typeof raw.onprogress === 'function' ? raw.onprogress : undefined,
    };
    downloadCallbacks.set(localId, callbacks);
    void bridge.invoke('userscript:download', {
      scriptId: script.id,
      localId,
      pageUrl: String(window.location.href || ''),
      details: { url: raw.url, name: raw.name },
    }).then((rawResult) => {
      const pending = downloadCallbacks.get(localId);
      if (!pending) return; // aborted before the result arrived
      downloadCallbacks.delete(localId);
      const result = rawResult as { ok: boolean; error?: string; fileName?: string; status?: number };
      if (result.ok) {
        if (pending.onload) pending.onload();
      } else if (pending.onerror) {
        pending.onerror();
      }
    }).catch(() => {
      const pending = downloadCallbacks.get(localId);
      if (!pending) return;
      downloadCallbacks.delete(localId);
      if (pending.onerror) pending.onerror();
    });
    return {
      abort: () => {
        const pending = downloadCallbacks.get(localId);
        if (pending) {
          downloadCallbacks.delete(localId);
          if (pending.onerror) pending.onerror();
        }
        bridge.send('userscript:download-abort', { scriptId: script.id, localId });
      },
    };
  };

  const notificationCallbacks = new Map<number, () => void>();
  const notify = (detailsOrText: string | { text?: string; title?: string; onclick?: () => void }): void => {
    const details = typeof detailsOrText === 'string' ? { text: detailsOrText } : (detailsOrText || {});
    const onclick = typeof details.onclick === 'function' ? details.onclick : undefined;
    void bridge.invoke('userscript:notification', {
      scriptId: script.id,
      documentId,
      text: String(details.text ?? ''),
      title: String(details.title ?? ''),
    }).then((raw) => {
      const notificationId = Number((raw as { notificationId?: number })?.notificationId);
      if (Number.isInteger(notificationId) && onclick) notificationCallbacks.set(notificationId, onclick);
    });
  };

  const handleNotificationClick = (targetDocumentId: string, notificationId: number): void => {
    if (targetDocumentId !== documentId) return;
    const callback = notificationCallbacks.get(notificationId);
    if (!callback) return;
    try {
      callback();
    } catch { /* isolated */ }
  };

  const getResourceText = (name: string): string | undefined => resources?.[String(name)]?.text;
  const getResourceURL = (name: string): string | undefined => resources?.[String(name)]?.url;

  const addStyle = (css: string): HTMLElement => {
    const style = document.createElement('style');
    style.setAttribute('data-userscript-style', script.id);
    style.textContent = String(css);
    (document.head || document.documentElement).appendChild(style);
    return style;
  };

  const addElement = (...args: unknown[]): HTMLElement => {
    const parent: HTMLElement | null =
      args.length >= 3 && args[0] instanceof Element ? (args[0] as HTMLElement) : null;
    const tagName = String(parent ? args[1] : args[0]);
    const attributes = (parent ? args[2] : args[1]) as Record<string, unknown> | undefined;
    const element = document.createElement(tagName);
    if (attributes && typeof attributes === 'object') applyAttributes(element, attributes);
    if (parent) parent.appendChild(element);
    else (document.body || document.documentElement).appendChild(element);
    return element;
  };

  const registerMenuCommand = (title: string, callback: () => void): number => {
    // Local id is scoped per document; the full commandId is prefixed with
    // documentId and scriptId so it is unique across frames, documents and
    // scripts without a main-process round trip.
    const localId = nextCommandId++;
    const commandId = `${documentId}:${script.id}:${localId}`;
    menuCallbacks.set(localId, callback);
    bridge.send('userscript:menu-register', {
      commandId,
      scriptId: script.id,
      documentId,
      isMainFrame,
      title: String(title).slice(0, 200),
    });
    return localId;
  };

  const unregisterMenuCommand = (commandId: number): void => {
    menuCallbacks.delete(commandId);
    bridge.send('userscript:menu-unregister', { commandId: `${documentId}:${script.id}:${commandId}` });
  };

  const openInTab = (url: string, _openInBackground?: boolean): void => {
    if (openedTabCount >= 10) return;
    let target = '';
    try { target = new URL(String(url), window.location.href).toString(); } catch { return; }
    openedTabCount += 1;
    bridge.send('userscript:open-in-tab', { scriptId: script.id, url: target.slice(0, 2048) });
  };

  // --- GM_xmlhttpRequest -----------------------------------------------------
  const xhrPending = new Map<number, Record<string, ((event: Record<string, unknown>) => void) | undefined>>();
  let nextXhrId = 1;

  function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function buildGmResponse(
    response: { finalUrl: string; status: number; statusText: string; headers: Record<string, string>; responseText: string; responseBase64?: string },
    responseType: string | undefined,
  ): Record<string, unknown> {
    const event: Record<string, unknown> = {
      readyState: 4,
      status: response.status,
      statusText: response.statusText,
      finalUrl: response.finalUrl,
      responseHeaders: response.headers,
    };
    if (responseType === 'arraybuffer' && response.responseBase64) {
      const bytes = base64ToBytes(response.responseBase64);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      event.response = buffer;
    } else if (responseType === 'blob' && response.responseBase64) {
      const bytes = base64ToBytes(response.responseBase64);
      const contentType = typeof response.headers['content-type'] === 'string'
        ? String(response.headers['content-type'])
        : undefined;
      event.response = new Blob([bytes as unknown as BlobPart], contentType ? { type: contentType } : undefined);
    } else {
      event.responseText = response.responseText;
      event.response = response.responseText;
      if (responseType === 'json') {
        try {
          event.responseJSON = JSON.parse(response.responseText);
        } catch {
          event.responseJSON = null;
        }
      }
    }
    return event;
  }

  const xmlhttpRequest = (details: GmRequestDetails): { abort(): void } => {
    const localId = nextXhrId++;
    const callbacks: Record<string, ((event: Record<string, unknown>) => void) | undefined> = {};
    const detailRecord = details as unknown as Record<string, unknown>;
    for (const name of ['onload', 'onerror', 'onabort', 'ontimeout', 'onreadystatechange']) {
      const candidate = detailRecord[name];
      if (typeof candidate === 'function') callbacks[name] = candidate as (event: Record<string, unknown>) => void;
    }
    xhrPending.set(localId, callbacks);
    // Callbacks are not serializable over IPC; strip them from the wire payload.
    const wireDetails: Record<string, unknown> = {};
    for (const key of ['method', 'url', 'headers', 'data', 'responseType', 'timeout']) {
      if (details[key as keyof GmRequestDetails] !== undefined) wireDetails[key] = details[key as keyof GmRequestDetails];
    }
    void bridge.invoke('userscript:xhr-request', {
      scriptId: script.id,
      localId,
      pageUrl: String(window.location.href || ''),
      details: wireDetails,
    }).then((raw) => {
      const pending = xhrPending.get(localId);
      if (!pending) return; // aborted before the result arrived
      xhrPending.delete(localId);
      const result = raw as GmRequestResult;
      const event = (result.response && buildGmResponse(result.response, details.responseType)) || {
        readyState: 4,
        status: 0,
        error: result.error,
        errorMessage: result.errorMessage,
      };
      if (pending.onreadystatechange) pending.onreadystatechange(event);
      if (result.ok && result.response) {
        if (pending.onload) pending.onload(event);
      } else if (result.error === 'timeout') {
        if (pending.ontimeout) pending.ontimeout(event);
      } else if (result.error === 'aborted') {
        if (pending.onabort) pending.onabort(event);
      } else if (pending.onerror) {
        pending.onerror(event);
      }
    }).catch((error: unknown) => {
      const pending = xhrPending.get(localId);
      if (!pending) return;
      xhrPending.delete(localId);
      const event = { readyState: 4, status: 0, error: 'network', errorMessage: error instanceof Error ? error.message : String(error) };
      if (pending.onerror) pending.onerror(event);
    });
    return {
      abort: () => {
        const pending = xhrPending.get(localId);
        if (pending) {
          xhrPending.delete(localId);
          if (pending.onabort) pending.onabort({ readyState: 0, status: 0, error: 'aborted' });
        }
        bridge.send('userscript:xhr-abort', { scriptId: script.id, localId });
      },
    };
  };

  const handleMenuInvoke = (commandId: number): boolean => {
    const callback = menuCallbacks.get(commandId);
    if (!callback) return false;
    try {
      callback();
    } catch {
      // menu callback errors are isolated like script errors
    }
    bridge.send('userscript:menu-invoked', { scriptId: script.id, documentId, commandId: `${documentId}:${script.id}:${commandId}` });
    return true;
  };

  const gm = {
    getValue,
    setValue,
    deleteValue,
    listValues,
    getValues,
    getResourceText,
    getResourceURL,
    addStyle,
    addElement,
    registerMenuCommand,
    unregisterMenuCommand,
    openInTab,
    xmlhttpRequest,
    download,
    addValueChangeListener,
    removeValueChangeListener,
    setClipboard,
    notification: notify,
    log,
    cookie,
    webRequest,
    baoAutomation,
    info: {
      // Which Flash engine this tab runs: 'ppapi' (native Flash) or 'ruffle'.
      // Scripts can branch behavior (e.g. skip/adapt DOM patches that only make
      // sense under one runtime).
      flashRuntime,
      script: {
        name: script.info?.name ?? script.id,
        namespace: script.info?.namespace ?? '',
        version: script.info?.version ?? '',
        description: script.info?.description ?? '',
        runAt: script.runAt,
        grant: script.info?.grant ?? [],
        noframes: script.info?.noframes ?? false,
      },
      scriptMetaStr: script.info?.rawHeader ?? '',
      scriptSource: script.source,
      scriptUpdateURL: '',
      scriptWillUpdate: false,
      scriptHandler: 'BaoFlashBrowser Userscript Demo Runtime',
      scriptVersion: script.info?.version ?? '',
      version: '1.0.0-demo',
    },
  };

  return {
    ...gm,
    handleMenuInvoke,
    handleValueChanged,
    handleNotificationClick,
    handleWebRequestEvent,
    legacy: {
      GM_getValue: getValue,
      GM_setValue: setValue,
      GM_deleteValue: deleteValue,
      GM_listValues: listValues,
      GM_getValues: getValues,
      GM_getResourceText: getResourceText,
      GM_getResourceURL: getResourceURL,
      GM_addStyle: addStyle,
      GM_addElement: addElement,
      GM_registerMenuCommand: registerMenuCommand,
      GM_unregisterMenuCommand: unregisterMenuCommand,
      GM_openInTab: openInTab,
      GM_xmlhttpRequest: xmlhttpRequest,
      GM_download: download,
      GM_addValueChangeListener: addValueChangeListener,
      GM_removeValueChangeListener: removeValueChangeListener,
      GM_setClipboard: setClipboard,
      GM_notification: notify,
      GM_log: (m: unknown, l?: unknown) => log(String(m ?? ''), (['info', 'warn', 'error'] as const).includes(l as 'info') ? (l as 'info' | 'warn' | 'error') : undefined),
      GM_cookie: cookie,
      GM_webRequest: webRequest,
    },
  };
}
