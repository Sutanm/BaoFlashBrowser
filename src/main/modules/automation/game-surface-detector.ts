import { createHash } from 'crypto';
import type { WebContents } from 'electron';
import { acquireCdpLease } from '../cdp-lease';

export type GameSurfaceKind = 'flash' | 'ruffle' | 'canvas' | 'frame';

export type GameSurfaceCandidate = {
  id: string;
  fingerprint: string;
  kind: GameSurfaceKind;
  label: string;
  frameDepth: number;
  frameUrl: string;
  source: string;
  rect: { x: number; y: number; width: number; height: number };
  score: number;
};

type FrameRecord = { id: string; parentId?: string; url: string; depth: number };
type AttachedTarget = { sessionId: string; targetId: string; url: string };
type FrameMetrics = { width: number; height: number };
type OwnerRect = { x: number; y: number; width: number; height: number };
type LocalCandidate = {
  tag: string; kind: GameSurfaceKind; source: string; label: string; path: string;
  rect: { x: number; y: number; width: number; height: number };
};
type FlattenedNode = {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  parentId?: number;
  attributes?: string[];
  documentURL?: string;
  children?: FlattenedNode[];
  contentDocument?: FlattenedNode;
  shadowRoots?: FlattenedNode[];
  templateContent?: FlattenedNode;
};

const DETECT_EXPRESSION = `(() => {
  const visible = (element, rect) => {
    const style = getComputedStyle(element);
    return rect.width >= 80 && rect.height >= 60 && style.display !== 'none'
      && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const clean = (value) => String(value || '').slice(0, 600);
  const pathOf = (element) => {
    const parts = []; let node = element;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + node.id; parts.unshift(part); break; }
      let index = 1; let sibling = node;
      while ((sibling = sibling.previousElementSibling)) if (sibling.tagName === node.tagName) index += 1;
      parts.unshift(part + ':nth-of-type(' + index + ')'); node = node.parentElement;
    }
    return parts.join('>');
  };
  const results = [];
  const elements = []; const seen = new Set();
  const add = (element) => { if (element && !seen.has(element)) { seen.add(element); elements.push(element); } };
  try { document.querySelectorAll('embed,object,ruffle-player,ruffle-embed,canvas').forEach(add); } catch {}
  for (const name of ['embed', 'object', 'ruffle-player', 'ruffle-embed', 'canvas']) {
    try { Array.from(document.getElementsByTagName(name)).forEach(add); } catch {}
    try { Array.from(document.getElementsByTagNameNS('*', name)).forEach(add); } catch {}
  }
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (!visible(element, rect)) continue;
    const tag = element.tagName.toLowerCase();
    const type = clean(element.getAttribute('type')).toLowerCase();
    const source = clean(element.getAttribute('src') || element.getAttribute('data')
      || element.querySelector?.('param[name="movie" i]')?.getAttribute('value'));
    let kind = null;
    if (tag.startsWith('ruffle-')) kind = 'ruffle';
    else if (tag === 'embed' || tag === 'object') kind = 'flash';
    else if (tag === 'canvas') kind = 'canvas';
    if (!kind) continue;
    const flashEvidence = /shockwave|flash/.test(type) || /\\.swf(?:$|[?#])/i.test(source);
    if ((tag === 'embed' || tag === 'object') && !flashEvidence && rect.width * rect.height < 40000) continue;
    results.push({
      tag, kind, source, path: pathOf(element),
      label: clean(element.getAttribute('title') || element.getAttribute('aria-label') || element.id || tag),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    });
  }
  return { href: location.href, viewport: { width: innerWidth, height: innerHeight }, results };
})()`;

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 600);
  } catch { return String(value || '').split(/[?#]/u)[0].slice(0, 600); }
}

function frameTreeRecords(tree: unknown): Map<string, FrameRecord> {
  const records = new Map<string, FrameRecord>();
  const visit = (node: unknown, parentId: string | undefined, depth: number): void => {
    if (!node || typeof node !== 'object') return;
    const value = node as { frame?: { id?: unknown; url?: unknown }; childFrames?: unknown[] };
    const id = typeof value.frame?.id === 'string' ? value.frame.id : '';
    if (!id) return;
    records.set(id, { id, parentId, url: typeof value.frame?.url === 'string' ? value.frame.url : '', depth });
    for (const child of value.childFrames ?? []) visit(child, id, depth + 1);
  };
  const root = tree && typeof tree === 'object' ? (tree as { frameTree?: unknown }).frameTree : undefined;
  visit(root, undefined, 0);
  return records;
}

function candidateScore(kind: GameSurfaceKind, rect: OwnerRect, source: string, depth: number): number {
  const areaScore = Math.min(50, Math.log2(Math.max(1, rect.width * rect.height)) * 3);
  const kindScore = kind === 'flash' ? 80 : kind === 'ruffle' ? 75 : kind === 'canvas' ? 30 : 5;
  const sourceScore = /\.swf(?:$|[?#])/iu.test(source) ? 30 : 0;
  return Math.round(kindScore + sourceScore + areaScore + Math.min(10, depth * 2));
}

function fingerprintFor(kind: GameSurfaceKind, frameUrl: string, source: string, label: string, path: string): string {
  return createHash('sha1').update(JSON.stringify({ kind, frameUrl: safeUrl(frameUrl), source: safeUrl(source), label, path })).digest('hex');
}

function attributesOf(node: FlattenedNode): Map<string, string> {
  const result = new Map<string, string>(); const attributes = node.attributes ?? [];
  for (let index = 0; index + 1 < attributes.length; index += 2) result.set(attributes[index].toLowerCase(), attributes[index + 1]);
  return result;
}

function rectFromQuad(quad: number[] | undefined): OwnerRect | null {
  if (!quad || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]]; const ys = [quad[1], quad[3], quad[5], quad[7]];
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export async function detectGameSurfaces(webContents: WebContents): Promise<GameSurfaceCandidate[]> {
  if (webContents.isDestroyed()) throw new Error('game surface target was destroyed');
  const debugDetection = process.env.BAO_AUTOMATION_SURFACE_DEBUG === '1';
  const contexts = new Map<string, { contextId: number; frameId: string; sessionId?: string }>();
  const attachedSessions = new Map<string, AttachedTarget>();
  const onMessage = (_event: Electron.Event, method: string, params: unknown, sessionId?: string): void => {
    if (!params || typeof params !== 'object') return;
    if (method === 'Target.attachedToTarget') {
      const attached = params as { sessionId?: unknown; targetInfo?: { type?: unknown; targetId?: unknown; url?: unknown } };
      const type = typeof attached.targetInfo?.type === 'string' ? attached.targetInfo.type : '';
      if (typeof attached.sessionId === 'string' && (type === 'iframe' || type === 'page')) {
        attachedSessions.set(attached.sessionId, {
          sessionId: attached.sessionId,
          targetId: typeof attached.targetInfo?.targetId === 'string' ? attached.targetInfo.targetId : '',
          url: typeof attached.targetInfo?.url === 'string' ? attached.targetInfo.url : '',
        });
        if (debugDetection) console.log('[automation-surface] attached', type, attached.sessionId, attached.targetInfo?.targetId);
      }
      return;
    }
    if (method !== 'Runtime.executionContextCreated') return;
    const context = (params as { context?: { id?: unknown; auxData?: { frameId?: unknown; isDefault?: unknown } } }).context;
    if (typeof context?.id !== 'number' || context.auxData?.isDefault === false) return;
    const frameId = typeof context.auxData?.frameId === 'string' ? context.auxData.frameId : '';
    const targetSessionId = sessionId || undefined;
    if (frameId) contexts.set(`${targetSessionId ?? 'root'}:${context.id}`, { contextId: context.id, frameId, sessionId: targetSessionId });
    if (debugDetection && frameId) console.log('[automation-surface] context', targetSessionId ?? 'root', context.id, frameId);
  };
  const lease = acquireCdpLease(webContents, 'automation');
  try {
    webContents.debugger.on('message', onMessage);
    try {
      await webContents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await webContents.debugger.sendCommand('Target.setDiscoverTargets', { discover: true });
    } catch { /* Targets without OOPIF support continue through the root session. */ }
    await webContents.debugger.sendCommand('Page.enable');
    await webContents.debugger.sendCommand('DOM.enable');
    await webContents.debugger.sendCommand('Runtime.enable');
    const enabledSessions = new Set<string>();
    for (let round = 0; round < 4; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const pending = [...attachedSessions.keys()].filter((sessionId) => !enabledSessions.has(sessionId));
      for (const sessionId of pending) {
        enabledSessions.add(sessionId);
        try {
          await webContents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
          await webContents.debugger.sendCommand('Page.enable', {}, sessionId);
          await webContents.debugger.sendCommand('DOM.enable', {}, sessionId);
          await webContents.debugger.sendCommand('Runtime.enable', {}, sessionId);
        } catch { /* A subframe can navigate or disappear during discovery. */ }
      }
      if (!pending.length && round >= 1) break;
    }
    const frameTree = frameTreeRecords(await webContents.debugger.sendCommand('Page.getFrameTree'));
    const sessionRootFrames = new Map<string, string>();
    // An out-of-process iframe has its own Page domain. Its frame normally
    // also appears in the root frame tree, but its document and Runtime world
    // are available only through the attached target session.
    for (const sessionId of enabledSessions) {
      try {
        const sessionTree = frameTreeRecords(await webContents.debugger.sendCommand('Page.getFrameTree', {}, sessionId));
        const root = [...sessionTree.values()].find((frame) => !frame.parentId);
        if (root) sessionRootFrames.set(sessionId, root.id);
        for (const frame of sessionTree.values()) {
          const existing = frameTree.get(frame.id);
          if (!existing) {
            const target = attachedSessions.get(sessionId);
            frameTree.set(frame.id, {
              ...frame,
              url: frame.url || target?.url || '',
              depth: root?.id === frame.id ? 1 : frame.depth + 1,
            });
          } else if (!existing.url && frame.url) {
            frameTree.set(frame.id, { ...existing, url: frame.url });
          }
        }
      } catch (error) {
        if (debugDetection) console.log('[automation-surface] session tree failed', sessionId, String(error));
      }
    }
    // Do not rely solely on executionContextCreated. Very old XHTML game
    // frames can be visible in Elements while their ordinary context is not
    // surfaced consistently. An isolated world gives CDP a deterministic,
    // cross-origin-capable document context for every frame in the tree.
    for (const frame of frameTree.values()) {
      try {
        const isolated = await webContents.debugger.sendCommand('Page.createIsolatedWorld', {
          frameId: frame.id,
          worldName: `bao-game-surface-${frame.id}`,
          grantUniveralAccess: false,
        }) as { executionContextId?: number };
        if (typeof isolated.executionContextId === 'number') {
          contexts.set(`isolated:${isolated.executionContextId}`, {
            contextId: isolated.executionContextId,
            frameId: frame.id,
          });
        }
      } catch { /* OOPIF or plugin-only frames may reject root-session worlds. */ }
    }
    let flattenedNodes: FlattenedNode[] = [];
    try {
      const flattened = await webContents.debugger.sendCommand('DOM.getFlattenedDocument', { depth: -1, pierce: true }) as { nodes?: FlattenedNode[] };
      flattenedNodes = flattened.nodes ?? [];
    } catch { /* Runtime contexts remain the primary path on older targets. */ }
    const seenBackendNodes = new Set(flattenedNodes.map((node) => node.backendNodeId).filter(Boolean));
    const appendTree = (node: FlattenedNode | undefined, parentId?: number): void => {
      if (!node) return;
      const normalized = parentId && !node.parentId ? { ...node, parentId } : node;
      if (normalized.backendNodeId && !seenBackendNodes.has(normalized.backendNodeId)) {
        seenBackendNodes.add(normalized.backendNodeId);
        flattenedNodes.push(normalized);
      }
      const childParentId = normalized.nodeId || parentId;
      for (const child of normalized.children ?? []) appendTree(child, childParentId);
      appendTree(normalized.contentDocument, childParentId);
      for (const shadowRoot of normalized.shadowRoots ?? []) appendTree(shadowRoot, childParentId);
      appendTree(normalized.templateContent, childParentId);
    };
    // Chromium 87 can omit a cross-origin iframe's descendants from
    // getFlattenedDocument even though DevTools Elements exposes them below
    // iframe -> #document. getDocument returns that branch through the
    // contentDocument property, so walk the actual tree as well. XHTML Flash
    // hosts (for example an <object> below a namespaced <html>) depend on this.
    try {
      const documentTree = await webContents.debugger.sendCommand('DOM.getDocument', {
        depth: -1,
        pierce: true,
      }) as { root?: FlattenedNode };
      appendTree(documentTree.root);
    } catch { /* Some plugin documents reject deep DOM traversal. */ }
    // DevTools Elements lazily expands iframe documents. On some old game
    // sites DOM.getDocument stops at the iframe even with depth:-1; asking for
    // every frame owner separately mirrors that lazy expansion and exposes
    // iframe.contentDocument -> XHTML -> object/embed.
    const frameOwnerBackendNodes = new Map<string, number>();
    for (const frame of frameTree.values()) {
      if (!frame.parentId) continue;
      try {
        const owner = await webContents.debugger.sendCommand('DOM.getFrameOwner', { frameId: frame.id }) as { backendNodeId?: number };
        if (!owner.backendNodeId) continue;
        frameOwnerBackendNodes.set(frame.id, owner.backendNodeId);
        const described = await webContents.debugger.sendCommand('DOM.describeNode', {
          backendNodeId: owner.backendNodeId,
          depth: -1,
          pierce: true,
        }) as { node?: FlattenedNode };
        appendTree(described.node);
      } catch { /* A nested frame can navigate while it is being expanded. */ }
    }
    const frameMetrics = new Map<string, FrameMetrics>();
    const observedFrameUrls = new Map<string, string>();
    const locals: Array<{ frameId: string; value: LocalCandidate }> = [];

    for (const context of contexts.values()) {
      try {
        const response = await webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: DETECT_EXPRESSION, contextId: context.contextId, returnByValue: true,
        }, context.sessionId) as { result?: { value?: { href?: unknown; viewport?: { width?: unknown; height?: unknown }; results?: unknown[] } } };
        const value = response.result?.value;
        if (typeof value?.href === 'string') observedFrameUrls.set(context.frameId, value.href);
        const width = Number(value?.viewport?.width); const height = Number(value?.viewport?.height);
        if (width > 0 && height > 0) frameMetrics.set(context.frameId, { width, height });
        for (const raw of value?.results ?? []) {
          if (!raw || typeof raw !== 'object') continue;
          const item = raw as LocalCandidate;
          if (!item.rect || !['flash', 'ruffle', 'canvas'].includes(item.kind)) continue;
          locals.push({ frameId: context.frameId, value: item });
        }
      } catch { /* a frame can disappear while candidates are collected */ }
    }
    // Do not depend on executionContextCreated replay for OOPIFs. Chromium 87
    // can attach the iframe target after Runtime.enable without replaying a
    // useful default context to the root debugger listener. Evaluating without
    // a contextId runs in that target's main frame directly.
    for (const [sessionId, frameId] of sessionRootFrames) {
      try {
        const response = await webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: DETECT_EXPRESSION,
          returnByValue: true,
        }, sessionId) as { result?: { value?: { href?: unknown; viewport?: { width?: unknown; height?: unknown }; results?: unknown[] } } };
        const value = response.result?.value;
        if (typeof value?.href === 'string') observedFrameUrls.set(frameId, value.href);
        if (debugDetection) console.log('[automation-surface] session scan', sessionId, frameId, value?.results?.length ?? 0);
        const width = Number(value?.viewport?.width); const height = Number(value?.viewport?.height);
        if (width > 0 && height > 0) frameMetrics.set(frameId, { width, height });
        for (const raw of value?.results ?? []) {
          if (!raw || typeof raw !== 'object') continue;
          const item = raw as LocalCandidate;
          if (!item.rect || !['flash', 'ruffle', 'canvas'].includes(item.kind)) continue;
          locals.push({ frameId, value: item });
        }
      } catch (error) {
        if (debugDetection) console.log('[automation-surface] session scan failed', sessionId, frameId, String(error));
      }
    }

    // Runtime can expose a live cross-origin frame that Page.getFrameTree
    // omitted during a redirect or process transition. Keep it: frameId is
    // still valid for DOM.getFrameOwner, which provides the top-level box.
    for (const [frameId, url] of observedFrameUrls) {
      if (!frameTree.has(frameId)) {
        frameTree.set(frameId, { id: frameId, parentId: '__runtime_parent__', url, depth: 1 });
      }
    }
    // A Page.getFrameTree issued inside an attached iframe session describes
    // that session's root without a parentId, even though it is not the top
    // BrowserView frame. Preserve its non-zero depth and force owner mapping;
    // otherwise the player's local (0,0) is mistaken for viewport (0,0),
    // producing a correctly-sized but visibly shifted selection rectangle.
    for (const [frameId, frame] of frameTree) {
      if (frame.depth > 0 && !frame.parentId) {
        frameTree.set(frameId, { ...frame, parentId: '__attached_frame_parent__' });
      }
    }

    const ownerRects = new Map<string, OwnerRect>();
    for (const frame of frameTree.values()) {
      if (!frame.parentId) continue;
      try {
        let backendNodeId = frameOwnerBackendNodes.get(frame.id);
        if (!backendNodeId) {
          const owner = await webContents.debugger.sendCommand('DOM.getFrameOwner', { frameId: frame.id }) as { backendNodeId?: number };
          backendNodeId = owner.backendNodeId;
          if (backendNodeId) frameOwnerBackendNodes.set(frame.id, backendNodeId);
        }
        if (!backendNodeId) continue;
        const box = await webContents.debugger.sendCommand('DOM.getBoxModel', { backendNodeId }) as { model?: { content?: number[] } };
        const rect = rectFromQuad(box.model?.content);
        if (rect) ownerRects.set(frame.id, rect);
      } catch { /* sandboxed or detached frame */ }
    }

    const toTop = (frameId: string, localRect: OwnerRect): OwnerRect | null => {
      const frame = frameTree.get(frameId);
      if (!frame?.parentId) return { ...localRect };
      // DOM.getBoxModel quads are already expressed in top-level viewport
      // coordinates, even when the owner node belongs to a nested frame.
      // Only scale the candidate from the child viewport into that owner box;
      // accumulating every ancestor would count iframe offsets twice.
      const owner = ownerRects.get(frame.id); const metrics = frameMetrics.get(frame.id);
      if (!owner || !metrics || metrics.width <= 0 || metrics.height <= 0) return null;
      return {
        x: owner.x + localRect.x * owner.width / metrics.width,
        y: owner.y + localRect.y * owner.height / metrics.height,
        width: localRect.width * owner.width / metrics.width,
        height: localRect.height * owner.height / metrics.height,
      };
    };

    const candidates: GameSurfaceCandidate[] = [];
    for (const local of locals) {
      const frame = frameTree.get(local.frameId);
      const rect = toTop(local.frameId, local.value.rect);
      if (!frame || !rect || rect.width < 80 || rect.height < 60) continue;
      const frameUrl = safeUrl(frame.url); const source = safeUrl(local.value.source);
      const fingerprint = fingerprintFor(local.value.kind, frameUrl, source, local.value.label, local.value.path);
      candidates.push({
        id: `${fingerprint.slice(0, 16)}-${candidates.length}`,
        fingerprint,
        kind: local.value.kind,
        label: local.value.label || (local.value.kind === 'flash' ? 'Flash 播放器' : local.value.kind === 'ruffle' ? 'Ruffle 播放器' : 'Canvas'),
        frameDepth: frame.depth,
        frameUrl,
        source,
        rect,
        score: candidateScore(local.value.kind, rect, source, frame.depth),
      });
    }

    // Last-resort selectable regions for games whose plugin DOM disappears
    // after a login/loading transition. Frame names are irrelevant; every
    // sufficiently large visible iframe owner is offered below real players.
    for (const frame of frameTree.values()) {
      if (!frame.parentId || /\.swf(?:$|[?#])/iu.test(frame.url)) continue;
      const rect = ownerRects.get(frame.id);
      if (!rect || rect.width < 160 || rect.height < 120 || rect.width * rect.height < 50_000) continue;
      const frameUrl = safeUrl(frame.url); const label = 'iframe 游戏区域候选';
      const fingerprint = fingerprintFor('frame', frameUrl, frameUrl, label, `frame:${frame.id}`);
      candidates.push({
        id: `${fingerprint.slice(0, 16)}-${candidates.length}`,
        fingerprint, kind: 'frame', label, frameDepth: frame.depth, frameUrl, source: frameUrl, rect,
        score: candidateScore('frame', rect, frameUrl, frame.depth),
      });
    }

    // Chromium's plugin document for an iframe whose URL is the SWF itself
    // may have no normal Runtime context or inspectable <embed>. The frame URL
    // and its owner box are still reliable evidence for that case.
    for (const frame of frameTree.values()) {
      if (!frame.parentId || !/\.swf(?:$|[?#])/iu.test(frame.url)) continue;
      const rect = ownerRects.get(frame.id);
      if (!rect || rect.width < 80 || rect.height < 60) continue;
      const source = safeUrl(frame.url); const frameUrl = safeUrl(frame.url); const label = 'Flash 游戏画面';
      const fingerprint = fingerprintFor('flash', frameUrl, source, label, `direct-frame:${frame.id}`);
      candidates.push({
        id: `${fingerprint.slice(0, 16)}-${candidates.length}`,
        fingerprint, kind: 'flash', label, frameDepth: frame.depth, frameUrl, source, rect,
        score: candidateScore('flash', rect, source, frame.depth) + 10,
      });
    }

    // PPAPI plugin documents and directly loaded SWFs do not always expose a
    // useful JavaScript execution context. Scan the flattened DOM as a second,
    // context-independent source; box-model quads are already top-level.
    const nodesById = new Map(flattenedNodes.map((node) => [node.nodeId, node]));
    const domContext = (node: FlattenedNode): { frameUrl: string; depth: number; path: string } => {
      let current: FlattenedNode | undefined = node; let frameUrl = ''; let depth = 0; const parts: string[] = [];
      for (let guard = 0; current && guard < 16; guard += 1) {
        const attributes = attributesOf(current); const tag = current.nodeName.toLowerCase();
        if (tag === '#document' && current.documentURL && !frameUrl) frameUrl = current.documentURL;
        if (tag === 'iframe' || tag === 'frame') depth += 1;
        const identity = attributes.get('id') || attributes.get('name');
        if (tag !== '#document') parts.unshift(identity ? `${tag}#${identity}` : tag);
        current = current.parentId ? nodesById.get(current.parentId) : undefined;
      }
      return { frameUrl: safeUrl(frameUrl), depth, path: parts.slice(-8).join('>') };
    };
    for (const node of flattenedNodes) {
      const tag = node.nodeName.toLowerCase();
      if (!['embed', 'object', 'ruffle-player', 'ruffle-embed', 'canvas'].includes(tag) || !node.backendNodeId) continue;
      const attributes = attributesOf(node);
      const source = safeUrl(attributes.get('src') || attributes.get('data') || '');
      const type = String(attributes.get('type') || '').toLowerCase();
      const kind: GameSurfaceKind = tag.startsWith('ruffle-') ? 'ruffle' : tag === 'canvas' ? 'canvas' : 'flash';
      const flashEvidence = /shockwave|flash/u.test(type) || /\.swf(?:$|[?#])/iu.test(source);
      try {
        const box = await webContents.debugger.sendCommand('DOM.getBoxModel', { backendNodeId: node.backendNodeId }) as { model?: { content?: number[] } };
        const rect = rectFromQuad(box.model?.content);
        if (!rect || rect.width < 80 || rect.height < 60) continue;
        if ((tag === 'embed' || tag === 'object') && !flashEvidence && rect.width * rect.height < 40000) continue;
        const context = domContext(node);
        const label = String(attributes.get('title') || attributes.get('aria-label') || attributes.get('id')
          || (kind === 'flash' ? 'Flash 播放器' : kind === 'ruffle' ? 'Ruffle 播放器' : 'Canvas')).slice(0, 200);
        const fingerprint = fingerprintFor(kind, context.frameUrl, source, label, `dom:${context.path}`);
        candidates.push({
          id: `${fingerprint.slice(0, 16)}-${candidates.length}`,
          fingerprint, kind, label, frameDepth: context.depth, frameUrl: context.frameUrl, source, rect,
          score: candidateScore(kind, rect, source, context.depth),
        });
      } catch { /* detached or non-rendered node */ }
    }

    // DevTools' global DOM search can reach legacy XHTML/cross-origin frame
    // nodes that are visible in Elements but omitted from the flattened root
    // document. This is the path used for structures such as
    // iframe -> XHTML -> object#picaTown[data="Swfloader.swf"].
    let searchId = '';
    try {
      const search = await webContents.debugger.sendCommand('DOM.performSearch', {
        query: 'object, embed, ruffle-player, ruffle-embed, canvas',
        includeUserAgentShadowDOM: true,
      }) as { searchId?: string; resultCount?: number };
      searchId = search.searchId ?? '';
      const count = Math.min(100, Math.max(0, search.resultCount ?? 0));
      if (searchId && count) {
        const results = await webContents.debugger.sendCommand('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: count }) as { nodeIds?: number[] };
        for (const nodeId of results.nodeIds ?? []) {
          try {
            const described = await webContents.debugger.sendCommand('DOM.describeNode', { nodeId, depth: 0, pierce: true }) as { node?: FlattenedNode };
            const node = described.node; if (!node) continue;
            const tag = node.nodeName.toLowerCase(); const attributes = attributesOf(node);
            const source = safeUrl(attributes.get('src') || attributes.get('data') || '');
            const type = String(attributes.get('type') || '').toLowerCase();
            const kind: GameSurfaceKind = tag.startsWith('ruffle-') ? 'ruffle' : tag === 'canvas' ? 'canvas' : 'flash';
            const flashEvidence = /shockwave|flash/u.test(type) || /\.swf(?:$|[?#])/iu.test(source);
            const box = await webContents.debugger.sendCommand('DOM.getBoxModel', { nodeId }) as { model?: { content?: number[] } };
            const rect = rectFromQuad(box.model?.content);
            if (!rect || rect.width < 80 || rect.height < 60) continue;
            if ((tag === 'embed' || tag === 'object') && !flashEvidence && rect.width * rect.height < 40000) continue;
            const label = String(attributes.get('title') || attributes.get('aria-label') || attributes.get('id')
              || (kind === 'flash' ? 'Flash 播放器' : kind === 'ruffle' ? 'Ruffle 播放器' : 'Canvas')).slice(0, 200);
            const fingerprint = fingerprintFor(kind, '', source, label, `global-search:${tag}:${attributes.get('id') || attributes.get('name') || nodeId}`);
            candidates.push({
              id: `${fingerprint.slice(0, 16)}-${candidates.length}`,
              fingerprint, kind, label, frameDepth: 0, frameUrl: '', source, rect,
              score: candidateScore(kind, rect, source, 0) + 5,
            });
          } catch { /* Search results can become stale during Flash navigation. */ }
        }
      }
    } catch { /* DOM.performSearch is a best-effort legacy-page fallback. */ }
    finally {
      if (searchId) try { await webContents.debugger.sendCommand('DOM.discardSearchResults', { searchId }); } catch { /* detached */ }
    }
    const sorted = candidates.sort((left, right) => right.score - left.score || right.rect.width * right.rect.height - left.rect.width * left.rect.height);
    const distinct: GameSurfaceCandidate[] = [];
    for (const candidate of sorted) {
      const duplicate = distinct.some((current) => current.kind === candidate.kind
        && Math.abs(current.rect.x - candidate.rect.x) < 3 && Math.abs(current.rect.y - candidate.rect.y) < 3
        && Math.abs(current.rect.width - candidate.rect.width) < 3 && Math.abs(current.rect.height - candidate.rect.height) < 3);
      if (!duplicate) distinct.push(candidate);
      if (distinct.length >= 12) break;
    }
    return distinct;
  } finally {
    try { webContents.debugger.removeListener('message', onMessage); } catch { /* destroyed */ }
    lease.release();
  }
}

export function chooseMatchingGameSurface(candidates: GameSurfaceCandidate[], fingerprint: string): GameSurfaceCandidate | null {
  return candidates.find((candidate) => candidate.fingerprint === fingerprint) ?? null;
}

/** Reacquire a player that replaced its DOM node while retaining the same logical game area. */
export function chooseReplacementGameSurface(candidates: GameSurfaceCandidate[], previous: GameSurfaceCandidate): GameSurfaceCandidate | null {
  const sameKind = candidates.filter((candidate) => candidate.kind === previous.kind);
  const nonFrame = candidates.filter((candidate) => candidate.kind !== 'frame');
  const pool = sameKind.length ? sameKind : nonFrame.length ? nonFrame : candidates;
  if (!pool.length) return null;
  const scored = pool.map((candidate) => {
    let score = 0;
    if (candidate.kind === previous.kind) score += 25;
    if (candidate.source && previous.source && candidate.source === previous.source) score += 70;
    if (candidate.frameUrl && previous.frameUrl && candidate.frameUrl === previous.frameUrl) score += 55;
    if (candidate.label === previous.label) score += 15;
    if (candidate.frameDepth === previous.frameDepth) score += 8;
    const previousRatio = previous.rect.width / Math.max(1, previous.rect.height);
    const candidateRatio = candidate.rect.width / Math.max(1, candidate.rect.height);
    score += Math.max(0, 20 - Math.abs(Math.log(Math.max(.01, candidateRatio / previousRatio))) * 20);
    return { candidate, score };
  }).sort((left, right) => right.score - left.score || right.candidate.score - left.candidate.score);
  const best = scored[0];
  const minimum = pool.length === 1 ? 45 : 65;
  return best && best.score >= minimum ? best.candidate : null;
}
