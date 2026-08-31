import fs from 'fs';
import path from 'path';
import { Bao1OcrSidecarEngine } from './bao1-ocr-sidecar-engine';

export function paddleOcrSidecarRuntimeDirectory(platform = process.platform, arch = process.arch): string {
  const packagedRoot = path.join(process.resourcesPath ?? '', 'native', 'ocr');
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar'))) {
    return platform === 'win32' ? packagedRoot : path.join(packagedRoot, 'paddle');
  }
  if (platform === 'win32') return path.resolve(process.cwd(), 'native', 'ocr', 'win64');
  return path.resolve(process.cwd(), 'native', 'ocr', 'paddle', `${platform}-${arch}`);
}

export function paddleOcrSidecarExecutable(directory = paddleOcrSidecarRuntimeDirectory(), platform = process.platform): string {
  return path.join(directory, platform === 'win32' ? 'bao-paddle-ocr-sidecar.exe' : 'bao-paddle-ocr-sidecar');
}

export function bundledPaddleOcrSidecarAvailable(directory = paddleOcrSidecarRuntimeDirectory(), platform = process.platform, arch = process.arch): boolean {
  return ['win32', 'linux'].includes(platform) && arch === 'x64'
    && fs.existsSync(paddleOcrSidecarExecutable(directory, platform));
}

export class PaddleOcrSidecarEngine extends Bao1OcrSidecarEngine {
  constructor() {
    const directory = paddleOcrSidecarRuntimeDirectory();
    super(
      { executable: paddleOcrSidecarExecutable(directory), cwd: directory },
      30_000,
      30_000,
      'paddle-inference-ppocrv3',
    );
  }
}
