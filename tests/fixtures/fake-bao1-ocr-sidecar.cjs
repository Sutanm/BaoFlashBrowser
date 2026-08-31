const mode = process.argv[2] || 'normal';
let pending = Buffer.alloc(0);

process.stdout.write(`${JSON.stringify({ type: 'ready', protocol: 1, provider: 'fixture', model: 'fixture' })}\n`);
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 12) {
    if (pending.subarray(0, 4).toString('ascii') !== 'BAO1') process.exit(2);
    const headerLength = pending.readUInt32LE(4);
    const bitmapLength = pending.readUInt32LE(8);
    if (pending.length < 12 + headerLength + bitmapLength) return;
    const header = JSON.parse(pending.subarray(12, 12 + headerLength).toString('utf8'));
    const bitmap = pending.subarray(12 + headerLength, 12 + headerLength + bitmapLength);
    pending = pending.subarray(12 + headerLength + bitmapLength);
    if (mode === 'timeout') continue;
    if (mode === 'bad') {
      process.stdout.write(`${JSON.stringify({ type: 'result', id: header.id, items: 'invalid' })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({
      type: 'result', id: header.id,
      items: [{ text: `像素${bitmap[0]}`, score: 0.98, box: [[1, 2], [31, 2], [31, 18], [1, 18]] }],
      timings: { ocrMs: 2 },
    })}\n`);
  }
});
