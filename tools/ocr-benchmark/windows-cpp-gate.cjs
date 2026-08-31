const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..', '..');
const corpusRoot = path.resolve(process.argv[2] || path.join(root, '.cache', 'ocr-benchmark', 'corpus'));
const runtime = path.resolve(process.env.BAO_OCR_CPP_CANDIDATE_DIR
  || path.join(root, '.cache', 'ocr', 'windows-cpp-candidate'));
const executable = path.join(runtime, 'bao-paddle-ocr-sidecar.exe');
const requestCount = Math.max(1, Number(process.env.BAO_OCR_GATE_REQUESTS || 1000));
const timeoutMs = 30000;
const normalize = (value) => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();

async function loadFrame(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index]; data[index] = data[index + 2]; data[index + 2] = red;
  }
  return { bitmap: data, width: info.width, height: info.height };
}

class Sidecar {
  constructor() { this.nextId = 1; this.buffer = ''; this.lines = []; this.waiters = []; }
  async start() {
    this.child = spawn(executable, [], { cwd: runtime, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.resume();
    this.exit = new Promise((resolve) => this.child.once('exit', (code, signal) => {
      this.rejectAll(new Error(`sidecar exited (${code ?? signal})`)); resolve({ code, signal });
    }));
    await this.nextLine((line) => { try { return JSON.parse(line).type === 'ready'; } catch { return false; } });
  }
  onData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const end = this.buffer.indexOf('\n'); const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      const index = this.waiters.findIndex((waiter) => waiter.test(line));
      if (index < 0) this.lines.push(line);
      else { const [waiter] = this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(line); }
    }
  }
  nextLine(test) {
    const existing = this.lines.findIndex(test);
    if (existing >= 0) return Promise.resolve(this.lines.splice(existing, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { this.waiters = this.waiters.filter((item) => item !== waiter); reject(new Error('sidecar response timed out')); }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  rejectAll(error) { for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); } }
  async recognize(frame) {
    const id = this.nextId++;
    const header = Buffer.from(JSON.stringify({ id, width: frame.width, height: frame.height, format: 'bgra' }));
    const prefix = Buffer.alloc(12); prefix.write('BAO1'); prefix.writeUInt32LE(header.length, 4); prefix.writeUInt32LE(frame.bitmap.length, 8);
    this.child.stdin.write(Buffer.concat([prefix, header, frame.bitmap]));
    const line = await this.nextLine((value) => { try { return JSON.parse(value).id === id; } catch { return false; } });
    const response = JSON.parse(line); if (response.type === 'error') throw new Error(response.error); return response.items || [];
  }
  rss() {
    return Number(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${this.child.pid} -ErrorAction Stop).WorkingSet64`],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim());
  }
  async gracefulClose() { this.child.stdin.end(); return Promise.race([this.exit, new Promise((_, reject) => setTimeout(() => reject(new Error('graceful close timed out')), 3000))]); }
  async kill() { this.child.kill(); return this.exit; }
}

function assertExpected(sample, items) {
  const actualText = items.map((item) => item.text || '').join('');
  if (sample.expectedText !== undefined && normalize(actualText) !== normalize(sample.expectedText)) {
    throw new Error(`${sample.id}: expected ${JSON.stringify(sample.expectedText)}, got ${JSON.stringify(actualText)}`);
  }
  if (sample.expectedNumber !== undefined) {
    const match = actualText.replace(/[,，\s]/g, '').match(/[-+]?\d+(?:\.\d+)?/u);
    if (!match || Number(match[0]) !== sample.expectedNumber) throw new Error(`${sample.id}: expected number ${sample.expectedNumber}, got ${JSON.stringify(actualText)}`);
  }
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`candidate executable not found: ${executable}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8'));
  const samples = await Promise.all(manifest.samples.map(async (sample) => ({ ...sample, frame: await loadFrame(path.join(corpusRoot, sample.file)) })));
  const sidecar = new Sidecar(); const startupAt = performance.now(); await sidecar.start(); const coldStartMs = performance.now() - startupAt;
  const latencies = []; let peakRssBytes = sidecar.rss();
  for (let index = 0; index < requestCount; index += 1) {
    const sample = samples[index % samples.length]; const started = performance.now();
    assertExpected(sample, await sidecar.recognize(sample.frame)); latencies.push(performance.now() - started);
    if ((index + 1) % 100 === 0) peakRssBytes = Math.max(peakRssBytes, sidecar.rss());
  }
  const gracefulExit = await sidecar.gracefulClose();
  const interrupted = new Sidecar(); await interrupted.start(); const pending = interrupted.recognize(samples[0].frame).catch(() => null); await interrupted.kill(); await pending;
  const recovered = new Sidecar(); await recovered.start(); assertExpected(samples[0], await recovered.recognize(samples[0].frame)); await recovered.gracefulClose();
  const sorted = [...latencies].sort((a, b) => a - b);
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), executable, requestCount, failures: 0,
    coldStartMs, meanMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], peakRssBytes, gracefulExit,
    interruptedRequestRejected: true, restartAfterInterruption: true,
  };
  const output = path.join(root, '.cache', 'ocr-benchmark', `windows-cpp-gate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, peakRssMiB: peakRssBytes / 1048576, output }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
