import { nativeImage } from 'electron';
import type {
  AutomationTemplatePixels,
  AutomationTemplateProvider,
} from './vision-worker-matcher';

export type AutomationTemplateAsset = {
  cacheKey: string;
  bytes: Uint8Array;
};

export type AutomationTemplateAssetLoader = {
  load(asset: string, signal: AbortSignal): Promise<AutomationTemplateAsset>;
};

export class NativeImageTemplateProvider implements AutomationTemplateProvider {
  private readonly loader: AutomationTemplateAssetLoader;

  constructor(loader: AutomationTemplateAssetLoader) {
    this.loader = loader;
  }

  async load(asset: string, signal: AbortSignal): Promise<AutomationTemplatePixels> {
    if (signal.aborted) throw new Error('automation cancelled');
    const source = await this.loader.load(asset, signal);
    if (signal.aborted) throw new Error('automation cancelled');
    const image = nativeImage.createFromBuffer(Buffer.from(source.bytes));
    if (image.isEmpty()) throw new Error(`unable to decode automation image asset: ${asset}`);
    const size = image.getSize();
    return {
      cacheKey: source.cacheKey,
      width: size.width,
      height: size.height,
      bgra: Uint8Array.from(image.toBitmap()),
    };
  }
}
