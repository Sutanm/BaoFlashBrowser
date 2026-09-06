import type { LocatorSpec, TargetRef } from './core/locator';
import type { PersistedRegion } from './core/surface';

export type JavaScriptAutomationCapability =
  | 'input' | 'vision' | 'ocr' | 'page.read' | 'page.navigate' | 'log' | 'notify';

export type JavaScriptAutomationMethod =
  | 'input.click' | 'input.move' | 'input.drag' | 'input.keyPress' | 'input.typeText' | 'input.scroll'
  | 'vision.find' | 'vision.exists' | 'vision.waitForRegionChange' | 'vision.waitForColor'
  | 'ocr.findText' | 'ocr.readText' | 'ocr.readNumber'
  | 'page.url' | 'page.navigate' | 'page.reload'
  | 'time.sleep' | 'time.now'
  | 'log.write' | 'notify.show';

export const JAVASCRIPT_AUTOMATION_CAPABILITY: Readonly<Record<JavaScriptAutomationMethod, JavaScriptAutomationCapability | null>> = Object.freeze({
  'input.click': 'input', 'input.move': 'input', 'input.drag': 'input', 'input.keyPress': 'input', 'input.typeText': 'input', 'input.scroll': 'input',
  'vision.find': 'vision', 'vision.exists': 'vision', 'vision.waitForRegionChange': 'vision', 'vision.waitForColor': 'vision',
  'ocr.findText': 'ocr', 'ocr.readText': 'ocr', 'ocr.readNumber': 'ocr',
  'page.url': 'page.read', 'page.navigate': 'page.navigate', 'page.reload': 'page.navigate',
  'time.sleep': null, 'time.now': null, 'log.write': 'log', 'notify.show': 'notify',
});

export type ScriptLocatedTarget = {
  readonly point: { readonly x: number; readonly y: number };
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly ratioPoint: { readonly x: number; readonly y: number };
  readonly ratioBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly confidence?: number;
  readonly text?: string;
};

export type JavaScriptAutomationParams = {
  'input.click': { readonly target: TargetRef; readonly button?: 'primary' | 'middle' | 'secondary'; readonly count?: number; readonly timeoutMs?: number; readonly pollIntervalMs?: number };
  'input.move': { readonly target: TargetRef; readonly durationMs?: number; readonly timeoutMs?: number; readonly pollIntervalMs?: number };
  'input.drag': { readonly from: TargetRef; readonly to: TargetRef; readonly button?: 'primary' | 'middle' | 'secondary'; readonly durationMs?: number; readonly timeoutMs?: number; readonly pollIntervalMs?: number };
  'input.keyPress': { readonly key: string; readonly modifiers?: readonly ('alt' | 'control' | 'meta' | 'shift')[] };
  'input.typeText': { readonly text: string; readonly intervalMs?: number };
  'input.scroll': { readonly deltaX: number; readonly deltaY: number };
  'vision.find': { readonly locator: Extract<LocatorSpec, { readonly kind: 'image' }> };
  'vision.exists': { readonly locator: LocatorSpec };
  'vision.waitForRegionChange': {
    readonly region: PersistedRegion;
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly colorDelta?: number;
    readonly minimumChangedPixels?: number;
    readonly changedPixelRatio?: number;
    readonly consecutiveFrames?: number;
    readonly reference?: 'baseline' | 'previous';
  };
  'vision.waitForColor': {
    readonly region: PersistedRegion;
    readonly colors: readonly string[];
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly tolerance?: number;
    readonly minimumMatchingPixels?: number;
    readonly consecutiveFrames?: number;
  };
  'ocr.findText': { readonly locator: Extract<LocatorSpec, { readonly kind: 'text' }> };
  'ocr.readText': { readonly region?: PersistedRegion; readonly minConfidence?: number };
  'ocr.readNumber': { readonly region?: PersistedRegion; readonly locale?: string };
  'page.url': Record<string, never>;
  'page.navigate': { readonly url: string };
  'page.reload': Record<string, never>;
  'time.sleep': { readonly durationMs: number };
  'time.now': Record<string, never>;
  'log.write': { readonly level: 'debug' | 'info' | 'warn' | 'error'; readonly message: string };
  'notify.show': { readonly title: string; readonly body?: string };
};

export type JavaScriptAutomationResult = {
  'input.click': null; 'input.move': null; 'input.drag': null; 'input.keyPress': null; 'input.typeText': null; 'input.scroll': null;
  'vision.find': ScriptLocatedTarget | null; 'vision.exists': boolean;
  'vision.waitForRegionChange': {
    readonly changed: boolean;
    readonly changedPixels: number;
    readonly totalPixels: number;
    readonly changedRatio: number;
    readonly maxChangedPixels: number;
    readonly maxChangedRatio: number;
    readonly samples: number;
    readonly elapsedMs: number;
    readonly captureMs: number;
  };
  'vision.waitForColor': {
    readonly found: boolean;
    readonly matchingPixels: number;
    readonly totalPixels: number;
    readonly matchingRatio: number;
    readonly maxMatchingPixels: number;
    readonly maxMatchingRatio: number;
    readonly samples: number;
    readonly elapsedMs: number;
    readonly captureMs: number;
    /** Bounds of matching pixels, normalized to the supplied region. */
    readonly matchBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  };
  'ocr.findText': ScriptLocatedTarget | null; 'ocr.readText': string; 'ocr.readNumber': number;
  'page.url': string; 'page.navigate': null; 'page.reload': null;
  'time.sleep': null; 'time.now': number; 'log.write': null; 'notify.show': null;
};

export type JavaScriptAutomationRequest<M extends JavaScriptAutomationMethod = JavaScriptAutomationMethod> = {
  readonly requestId: string;
  readonly runToken: string;
  readonly method: M;
  readonly params: JavaScriptAutomationParams[M];
};

export type JavaScriptAutomationResponse =
  | { readonly requestId: string; readonly ok: true; readonly value: unknown }
  | { readonly requestId: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface BaoAutomationApi {
  readonly input: {
    click(target: TargetRef, options?: { readonly button?: 'primary' | 'middle' | 'secondary'; readonly count?: number; readonly timeoutMs?: number; readonly pollIntervalMs?: number }): Promise<null>;
    move(target: TargetRef, options?: { readonly durationMs?: number; readonly timeoutMs?: number; readonly pollIntervalMs?: number }): Promise<null>;
    drag(options: JavaScriptAutomationParams['input.drag']): Promise<null>;
    keyPress(key: string, modifiers?: readonly ('alt' | 'control' | 'meta' | 'shift')[]): Promise<null>;
    typeText(text: string, intervalMs?: number): Promise<null>;
    scroll(deltaX: number, deltaY: number): Promise<null>;
  };
  readonly vision: {
    find(locator: JavaScriptAutomationParams['vision.find']['locator']): Promise<ScriptLocatedTarget | null>;
    exists(locator: LocatorSpec): Promise<boolean>;
    waitForRegionChange(region: PersistedRegion, options?: Omit<JavaScriptAutomationParams['vision.waitForRegionChange'], 'region'>): Promise<JavaScriptAutomationResult['vision.waitForRegionChange']>;
    waitForColor(region: PersistedRegion, colors: readonly string[], options?: Omit<JavaScriptAutomationParams['vision.waitForColor'], 'region' | 'colors'>): Promise<JavaScriptAutomationResult['vision.waitForColor']>;
  };
  readonly ocr: {
    findText(locator: JavaScriptAutomationParams['ocr.findText']['locator']): Promise<ScriptLocatedTarget | null>;
    readText(region?: PersistedRegion, minConfidence?: number): Promise<string>;
    readNumber(region?: PersistedRegion, locale?: string): Promise<number>;
  };
  readonly page: { url(): Promise<string>; navigate(url: string): Promise<null>; reload(): Promise<null> };
  readonly time: { sleep(durationMs: number): Promise<null>; now(): Promise<number> };
  readonly log: { debug(message: string): Promise<null>; info(message: string): Promise<null>; warn(message: string): Promise<null>; error(message: string): Promise<null> };
  readonly notify: { show(title: string, body?: string): Promise<null> };
}
