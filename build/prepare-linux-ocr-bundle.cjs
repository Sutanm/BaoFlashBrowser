const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error || result.status}`);
}

async function main() {
  const archive = path.join(root, '.cache/ocr/paddle-linux-x64-manylinux.tar.gz');
  if (!fs.existsSync(archive)) {
    if (process.platform !== 'linux') throw new Error('Build the Linux OCR runtime on Linux with Docker');
    const source = path.join(root, '.cache/paddle-cpp/PaddleOCR-release-2.7');
    const commit = '8cce9b6fd7ccb50226d0c38f94054d81c29b8184';
    fs.mkdirSync(path.dirname(source), { recursive: true });
    if (!fs.existsSync(source)) {
      run('git', ['clone', '--no-checkout', 'https://github.com/PaddlePaddle/PaddleOCR.git', source]);
    }
    run('git', ['-C', source, 'checkout', '--detach', commit]);
    const inference = path.join(path.dirname(source), 'paddle_inference-2.6.2-linux-cpu-avx-mkl.tgz');
    const expected = '9e85ebe7a11a2074e43969094d8759a251d23102be7d85092e433c5cf2a488a8';
    const valid = () => fs.existsSync(inference) && crypto.createHash('sha256').update(fs.readFileSync(inference)).digest('hex') === expected;
    if (!valid()) {
      const response = await fetch('https://paddle-inference-lib.bj.bcebos.com/2.6.2/cxx_c/Linux/CPU/gcc8.2_avx_mkl/paddle_inference.tgz', { signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`Paddle download failed: ${response.status}`);
      fs.writeFileSync(inference, Buffer.from(await response.arrayBuffer()));
      if (!valid()) throw new Error('Paddle Inference SHA-256 mismatch');
    }
    // Reuse the pinned PP-OCRv3 models; this step does not execute Windows code.
    run(process.execPath, ['build/prepare-ocr-runtime.cjs']);
    run('docker', ['build', '-t', 'bao-paddle-manylinux', '-f', 'tools/ocr-paddle-cpp/Dockerfile.manylinux', '.']);
    run('docker', ['run', '--rm', '-v', `${root}:/workspace`, 'bao-paddle-manylinux']);
  }
  run(process.execPath, ['build/install-paddle-linux-runtime.cjs']);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
