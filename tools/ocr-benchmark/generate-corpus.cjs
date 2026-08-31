const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..', '..');
const outputRoot = path.join(root, '.cache', 'ocr-benchmark', 'corpus');
const escapeXml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function render(sample) {
  const width = sample.width || 360; const height = sample.height || 96; const fontSize = sample.fontSize || 32;
  const text = escapeXml(sample.text); const foreground = sample.foreground || '#202124'; const background = sample.background || '#f5f6f8';
  const shadow = sample.shadow ? `<text x="${width / 2 + 2}" y="${height / 2 + fontSize * .36 + 2}" text-anchor="middle" fill="#fff" opacity=".8">${text}</text>` : '';
  const noise = sample.noise ? '<path d="M0 18 H360 M0 76 H360" stroke="#58708a" opacity=".22"/><circle cx="28" cy="23" r="16" fill="#ffb84d" opacity=".28"/><circle cx="325" cy="73" r="24" fill="#4388cc" opacity=".25"/>' : '';
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" rx="${sample.radius || 0}" fill="${background}"/>${noise}<g font-family="Microsoft YaHei, SimHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}px" font-weight="${sample.bold ? 700 : 400}">${shadow}<text x="${width / 2}" y="${height / 2 + fontSize * .36}" text-anchor="middle" fill="${foreground}">${text}</text></g></svg>`);
  let image = sharp(svg).png();
  if (sample.lowRes) image = image.resize(Math.max(40, Math.round(width * sample.lowRes)), Math.max(18, Math.round(height * sample.lowRes)), { kernel: 'nearest' });
  await image.toFile(path.join(outputRoot, `${sample.id}.png`));
}

async function main() {
  fs.rmSync(outputRoot, { recursive: true, force: true }); fs.mkdirSync(outputRoot, { recursive: true });
  const samples = [];
  ['开始游戏', '购买', '出售', '确定', '取消', '背包', '商店', '登录', '保存', '运行', '暂停', '继续', '返回', '下一步', '领取奖励', '任务完成', '服务器繁忙', '金币不足', '自动战斗', '当前价格'].forEach((text, index) => samples.push({
    id: `ui-zh-${String(index + 1).padStart(3, '0')}`, suite: 'ui-zh', text, expectedText: text, width: index % 3 ? 360 : 220, height: 86, fontSize: index % 4 ? 32 : 24,
    foreground: index % 2 ? '#f7f8fa' : '#17202a', background: index % 2 ? '#315b8f' : '#eef2f5', radius: 10,
  }));
  ['0', '7', '19', '88', '105', '999', '1,280', '12,345', '999,999', '-35', '+18', '0.75', '12.50', '100.00', '￥68', '金币 230', '价格 1,520', '数量 99', '库存 1000', '折扣 -20'].forEach((text, index) => samples.push({
    id: `trade-number-${String(index + 1).padStart(3, '0')}`, suite: 'trade-number', text, expectedNumber: Number(text.replace(/[,，]/g, '').match(/[-+]?\d+(?:\.\d+)?/)[0]),
    width: 280, height: 80, fontSize: 30, bold: true, foreground: index % 2 ? '#ffe15a' : '#1f2328', background: index % 2 ? '#28374c' : '#f2eee4',
  }));
  ['开始游戏', '购买', '确定', '领取', '金币不足', '价格 1280', '数量 20', '88', '9999', '-15.5'].forEach((text, index) => samples.push({
    id: `game-low-res-${String(index + 1).padStart(3, '0')}`, suite: 'game-low-res', text,
    ...(/\d/.test(text) ? { expectedNumber: Number(text.replace(/[,，]/g, '').match(/[-+]?\d+(?:\.\d+)?/)[0]) } : { expectedText: text }),
    width: 300, height: 84, fontSize: index % 2 ? 22 : 26, bold: true, lowRes: index % 2 ? .6 : .75, foreground: '#f4f0df', background: '#3d5268', shadow: true,
  }));
  ['确认购买', '任务完成', '当前价格 860', '剩余数量 32', '继续游戏', '获得金币 500'].forEach((text, index) => samples.push({
    id: `region-noise-${String(index + 1).padStart(3, '0')}`, suite: 'region-noise', text,
    ...(/\d/.test(text) ? { expectedNumber: Number(text.match(/\d+/)[0]) } : { expectedText: text }),
    width: 360, height: 96, fontSize: 27, bold: true, noise: true, foreground: '#f9f4dd', background: index % 2 ? '#445b47' : '#604b57', shadow: true,
  }));
  for (const sample of samples) await render(sample);
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), note: 'Synthetic smoke corpus; final decision also requires real game captures.', samples: samples.map(({ text, ...sample }) => ({ ...sample, file: `${sample.id}.png` })) }, null, 2)}\n`);
  console.log(`Generated ${samples.length} OCR samples in ${outputRoot}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
