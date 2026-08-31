const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..', '..');
const corpusRoot = path.resolve(process.argv[2] || path.join(root, '.cache', 'ocr-benchmark', 'corpus'));
const rounds = Math.max(1, Number(process.env.BAO_OCR_BENCHMARK_ROUNDS || 3));
const warmups = Math.max(0, Number(process.env.BAO_OCR_BENCHMARK_WARMUPS || 5));
const timeoutMs = Math.max(1000, Number(process.env.BAO_OCR_BENCHMARK_TIMEOUT_MS || 30000));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (value) => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]; previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) { const above = previous[j]; previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = above; }
  }
  return previous[b.length];
}
function parseNumber(value) { const match = value.replace(/[,，\s]/g, '').match(/[-+]?\d+(?:\.\d+)?/u); return match ? Number(match[0]) : null; }
function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function directoryBytes(directory) { if (!fs.existsSync(directory)) return 0; return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => { const target = path.join(directory, entry.name); return total + (entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size); }, 0); }
async function loadFrame(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) { const red = data[index]; data[index] = data[index + 2]; data[index + 2] = red; }
  return { bitmap: data, width: info.width, height: info.height };
}

class LineProcess {
  constructor(command, args, cwd, readyTest) { this.command = command; this.args = args; this.cwd = cwd; this.readyTest = readyTest; this.child = null; this.buffer = ''; this.lines = []; this.waiters = []; }
  async start() {
    const started = performance.now(); this.child = spawn(this.command, this.args, { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8'); this.child.stdout.on('data', (chunk) => this.onData(chunk)); this.child.stderr.on('data', () => {});
    this.child.once('exit', (code) => this.rejectAll(new Error(`sidecar exited (${code})`))); await this.nextLine(this.readyTest, timeoutMs); return performance.now() - started;
  }
  onData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) { const index = this.buffer.indexOf('\n'); const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1); if (!line) continue; const waiterIndex = this.waiters.findIndex((waiter) => waiter.test(line)); if (waiterIndex < 0) this.lines.push(line); else { const [waiter] = this.waiters.splice(waiterIndex, 1); clearTimeout(waiter.timer); waiter.resolve(line); } }
  }
  nextLine(test, timeout) {
    const existing = this.lines.findIndex(test); if (existing >= 0) return Promise.resolve(this.lines.splice(existing, 1)[0]);
    return new Promise((resolve, reject) => { const waiter = { test, resolve, reject, timer: null }; waiter.timer = setTimeout(() => { this.waiters = this.waiters.filter((item) => item !== waiter); reject(new Error(`sidecar response timed out after ${timeout}ms`)); }, timeout); this.waiters.push(waiter); });
  }
  rejectAll(error) { for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); } }
  async close() { const child = this.child; this.child = null; if (!child) return; child.kill(); await sleep(50); }
}

function processRssBytes(lineProcess, state) {
  const pid = lineProcess?.child?.pid;
  if (!pid) return state.last;
  state.calls += 1;
  if (state.last !== null && state.calls % 25 !== 1) return state.last;
  try {
    const output = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    const value = Number(output);
    if (Number.isFinite(value)) state.last = value;
  } catch {}
  return state.last;
}

class PaddleBao1Provider {
  constructor() {
    this.id = 'paddle-inference-bao1-ppocrv3';
    this.directory = path.resolve(process.env.BAO_OCR_RUNTIME_DIR || (process.platform === 'win32'
      ? path.join(root, 'native', 'ocr', 'win64')
      : path.join(root, 'native', 'ocr', 'paddle', `${process.platform}-${process.arch}`)));
    this.executable = path.join(this.directory, process.platform === 'win32' ? 'bao-paddle-ocr-sidecar.exe' : 'bao-paddle-ocr-sidecar');
    this.nextId = 1; this.runtimeBytes = directoryBytes(this.directory); this.rssState = { calls: 0, last: null };
  }
  async start() {
    this.process = new LineProcess(this.executable, [], this.directory, (line) => { try { return JSON.parse(line).type === 'ready'; } catch { return false; } }); return this.process.start();
  }
  async recognize(frame) { const id = this.nextId++; const header = Buffer.from(JSON.stringify({ id, width: frame.width, height: frame.height, format: 'bgra' })); const prefix = Buffer.alloc(12); prefix.write('BAO1'); prefix.writeUInt32LE(header.length, 4); prefix.writeUInt32LE(frame.bitmap.length, 8); this.process.child.stdin.write(Buffer.concat([prefix, header, frame.bitmap])); const line = await this.process.nextLine((value) => { try { return JSON.parse(value).id === id; } catch { return false; } }, timeoutMs); const response = JSON.parse(line); if (response.type === 'error') throw new Error(response.error); return response.items || []; }
  rss() { return processRssBytes(this.process, this.rssState); }
  close() { return this.process.close(); }
}

async function benchmark(Provider, samples) {
  const provider = new Provider(); const coldStartMs = await provider.start();
  for (let index = 0; index < warmups; index += 1) await provider.recognize(samples[index % samples.length].frame);
  const results = []; let peakRssBytes = provider.rss();
  for (let round = 1; round <= rounds; round += 1) {
    const order = round % 2 ? [...samples] : [...samples].reverse();
    for (const sample of order) {
      const started = performance.now();
      try {
        const items = await provider.recognize(sample.frame); const actualText = items.map((item) => item.text || '').join(''); const actual = normalize(actualText); const expected = sample.expectedText === undefined ? null : normalize(sample.expectedText);
        results.push({ id: sample.id, suite: sample.suite, round, expectedText: sample.expectedText, expectedNumber: sample.expectedNumber, actualText, latencyMs: performance.now() - started, exact: expected === null ? null : actual === expected, similarity: expected === null ? null : 1 - editDistance(actual, expected) / Math.max(1, actual.length, expected.length), numberCorrect: sample.expectedNumber === undefined ? null : parseNumber(actualText) === sample.expectedNumber, error: null });
      } catch (error) { results.push({ id: sample.id, suite: sample.suite, round, latencyMs: performance.now() - started, exact: sample.expectedText === undefined ? null : false, similarity: sample.expectedText === undefined ? null : 0, numberCorrect: sample.expectedNumber === undefined ? null : false, error: error.message }); }
      const rss = provider.rss(); if (rss !== null) peakRssBytes = Math.max(peakRssBytes || 0, rss);
    }
  }
  const providerId = provider.id; const runtimeBytes = provider.runtimeBytes; await provider.close();
  const summarize = (subset) => { const text = subset.filter((item) => item.exact !== null); const numbers = subset.filter((item) => item.numberCorrect !== null); return { samples: subset.length, exactTextAccuracy: mean(text.map((item) => item.exact ? 1 : 0)), normalizedEditSimilarity: mean(text.map((item) => item.similarity)), numberAccuracy: mean(numbers.map((item) => item.numberCorrect ? 1 : 0)), p95Ms: percentile(subset.map((item) => item.latencyMs), .95) }; };
  const suites = {}; for (const suite of [...new Set(results.map((item) => item.suite))]) suites[suite] = summarize(results.filter((item) => item.suite === suite));
  const summary = summarize(results); const latencies = results.map((item) => item.latencyMs);
  return { provider: providerId, coldStartMs, runtimeBytes, peakRssBytes, rounds, warmups, samples: samples.length, ...summary, latencyMs: { mean: mean(latencies), p50: percentile(latencies, .5), p95: percentile(latencies, .95) }, failures: results.filter((item) => item.error).length, suites, results };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8')); const samples = await Promise.all(manifest.samples.map(async (sample) => ({ ...sample, frame: await loadFrame(path.join(corpusRoot, sample.file)) })));
  const reports = [];
  const report = await benchmark(PaddleBao1Provider, samples); reports.push(report); console.log(`${report.provider}: text=${(report.exactTextAccuracy * 100).toFixed(1)}% number=${(report.numberAccuracy * 100).toFixed(1)}% p95=${report.latencyMs.p95.toFixed(1)}ms RSS=${report.peakRssBytes === null ? 'n/a' : `${(report.peakRssBytes / 1048576).toFixed(1)}MiB`}`);
  const output = { schemaVersion: 1, generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, corpus: corpusRoot, reports };
  const outputDirectory = path.join(root, '.cache', 'ocr-benchmark'); fs.mkdirSync(outputDirectory, { recursive: true }); const outputFile = path.join(outputDirectory, `result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`); fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`); console.log(`Detailed result: ${outputFile}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
