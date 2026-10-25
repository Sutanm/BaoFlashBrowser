import { existsSync } from 'fs';
import path from 'path';

let compiler: typeof import('esbuild') | null = null;

export function getJsCompiler(): typeof import('esbuild') {
  if (compiler) return compiler;
  // esbuild uses spawn(), which cannot execute a binary inside Electron's
  // ASAR archive. The runtime dependency is explicitly unpacked by the builder.
  const entry = require.resolve('esbuild');
  const marker = '.asar' + path.sep;
  const index = entry.indexOf(marker);
  if (index >= 0 && !process.env.ESBUILD_BINARY_PATH) {
    const physicalEntry = entry.slice(0, index + 5) + '.unpacked' + entry.slice(index + 5);
    const modules = path.resolve(path.dirname(physicalEntry), '..', '..');
    const binary = path.join(modules, '@esbuild', `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild');
    if (existsSync(binary)) process.env.ESBUILD_BINARY_PATH = binary;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  compiler = require('esbuild') as typeof import('esbuild');
  return compiler;
}
