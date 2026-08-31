import type { CaptureFrameGeometry } from '../../../shared/automation/core/frame-geometry';

export type AutomationCapabilityRegion = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type AutomationImageMask = 'auto' | 'none' | 'alpha';
export type ImageMatch = {
  asset?: string; x: number; y: number; width: number; height: number; score: number; scale?: number; matchMs?: number;
  captureMs?: number; bitmapMs?: number; templateLoadMs?: number; workerReadyMs?: number; sharedCopyMs?: number;
  sceneMatMs?: number; grayMs?: number; resizeMs?: number; matchTemplateMs?: number; scaledTemplateCacheHits?: number;
  scaledTemplateCacheMisses?: number; totalMs?: number; sceneBytes?: number; sceneTransferBytes?: number; wasmHeapBytes?: number;
  templateCacheBytes?: number; templateCacheEntries?: number; testedScales?: number[]; masked?: boolean; lowVariance?: boolean;
  templateStdDev?: number; frameGeometry?: CaptureFrameGeometry;
};
export type TextMatch = ImageMatch & { readonly text: string };

export type AutomationCapturedImage = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  toBitmap(): Buffer;
  resize?(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): AutomationCapturedImage;
};

export type AutomationCapturedFrame = {
  frameId?: number;
  geometry?: CaptureFrameGeometry;
  image: AutomationCapturedImage;
  bitmap?: Buffer;
  bitmapSize?: { width: number; height: number };
  deviceOrigin?: { x: number; y: number };
  deviceSize: { width: number; height: number };
  cssSize: { width: number; height: number };
  regionCssSize?: { width: number; height: number };
  captureMs?: number;
  bitmapMs?: number;
};

export type OcrTextItem = {
  text: string;
  score: number;
  box: Array<[number, number]>;
};

export interface AutomationVisionMatcher {
  find(
    asset: string,
    frame: AutomationCapturedFrame,
    options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask },
    signal: AbortSignal,
  ): Promise<ImageMatch | null>;
  findMany?(
    assets: string[],
    frame: AutomationCapturedFrame,
    options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask },
    signal: AbortSignal,
  ): Promise<ImageMatch | null>;
  getStats?(): Partial<ImageMatch>;
}

export interface AutomationOcrEngine {
  readonly providerId?: string;
  recognize(frame: AutomationCapturedFrame, signal: AbortSignal): Promise<OcrTextItem[]>;
  close?(): Promise<void>;
}
