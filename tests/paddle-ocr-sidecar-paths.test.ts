import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  paddleOcrSidecarExecutable,
  paddleOcrSidecarRuntimeDirectory,
} from '../src/main/modules/automation/paddle-ocr-sidecar-engine';

describe('Paddle OCR BAO1 runtime paths', () => {
  it('uses the existing Windows OCR runtime directory and .exe sidecar', () => {
    const directory = paddleOcrSidecarRuntimeDirectory('win32', 'x64');
    expect(directory).toBe(path.resolve(process.cwd(), 'native', 'ocr', 'win64'));
    expect(paddleOcrSidecarExecutable(directory, 'win32')).toBe(path.join(directory, 'bao-paddle-ocr-sidecar.exe'));
  });

  it('keeps the Linux Paddle runtime layout and extensionless executable', () => {
    const directory = paddleOcrSidecarRuntimeDirectory('linux', 'x64');
    expect(directory).toBe(path.resolve(process.cwd(), 'native', 'ocr', 'paddle', 'linux-x64'));
    expect(paddleOcrSidecarExecutable(directory, 'linux')).toBe(path.join(directory, 'bao-paddle-ocr-sidecar'));
  });
});
