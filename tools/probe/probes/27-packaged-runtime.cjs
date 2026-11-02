// Run this probe with the target architecture's Electron runtime.
const path = require('path');

module.exports = {
  id: '27-packaged-runtime',
  name: 'packaged esbuild and OpenCV (opt-in)',
  needsElectron: true,
  timeoutMs: 45_000,
  async run() {
    if (!process.env.BAO_PROBE_PACKAGE_ROOT) {
      return { ok: true, summary: 'set BAO_PROBE_PACKAGE_ROOT to test an unpacked release' };
    }
    const resources = path.join(path.resolve(process.env.BAO_PROBE_PACKAGE_ROOT), 'resources');
    const previous = process.env.ESBUILD_BINARY_PATH;
    try {
      process.env.ESBUILD_BINARY_PATH = path.join(resources, 'native', 'esbuild', process.platform === 'win32' ? 'esbuild.exe' : 'esbuild');
      const compiler = require(path.join(resources, 'app.asar', 'node_modules', 'esbuild'));
      const output = await compiler.transform('class Test { static { this.value = 42; } }', { target: 'chrome87' });
      if (output.code.includes('static {')) throw new Error('esbuild did not lower static block');
      const cv = require(path.join(resources, 'app.asar.unpacked', 'node_modules', '@techstark', 'opencv-js'));
      if (typeof cv.then === 'function') await new Promise((resolve) => cv.then(() => resolve()));
      const matrix = cv.Mat.eye(3, 3, cv.CV_8U);
      try {
        if (matrix.rows !== 3 || matrix.cols !== 3) throw new Error('OpenCV matrix failed');
      } finally { matrix.delete(); }
      return { ok: true, summary: `${process.arch}: JS transform + OpenCV matrix passed` };
    } finally {
      if (previous === undefined) delete process.env.ESBUILD_BINARY_PATH;
      else process.env.ESBUILD_BINARY_PATH = previous;
    }
  },
};
