// Evaluation only: a persistent x86 Tesseract C-API worker versus our Paddle sidecar.
// Set BAO_TESSERACT_RUNTIME_DIR to a folder containing ocr-worker.exe, native DLLs,
// and tessdata-fast/{chi_sim,eng}.traineddata. Compile tesseract-x86-worker.cs with /platform:x86.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { benchmark, loadFrame, LineProcess, PaddleBao1Provider, directoryBytes, processRssBytes } = require('./run.cjs');
const root = path.resolve(__dirname, '../..');
const directory = path.resolve(process.env.BAO_TESSERACT_RUNTIME_DIR || '.cache/tesseract-x86/runtime');

function tesseractProvider(psm, upscale) {
  return class {
    constructor() {
      this.id = `tesseract-x86-psm${psm}${upscale === 'contrast' ? '-contrast' : upscale ? '-3x-pad' : '-raw'}`;
      this.runtimeBytes = directoryBytes(directory);
      this.rssState = { calls: 0, last: null };
    }
    async start() {
      this.process = new LineProcess(path.join(directory, 'ocr-worker.exe'), [path.join(directory, 'tessdata-fast')], directory, (line) => {
        if (!line.startsWith('READY\t')) return false;
        const fields = line.split('\t');
        this.processBits = Number(fields[1]) * 8;
        this.engineVersion = fields[2];
        return true;
      });
      const ms = await this.process.start();
      return ms;
    }
    async recognize(frame) {
      const filename = upscale === 'contrast' ? frame.tesseractContrast : upscale ? frame.tesseractUpscaled : frame.filename;
      this.process.child.stdin.write(`${Buffer.from(filename).toString('base64')}\t${psm}\n`);
      const line = await this.process.nextLine((value) => /^(OK|ERR)\t/.test(value), 30000);
      const parts = line.split('\t');
      if (parts[0] === 'ERR') throw new Error(Buffer.from(parts[1], 'base64').toString('utf8'));
      return [{ text: Buffer.from(parts[2] || '', 'base64').toString('utf8') }];
    }
    rss() { return processRssBytes(this.process, this.rssState); }
    close() { return this.process.close(); }
  };
}

async function main() {
  const output = path.join(root, '.cache/ocr-benchmark/tesseract-comparison');
  fs.mkdirSync(output, { recursive: true });
  const corpus = path.join(root, '.cache/ocr-benchmark/corpus');
  const synthetic = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8')).samples
    .map((sample) => ({ ...sample, filename: path.join(corpus, sample.file) }));
  // Manually transcribed game captures. Icon-only samples check false positives.
  const fishing = path.join(root, '.cache/ocr-benchmark/fishing');
  const real = [
    ['拉杆', '拉杆'], ['收线', '收线'], ['test2', '收线'],
    ['test', '转身技能钓鱼复制昵称职业'], ['test1', ''],
  ].filter(([name]) => fs.existsSync(path.join(fishing, `${name}.png`)))
    .map(([name, expectedText], index) => ({ id: `real-${index + 1}`, suite: 'real-game', expectedText, filename: path.join(fishing, `${name}.png`) }));
  const samples = [];
  for (const sample of [...synthetic, ...real]) {
    const frame = await loadFrame(sample.filename);
    const padded = path.join(output, `${sample.id}-3x.png`);
    await sharp(sample.filename).flatten({ background: '#ffffff' })
      .resize(frame.width * 3, frame.height * 3, { kernel: 'nearest' })
      .extend({ top: 24, bottom: 24, left: 24, right: 24, background: '#ffffff' }).png().toFile(padded);
    const contrast = path.join(output, `${sample.id}-contrast.png`);
    const gray = await sharp(sample.filename).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer();
    const darkBackground = gray[Math.floor(frame.width / 2)] < 128;
    let processed = sharp(gray, { raw: { width: frame.width, height: frame.height, channels: 1 } });
    if (darkBackground) processed = processed.negate();
    const scale = frame.height < 70 ? 2 : 1;
    await processed.normalise().threshold(160).resize(frame.width * scale, frame.height * scale, { kernel: 'nearest' })
      .extend({ top: 12, bottom: 12, left: 12, right: 12, background: '#ffffff' }).png().toFile(contrast);
    samples.push({ ...sample, frame: { ...frame, filename: sample.filename, tesseractUpscaled: padded, tesseractContrast: contrast } });
  }
  const reports = process.env.BAO_TESSERACT_EXTRA_ONLY ? JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')).reports : [];
  for (const Provider of [PaddleBao1Provider, tesseractProvider(6, false), tesseractProvider(7, false), tesseractProvider(11, false), tesseractProvider(6, true), tesseractProvider(7, true), tesseractProvider(6, 'contrast'), tesseractProvider(7, 'contrast')]) {
    if (process.env.BAO_TESSERACT_EXTRA_ONLY && !new Provider().id.includes('contrast')) continue;
    const report = await benchmark(Provider, samples);
    reports.push(report);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
    console.log(JSON.stringify({ provider: report.provider, text: report.exactTextAccuracy, numbers: report.numberAccuracy, latency: report.latencyMs, suites: report.suites, failures: report.failures }));
  }
  console.log(`Results: ${path.join(output, 'results.json')}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
