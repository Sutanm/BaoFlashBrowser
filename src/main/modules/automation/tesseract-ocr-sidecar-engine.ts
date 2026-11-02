import fs from 'fs';
import path from 'path';
import { Bao1OcrSidecarEngine } from './bao1-ocr-sidecar-engine';

export function tesseractOcrRuntimeDirectory(): string {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar'))) {
    return path.join(process.resourcesPath, 'native', 'ocr');
  }
  return path.resolve(process.cwd(), 'native', 'ocr', 'win32');
}

export function bundledTesseractOcrAvailable(): boolean {
  return process.platform === 'win32' && process.arch === 'ia32'
    && fs.existsSync(path.join(tesseractOcrRuntimeDirectory(), 'bao-tesseract-ocr-sidecar.exe'));
}

export class TesseractOcrSidecarEngine extends Bao1OcrSidecarEngine {
  constructor() {
    const directory = tesseractOcrRuntimeDirectory();
    super({ executable: path.join(directory, 'bao-tesseract-ocr-sidecar.exe'), cwd: directory },
      30_000, 30_000, 'tesseract-5.3.0-x86');
  }
}
