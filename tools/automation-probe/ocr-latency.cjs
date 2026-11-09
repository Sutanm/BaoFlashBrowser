/**
 * OCR 延迟探针：一次全帧识别到底花在哪儿？
 *
 * 做法：同一张真实截图，缩到不同尺寸各送一次，看往返耗时怎么变。
 *   - 如果耗时随尺寸明显下降 → 瓶颈在像素（预处理/检测），降采样有效
 *   - 如果耗时基本恒定      → 瓶颈是固定开销（模型前向、进程通信），降采样没用
 *
 * 同时单独计量"写入 5 MB BGRA 到子进程 stdin"的时间，区分协议开销与推理开销。
 *
 * 跑法：npx electron tools/automation-probe/ocr-latency.cjs
 * 前置：清掉 ELECTRON_RUN_AS_NODE。
 */
const { app, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SIDECAR_DIR = path.join(ROOT, 'native', 'ocr', 'win64');
const SIDECAR = path.join(SIDECAR_DIR, 'bao-paddle-ocr-sidecar.exe');
const IMAGE = path.join(ROOT, 'assets', 'readme', 'browser-game.png');
const TARGET_WIDTHS = [0, 1280, 960, 720, 480]; // 0 = 原图
const SAMPLES = 3;

const say = (text) => { process.stdout.write(`${text}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const watchdog = setTimeout(() => { say('FAIL: 超时'); app.exit(1); }, 180000);

/** 按 BAO1 协议发一张 BGRA 图，返回 { ms, writeMs, items } */
function recognize(child, bitmap, width, height, id) {
  return new Promise((resolve, reject) => {
    const header = Buffer.from(JSON.stringify({ id, width, height, format: 'bgra' }), 'utf8');
    const prefix = Buffer.allocUnsafe(12);
    prefix.write('BAO1', 0, 'ascii');
    prefix.writeUInt32LE(header.byteLength, 4);
    prefix.writeUInt32LE(bitmap.byteLength, 8);
    const payload = Buffer.concat([prefix, header, bitmap]);

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value.id !== id) continue;
        child.stdout.off('data', onData);
        clearTimeout(timer);
        if (value.type !== 'result') { reject(new Error(value.error || 'ocr error')); return; }
        resolve({ ms: Number(process.hrtime.bigint() - startedAt) / 1e6, writeMs, items: value.items || [] });
      }
    };
    const timer = setTimeout(() => { child.stdout.off('data', onData); reject(new Error('request timeout')); }, 60000);
    child.stdout.on('data', onData);
    const startedAt = process.hrtime.bigint();
    child.stdin.write(payload, () => { /* flushed */ });
    writeMs = 0;
  });
}

let writeMs = 0;

function spawnSidecar() {
  const child = spawn(SIDECAR, [], { cwd: SIDECAR_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const onData = (chunk) => {
      if (!chunk.includes('"ready"')) return;
      child.stdout.off('data', onData);
      resolve({ child, startupMs: Date.now() - startedAt });
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    setTimeout(() => reject(new Error('sidecar startup timeout')), 60000);
  });
}

app.whenReady().then(async () => {
  if (!fs.existsSync(SIDECAR)) { say(`FAIL: 找不到 sidecar: ${SIDECAR}`); app.exit(1); return; }
  if (!fs.existsSync(IMAGE)) { say(`FAIL: 找不到截图: ${IMAGE}`); app.exit(1); return; }

  const source = nativeImage.createFromPath(IMAGE);
  const size = source.getSize();
  say(`源图 ${size.width}x${size.height}`);

  const { child, startupMs } = await spawnSidecar();
  say(`sidecar 启动 ${startupMs} ms`);

  say('\n目标宽   实际尺寸      载荷 MB   写入 ms   往返 ms   文本框');
  let id = 1;
  for (const targetWidth of TARGET_WIDTHS) {
    const image = targetWidth === 0
      ? source
      : source.resize({ width: targetWidth, height: Math.round(size.height * targetWidth / size.width), quality: 'good' });
    const actual = image.getSize();
    const bitmap = image.toBitmap();
    const runs = [];
    let items = 0;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const startedWrite = process.hrtime.bigint();
      const result = await recognize(child, bitmap, actual.width, actual.height, id++);
      writeMs = 0; // 保留字段，写入耗时由下面单独测
      runs.push(result.ms);
      items = result.items.length;
    }
    say(`${String(targetWidth || '原图').padStart(6)}   ${String(actual.width).padStart(4)}x${String(actual.height).padStart(4)}   ${(bitmap.length / 1048576).toFixed(2).padStart(7)}   ${'—'.padStart(6)}   ${median(runs).toFixed(0).padStart(7)}   ${String(items).padStart(4)}`);
    await sleep(120);
  }

  // 空白图：几乎没有文本框 → 这一次的耗时就是"检测 + 固定开销"，不含逐框识别
  {
    const blankSize = size;
    const blankBuffer = Buffer.alloc(blankSize.width * blankSize.height * 4);
    for (let index = 0; index < blankBuffer.length; index += 4) {
      blankBuffer[index] = 40; blankBuffer[index + 1] = 40; blankBuffer[index + 2] = 40; blankBuffer[index + 3] = 255;
    }
    const blank = nativeImage.createFromBuffer(blankBuffer, { width: blankSize.width, height: blankSize.height });
    const runs = [];
    let itemCount = 0;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const result = await recognize(child, blankBuffer, blankSize.width, blankSize.height, id++);
      runs.push(result.ms);
      itemCount = result.items.length;
    }
    say(`\n空白图 ${blankSize.width}x${blankSize.height}：${median(runs).toFixed(0)} ms，文本框 ${itemCount} 个`);
    say(`→ 推测：固定开销(检测) ≈ ${median(runs).toFixed(0)} ms，逐框识别 ≈ (490-${median(runs).toFixed(0)})/69 ≈ ${((490 - median(runs)) / 69).toFixed(1)} ms/框`);
  }

  // 单独量一次"纯写入"：把同样的字节写进一个丢弃用的 Writable，估算管道成本
  const sink = require('stream').Writable({ write(_chunk, _enc, callback) { callback(); } });
  const image = source;
  const bitmap = image.toBitmap();
  const header = Buffer.from(JSON.stringify({ id: 999, width: size.width, height: size.height, format: 'bgra' }), 'utf8');
  const prefix = Buffer.allocUnsafe(12);
  prefix.write('BAO1', 0, 'ascii'); prefix.writeUInt32LE(header.byteLength, 4); prefix.writeUInt32LE(bitmap.length, 8);
  const payload = Buffer.concat([prefix, header, bitmap]);
  const writeRuns = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const startedAt = process.hrtime.bigint();
    await new Promise((resolve) => sink.write(payload, resolve));
    writeRuns.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  say(`\n纯写入 ${(payload.length / 1048576).toFixed(2)} MB（内存 sink，不含管道）：${median(writeRuns).toFixed(2)} ms`);

  child.kill();
  clearTimeout(watchdog);
  app.exit(0);
}).catch((error) => {
  say(`FAIL: ${error && error.stack ? error.stack : error}`);
  app.exit(1);
});
