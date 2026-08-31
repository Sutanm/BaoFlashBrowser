import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { Notification } from 'electron';
import { createAutomationAbortController } from '../../../shared/automation/abort-controller';
import {
  AutomationActionRegistry,
  AutomationCoordinateResolver,
  AutomationFrameTransform,
  AutomationLocatorQueries,
  AutomationLocatorRegistry,
  AutomationRuntimeQueryRegistry,
  AutomationWorkflowRuntime,
  affine,
  CoordinateLocatorResolver,
  FirstOfLocatorResolver,
  ImageLocatorResolver,
  TextLocatorResolver,
  captureFrameGeometry,
  decodeGameSurfaceFeature,
  frameId,
  generation,
  point,
  region,
  registerLocatorQueries,
  registerPointerActions,
  registerTextQueries,
  registerUtilityActions,
  resolveLocatorCaptureRegion,
  resolvedSurface,
  size,
  surfaceId,
  targetId,
  viewportSpace,
  type ActionContext,
  type ImageLocator,
  type LocatedTargetInputPort,
  type LocatorContext,
  type LocatorRecognitionPort,
  type PersistedRegion,
  type Point,
  type RecognitionCandidate,
  type RuntimeContextChange,
  type RuntimeExecutionContext,
  type RuntimeValue,
  type TextLocator,
  type SurfaceSpec,
  type WorkflowRunHandle,
  validateSurfaceSpec,
} from '../../../shared/automation/core';
import type { AutomationPackageV3 } from '../../../shared/automation/package-v3';
import type { AutomationProfileV3 } from '../../../shared/automation/package-v3';
import { decodeAutomationImageGroup } from '../../../shared/automation/image-groups';
import { DEFAULT_IMAGE_MATCH_MASK, DEFAULT_IMAGE_MATCH_THRESHOLD, imageMatchScales, surfaceReferenceImageScales } from '../../../shared/automation/vision-policy';
import { createJavaScriptInstallGrant, createJavaScriptRunGrant } from '../../../shared/automation/javascript-grants';
import type { AutomationTabHandle } from '../tabs';
import { BrowserViewCaptureService } from './browserview-capture-service';
import { BrowserViewCoordinateAdapter, browserViewViewportTransform } from './browserview-coordinate-adapter';
import { BrowserViewInputService } from './browserview-input-service';
import { JavaScriptAutomationCapabilityBroker } from './javascript-capability-broker';
import { createJavaScriptAutomationHostPorts } from './javascript-host-ports';
import { JavaScriptAutomationSandboxHost, type JavaScriptSandboxRunHandle } from './javascript-sandbox-host';
import { NativeImageTemplateProvider } from './native-image-template-provider';
import type { AutomationOcrEngine } from './capability-contracts';
import { createAutomationOcrEngine } from './ocr-provider';
import { AutomationTextRecognitionService } from './text-recognition-service';
import { AUTHORING_BEST_CANDIDATE_THRESHOLD, AutomationVisionService } from './vision-service';
import { CachingAutomationTemplateProvider, OpenCvWorkerMatcher } from './vision-worker-matcher';
import { chooseLocatedGameSurface, detectGameSurfaces } from './game-surface-detector';

const sleep = (durationMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('automation cancelled')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, durationMs));
  const abort = (): void => { clearTimeout(timer); reject(new Error('automation cancelled')); };
  signal.addEventListener('abort', abort, { once: true });
});

export class BrowserViewAutomationCoreSession {
  private readonly viewport;
  private readonly coordinateResolver;
  private readonly coordinateAdapter;
  private readonly input;
  private readonly capture;
  private readonly matcher;
  private readonly vision;
  private readonly ocrEngine;
  private readonly text;
  private readonly ownsMatcher;
  private readonly ownsOcrEngine;
  private readonly locators = new AutomationLocatorRegistry();
  private readonly locatorQueries: AutomationLocatorQueries;
  private readonly actions = new AutomationActionRegistry();
  private readonly runtimeQueries = new AutomationRuntimeQueryRegistry();
  private readonly runtime: AutomationWorkflowRuntime;
  private nextSurfaceGeneration = 1;
  private closePromise?: Promise<void>;

  constructor(private readonly handle: AutomationTabHandle, private readonly source: AutomationPackageV3, private readonly profile?: AutomationProfileV3, private readonly log: (message: string, level?: 'debug' | 'info' | 'warn' | 'error') => void = () => undefined, private readonly scriptGrants?: (entryId: string) => readonly import('../../../shared/automation/javascript-api').JavaScriptAutomationCapability[], injected: { matcher?: OpenCvWorkerMatcher; ocrEngine?: AutomationOcrEngine } = {}) {
    const logical = handle.getCssViewport();
    this.viewport = viewportSpace({ targetId: targetId(`tab-${handle.tabId}`), targetGeneration: generation(1), viewportGeneration: generation(handle.getViewportRevision?.() ?? 1) });
    this.coordinateResolver = new AutomationCoordinateResolver({ viewport: this.viewport, viewportSize: size(logical.width, logical.height) });
    this.coordinateAdapter = new BrowserViewCoordinateAdapter(() => {
      const transform = handle.getViewportTransform();
      return browserViewViewportTransform({ space: this.viewport, logicalSize: transform.logicalSize, displaySize: transform.displaySize });
    });
    this.input = new BrowserViewInputService(handle.webContents, { assertCurrent: handle.assertCurrent, toDisplayPoint: (value) => this.coordinateAdapter.logicalPointToDisplay(point('logical', this.viewport, value.x, value.y)), displayScale: () => ({ x: handle.getViewportTransform().scaleX, y: handle.getViewportTransform().scaleY }), sleep });
    this.capture = new BrowserViewCaptureService(handle.webContents, { frameGeometry: (id, bitmapSize, logicalRegion) => {
      const captured = logicalRegion ? region('logical', this.viewport, logicalRegion.x, logicalRegion.y, logicalRegion.width, logicalRegion.height) : region('logical', this.viewport, 0, 0, logical.width, logical.height);
      return captureFrameGeometry({ frameId: frameId(id), space: this.viewport, capturedRegion: captured, bitmapSize });
    } });
    const provider = new CachingAutomationTemplateProvider(new NativeImageTemplateProvider({ load: async (asset) => {
      const normalized = asset.startsWith('assets/') ? asset : `assets/${asset}`;
      const bytes = source.assets.get(normalized) ?? source.assets.get(asset); if (!bytes) throw new Error(`automation asset is missing: ${asset}`);
      return { bytes, cacheKey: crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex') };
    } }));
    this.matcher = injected.matcher ?? new OpenCvWorkerMatcher(provider);
    this.ownsMatcher = !injected.matcher;
    this.ocrEngine = injected.ocrEngine ?? createAutomationOcrEngine();
    this.ownsOcrEngine = !injected.ocrEngine;
    this.vision = new AutomationVisionService(this.matcher);
    this.text = new AutomationTextRecognitionService(this.ocrEngine);
    const recognition: LocatorRecognitionPort = { locateImage: (locator, context, maxCandidates) => this.locateImage(locator, context, maxCandidates), locateText: (locator, context) => this.locateText(locator, context) };
    this.locators.register(new CoordinateLocatorResolver()); this.locators.register(new ImageLocatorResolver(recognition)); this.locators.register(new TextLocatorResolver(recognition)); this.locators.register(new FirstOfLocatorResolver(this.locators)); this.locators.freeze();
    this.locatorQueries = new AutomationLocatorQueries(this.locators);
    const inputPort: LocatedTargetInputPort = {
      click: async (target, action, context) => { await this.waitForCurrentViewport(); await this.input.click(this.viewportPoint(target.activationPoint, context), ({ primary: 'left', middle: 'middle', secondary: 'right' } as const)[action.button ?? 'primary'], action.count ?? 1, context.signal); },
      move: async (target, _action, context) => { await this.waitForCurrentViewport(); await this.input.move(this.viewportPoint(target.activationPoint, context), context.signal); },
      drag: async (from, to, action, context) => { await this.waitForCurrentViewport(); await this.input.drag(this.viewportPoint(from.activationPoint, context), this.viewportPoint(to.activationPoint, context), ({ primary: 'left', middle: 'middle', secondary: 'right' } as const)[action.button ?? 'primary'], action.durationMs ?? 300, context.signal); },
    };
    registerPointerActions(this.actions, this.locators, inputPort);
    registerUtilityActions(this.actions, {
      keyPress: async (key, modifiers, context) => { await this.input.keyDown(key, [...modifiers], context.signal); await this.input.keyUp(key, [...modifiers], context.signal); },
      typeText: (text, intervalMs, context) => this.input.typeText(text, intervalMs, context.signal),
      scroll: async (deltaX, deltaY, context) => { await this.waitForCurrentViewport(); await this.input.scroll(deltaX, deltaY, context.signal); },
      navigate: async (url) => { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许打开 http(s) 地址'); await this.handle.navigate(parsed.toString()); },
      reload: () => this.handle.reload(),
      log: async (message) => { this.log(message); },
      notify: async (title, body) => { new Notification({ title, body: body ?? '' }).show(); },
    });
    this.actions.freeze();
    registerLocatorQueries(this.runtimeQueries, this.locatorQueries);
    registerTextQueries(this.runtimeQueries, {
      readText: async (query, context) => this.text.readText(await this.captureFrame(query.region, context), context.signal),
      readNumber: async (query, context) => this.text.readNumber(await this.captureFrame(query.region, context), context.signal),
    });
    this.runtimeQueries.freeze();
    this.runtime = new AutomationWorkflowRuntime(this.actions, this.runtimeQueries);
  }

  startWorkflow(): WorkflowRunHandle {
    if (!this.source.workflow) throw new Error('package has no Blockly workflow entry');
    return this.runtime.start(this.source.workflow, (signal) => this.context(signal), [{ close: () => this.close() }], this.profile?.variables);
  }

  startJavaScript(entryId: string, approvedPermissions: readonly import('../../../shared/automation/javascript-api').JavaScriptAutomationCapability[], input: readonly (null | boolean | number | string)[] = []): JavaScriptSandboxRunHandle {
    const entry = this.source.manifest.frontends.scripts.find((item) => item.id === entryId); if (!entry) throw new Error(`JavaScript entry is missing: ${entryId}`);
    const source = this.source.scripts.get(entry.path); if (source === undefined) throw new Error(`JavaScript source is missing: ${entry.path}`);
    const ports = createJavaScriptAutomationHostPorts({ actions: this.actions, locators: this.locatorQueries, context: (signal) => this.context(signal),
      input: { keyPress: async (key, modifiers, signal) => { await this.input.keyDown(key, [...modifiers], signal); await this.input.keyUp(key, [...modifiers], signal); }, typeText: (text, interval, signal) => this.input.typeText(text, interval, signal), scroll: (x, y, signal) => this.input.scroll(x, y, signal) },
      ocr: { readText: async (value, _confidence, context) => this.text.readText(await this.captureFrame(value, context), context.signal), readNumber: async (value, _locale, context) => this.text.readNumber(await this.captureFrame(value, context), context.signal) },
      page: { url: () => this.handle.webContents.getURL(), navigate: (url) => this.handle.navigate(url), reload: () => this.handle.reload() },
      time: { sleep, now: Date.now }, log: (level, message) => this.log(message, level), notify: (title, body) => new Notification({ title, body: body ?? '' }).show(),
    });
    const runId = crypto.randomBytes(16).toString('hex');
    const installGrant = createJavaScriptInstallGrant(this.source.manifest.id, { entry: entry.path, permissions: entry.permissions }, approvedPermissions);
    const grant = createJavaScriptRunGrant(installGrant, runId, approvedPermissions);
    const broker = new JavaScriptAutomationCapabilityBroker(crypto.randomBytes(32).toString('hex'), grant.capabilities, ports);
    return new JavaScriptAutomationSandboxHost().start(source, broker, {
      input,
      log: (level, message) => this.log(`[console] ${message}`, level >= 3 ? 'error' : level === 2 ? 'warn' : 'info'),
    });
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = (async () => {
      try {
        if (this.ownsMatcher) await this.matcher.close();
        if (this.ownsOcrEngine) await this.ocrEngine.close?.();
      } finally { this.handle.release(); }
    })();
    await this.closePromise;
  }

  async capturePreview(logicalRegion?: { x: number; y: number; width: number; height: number }, displayRegion?: { x: number; y: number; width: number; height: number }): Promise<{ bitmap: Uint8Array; width: number; height: number; captureMs: number; bitmapMs: number }> {
    const controller = createAutomationAbortController();
    const persisted = logicalRegion ? { unit: 'logical' as const, ...logicalRegion } : undefined;
    const frame = await this.captureFrame(persisted, this.context(controller.signal), displayRegion);
    const dimensions = frame.image.getSize();
    if (!frame.bitmap) throw new Error('captured frame has no bitmap');
    return { bitmap: frame.bitmap, width: dimensions.width, height: dimensions.height, captureMs: frame.captureMs ?? 0, bitmapMs: frame.bitmapMs ?? 0 };
  }

  authoringDisplayRegionToLogical(value: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }): { x: number; y: number; width: number; height: number } {
    const logical = this.coordinateAdapter.sourceViewportRegionToLogical(value, { width: value.viewportWidth, height: value.viewportHeight });
    return { x: logical.x, y: logical.y, width: logical.width, height: logical.height };
  }

  async testImage(asset: string, threshold = DEFAULT_IMAGE_MATCH_THRESHOLD, scales: readonly number[] = imageMatchScales(), mask: 'auto' | 'none' | 'alpha' = DEFAULT_IMAGE_MATCH_MASK, logicalRegion?: { x: number; y: number; width: number; height: number }) {
    const controller = createAutomationAbortController();
    const group = decodeAutomationImageGroup(asset);
    const candidates = await this.locateImage({ kind: 'image', asset: group?.[0] ?? asset, alternatives: group?.slice(1), threshold, scales: [...scales], mask, region: logicalRegion ? { unit: 'logical', ...logicalRegion } : undefined }, this.context(controller.signal), 1);
    const candidate = candidates[0];
    return candidate ? { bounds: candidate.bounds, score: candidate.confidence } : null;
  }

  async testText(query: string, match: 'contains' | 'exact' = 'contains', minConfidence = .5, logicalRegion?: { x: number; y: number; width: number; height: number }) {
    const controller = createAutomationAbortController();
    const candidates = await this.locateText({ kind: 'text', text: query, match, minConfidence, region: logicalRegion ? { unit: 'logical', ...logicalRegion } : undefined }, this.context(controller.signal));
    const candidate = candidates[0];
    return candidate ? { bounds: candidate.bounds, score: candidate.confidence } : null;
  }

  async testImagePreview(asset: string, _threshold = DEFAULT_IMAGE_MATCH_THRESHOLD, scales: readonly number[] = imageMatchScales(), mask: 'auto' | 'none' | 'alpha' = DEFAULT_IMAGE_MATCH_MASK, logicalRegion?: { x: number; y: number; width: number; height: number }, _displayRegion?: { x: number; y: number; width: number; height: number }) {
    return this.capture.withFreshFrame(async () => {
      // Assistant regions are cropped from the same normalized full frame used
      // by whole-page recognition. This guarantees identical template scale in
      // both modes; the logical region only limits the OpenCV search ROI.
      const preview = await this.captureViewportPreview();
      const frame = await this.captureViewportFrame();
      const group = decodeAutomationImageGroup(asset);
      const bitmapMatch = await this.vision.locate(frame, { assets: group ?? [asset], threshold: AUTHORING_BEST_CANDIDATE_THRESHOLD, scales, mask, region: logicalRegion }, createAutomationAbortController().signal);
      const bounds = bitmapMatch && frame.geometry ? new AutomationFrameTransform(frame.geometry).bitmapRegionToSpace(bitmapMatch) : null;
      return { preview, bitmapMatch, match: bitmapMatch && bounds ? { bounds, score: bitmapMatch.score } : null };
    });
  }

  async testTextPreview(query: string, match: 'contains' | 'exact' = 'contains', minConfidence = .5, logicalRegion?: { x: number; y: number; width: number; height: number }, displayRegion?: { x: number; y: number; width: number; height: number }) {
    return this.capture.withFreshFrame(async () => {
      // OCR can operate directly on the selected game ROI. Unlike template
      // matching it does not need a full-frame scene to preserve asset scale.
      // The same scoped frame is reused for preview and recognition.
      const preview = await this.capturePreview(logicalRegion, displayRegion);
      const controller = createAutomationAbortController();
      const frame = await this.captureFrame(logicalRegion ? { unit: 'logical', ...logicalRegion } : undefined, this.context(controller.signal), displayRegion);
      const ocrStartedAt = performance.now();
      const items = await this.text.recognize(frame, controller.signal);
      const ocrMs = performance.now() - ocrStartedAt;
      const bitmapMatch = this.text.locateBestRecognized(frame, items, { text: query, match, minScore: minConfidence });
      const bounds = bitmapMatch && frame.geometry ? new AutomationFrameTransform(frame.geometry).bitmapRegionToSpace(bitmapMatch) : null;
      return {
        preview, previewIsRegion: Boolean(logicalRegion), bitmapMatch,
        match: bitmapMatch && bounds ? { bounds, score: bitmapMatch.score, matched: bitmapMatch.matched } : null,
        ocrMs, recognizedCount: items.length,
        recognizedTexts: items.map((item) => item.text).filter(Boolean).slice(0, 20),
      };
    });
  }

  private context(signal: AbortSignal): RuntimeExecutionContext {
    return this.contextFor(this.viewport, this.coordinateResolver, signal);
  }

  private contextFor(currentSpace: typeof this.viewport | ReturnType<typeof resolvedSurface>['space'], resolver: AutomationCoordinateResolver, signal: AbortSignal, defaultRegion?: PersistedRegion): RuntimeExecutionContext {
    return { currentSpace, coordinateResolver: resolver, defaultRegion, signal, now: Date.now, sleep, callScript: (scriptId, args, runSignal) => this.callScript(scriptId, args, runSignal), derive: async (change: RuntimeContextChange) => {
      if (!change.surface) return { context: this.contextFor(currentSpace, resolver, signal, change.region ?? defaultRegion), release: async () => undefined };
      if (change.surface.kind === 'viewport') return { context: this.contextFor(this.viewport, this.coordinateResolver, signal, change.region), release: async () => undefined };
      const bounds = await this.resolveSurfaceBounds(change.surface);
      const resolved = resolvedSurface({ id: surfaceId(`runtime-${this.nextSurfaceGeneration}`), generation: generation(this.nextSurfaceGeneration++),
        target: this.viewport, spec: change.surface, parentSpace: this.viewport, boundsInParent: region('logical', this.viewport, bounds.x, bounds.y, bounds.width, bounds.height),
        localSize: size(bounds.width, bounds.height), toViewport: affine(1, 0, 0, 1, bounds.x, bounds.y) });
      const derivedResolver = new AutomationCoordinateResolver({ viewport: this.viewport, viewportSize: this.coordinateResolver.sizeOf(this.viewport), surfaces: [resolved] });
      return { context: this.contextFor(resolved.space, derivedResolver, signal, change.region), release: async () => undefined };
    } };
  }

  private async callScript(scriptId: string, args: readonly RuntimeValue[], signal: AbortSignal): Promise<RuntimeValue> {
    if (args.some((value) => value !== null && !['boolean', 'number', 'string'].includes(typeof value))) throw new Error('Blockly 调用脚本目前只支持空值、布尔、数字和文字参数');
    if (signal.aborted) throw new Error('automation cancelled');
    const handle = this.startJavaScript(scriptId, this.scriptGrants?.(scriptId) ?? [], args as readonly (null | boolean | number | string)[]);
    const abort = (): void => { void handle.cancel('parent workflow cancelled'); };
    signal.addEventListener('abort', abort, { once: true });
    let result: Awaited<typeof handle.completion>;
    try { result = await handle.completion; }
    finally { signal.removeEventListener('abort', abort); }
    if (result.status === 'failed') throw result.error;
    if (result.status === 'cancelled') throw new Error(result.reason);
    const value = result.value;
    if (value !== null && !['boolean', 'number', 'string'].includes(typeof value)) throw new Error('脚本返回值必须是空值、布尔、数字或文字');
    return value as RuntimeValue;
  }

  private async resolveSurfaceBounds(spec: SurfaceSpec): Promise<{ x: number; y: number; width: number; height: number }> {
    await this.waitForCurrentViewport();
    if (spec.kind === 'viewport') { const value = this.handle.getCssViewport(); return { x: 0, y: 0, ...value }; }
    if (spec.kind === 'named') {
      const configured = this.profile?.surfaces?.[spec.name];
      if (configured) { validateSurfaceSpec(configured as SurfaceSpec, { allowUnresolvedNamed: false }); return this.resolveSurfaceBounds(configured as SurfaceSpec); }
      if (spec.name !== 'game') throw new Error(`named surface is not configured: ${spec.name}`);
      return this.resolveSurfaceBounds({ kind: 'visual', visualHint: 'container' });
    }
    if (spec.kind === 'region') {
      const parent = await this.resolveSurfaceBounds(spec.parent); const value = spec.region;
      return value.unit === 'ratio'
        ? { x: parent.x + value.x * parent.width, y: parent.y + value.y * parent.height, width: value.width * parent.width, height: value.height * parent.height }
        : { x: parent.x + value.x, y: parent.y + value.y, width: value.width, height: value.height };
    }
    if (spec.kind === 'element') {
      if (!spec.selector || spec.framePath?.length) throw new Error('element surface currently requires a main-frame selector');
      const value = await this.handle.webContents.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(spec.selector)}); if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
      if (!value || typeof value !== 'object') throw new Error(`surface element was not found: ${spec.selector}`);
      const bounds = value as { x: number; y: number; width: number; height: number }; if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error('surface element has invalid bounds');
      const logical = this.coordinateAdapter.displayRegionToLogical(bounds);
      return { x: logical.x, y: logical.y, width: logical.width, height: logical.height };
    }
    const candidates = await detectGameSurfaces(this.handle.webContents);
    const feature = spec.fingerprint?.startsWith('BFG1:') ? decodeGameSurfaceFeature(spec.fingerprint) : undefined;
    const candidate = feature
      ? chooseLocatedGameSurface(candidates, feature)
      : candidates.filter((item) => spec.visualHint === 'container' || item.kind === spec.visualHint || (spec.visualHint === 'iframe' && item.kind === 'frame'))
        .sort((a, b) => b.score - a.score)[0];
    if (!candidate) throw new Error(feature ? '没有找到特征码指定的游戏区域，请重新选择游戏画面并复制特征码' : `visual surface was not found: ${spec.visualHint}`);
    const logical = this.coordinateAdapter.displayRegionToLogical(candidate.rect);
    return { x: logical.x, y: logical.y, width: logical.width, height: logical.height };
  }

  private async waitForCurrentViewport(): Promise<void> {
    this.handle.assertCurrent();
    await this.handle.waitForViewport?.();
    this.handle.assertCurrent();
  }

  private viewportPoint(value: Point, context: ActionContext): { x: number; y: number } {
    const result = context.coordinateResolver.toViewport(value); return { x: result.x, y: result.y };
  }

  private async captureFrame(value: PersistedRegion | undefined, context: LocatorContext, displayRegionOverride?: { x: number; y: number; width: number; height: number }) {
    await this.waitForCurrentViewport();
    const captureRegion = resolveLocatorCaptureRegion(value, context); const transform = this.handle.getViewportTransform();
    return this.capture.capture({ logicalViewportSize: transform.logicalSize, displayViewportSize: transform.displaySize, logicalRegion: captureRegion, displayRegion: displayRegionOverride ?? (captureRegion ? this.coordinateAdapter.logicalRegionToDisplayCapture(captureRegion) : undefined), scope: context.observationScope });
  }

  private async captureViewportFrame(context?: LocatorContext) {
    await this.waitForCurrentViewport();
    const transform = this.handle.getViewportTransform();
    return this.capture.capture({ logicalViewportSize: transform.logicalSize, displayViewportSize: transform.displaySize, scope: context?.observationScope });
  }

  private async captureViewportPreview(): Promise<{ bitmap: Uint8Array; width: number; height: number; captureMs: number; bitmapMs: number }> {
    const frame = await this.captureViewportFrame();
    const dimensions = frame.image.getSize();
    if (!frame.bitmap) throw new Error('captured frame has no bitmap');
    return { bitmap: frame.bitmap, width: dimensions.width, height: dimensions.height, captureMs: frame.captureMs ?? 0, bitmapMs: frame.bitmapMs ?? 0 };
  }

  private async locateImage(locator: ImageLocator, context: LocatorContext, maxCandidates: number): Promise<readonly RecognitionCandidate[]> {
    const assets = [...new Set([locator.asset, ...(locator.alternatives ?? [])])];
    const searchRegion = resolveLocatorCaptureRegion(locator.region, context);
    const surfaceReferences = locator.scales === undefined && locator.region === undefined && searchRegion
      ? assets.map((asset) => {
        const normalized = asset.startsWith('assets/') ? asset : `assets/${asset}`;
        const metadata = this.source.manifest.assetMetadata?.[normalized];
        return metadata?.source === 'capture' && metadata.reference.kind === 'surface' ? metadata.reference : undefined;
      })
      : [];
    const predictedScales = surfaceReferences.length === assets.length && surfaceReferences.every(Boolean)
      ? surfaceReferenceImageScales(surfaceReferences as Array<{ width: number; height: number }>, searchRegion!)
      : undefined;
    const frame = await this.captureViewportFrame(context);
    const matches = await this.vision.locateCandidates(frame, {
      assets,
      threshold: locator.threshold,
      scales: locator.scales ?? predictedScales,
      mask: locator.mask ?? DEFAULT_IMAGE_MATCH_MASK,
      region: searchRegion && { x: searchRegion.x, y: searchRegion.y, width: searchRegion.width, height: searchRegion.height },
    }, context.signal, maxCandidates);
    if (predictedScales) this.log(`[findImage] surface reference scale=${predictedScales[0].toFixed(4)} assets=${assets.length}`, 'debug');
    if (!frame.geometry) return [];
    const transform = new AutomationFrameTransform(frame.geometry);
    return matches.map((match) => ({
      space: frame.geometry!.space,
      bounds: transform.bitmapRegionToSpace(match),
      confidence: match.score,
      frameId: frame.geometry!.frameId,
      fingerprint: `image:${match.asset ?? locator.asset}:${match.x}:${match.y}`,
    }));
  }

  private async locateText(locator: TextLocator, context: LocatorContext): Promise<readonly RecognitionCandidate[]> {
    const frame = await this.captureFrame(locator.region, context);
    const items = await this.text.recognize(frame, context.signal);
    // Preserve the existing OCR diagnostics while moving ownership out of the old Driver facade.
    this.log(`[findText] query="${locator.text}" match=${locator.match} minScore=${locator.minConfidence} region=${JSON.stringify(locator.region ?? null)} capture=${frame.bitmapSize?.width ?? '?'}x${frame.bitmapSize?.height ?? '?'}`);
    items.forEach((item) => this.log(`[findText]   ocr:"${item.text}" score=${item.score?.toFixed(3)} box=${JSON.stringify(item.box)}`));
    const match = this.text.locateRecognized(frame, items, { text: locator.text, match: locator.match === 'normalized' ? 'contains' : locator.match, minScore: locator.minConfidence });
    if (!match || !frame.geometry) return [];
    const bounds = new AutomationFrameTransform(frame.geometry).bitmapRegionToSpace(match);
    return [{ space: frame.geometry.space, bounds, confidence: match.score, frameId: frame.geometry.frameId, fingerprint: `text:${locator.text}:${match.x}:${match.y}` }];
  }
}
