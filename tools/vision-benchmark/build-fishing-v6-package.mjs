import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const [, , inputPath, scriptPath, outputPath] = process.argv;
if (!inputPath || !scriptPath || !outputPath) {
  throw new Error('usage: node build-fishing-v6-package.mjs <input.baoauto> <v6.js> <output.baoauto>');
}

const archive = unzipSync(new Uint8Array(fs.readFileSync(inputPath)));
const manifest = JSON.parse(strFromU8(archive['manifest.json']));
const workflow = JSON.parse(strFromU8(archive['workflow.json']));
const script = new Uint8Array(fs.readFileSync(scriptPath));

if (manifest.format !== 'baoauto' || manifest.formatVersion !== 3) {
  throw new Error('input is not a .baoauto v3 package');
}
const scriptEntry = manifest.frontends?.scripts?.find((entry) => entry.id === 'script-1');
if (!scriptEntry || scriptEntry.path !== 'scripts/script-1.js') {
  throw new Error('input package does not contain the expected script-1 entry');
}

manifest.id = 'fishing-phase-locked-v6';
manifest.name = '钓鱼-相位锁定定时版-v6';
manifest.description = '少量鱼样本判龄并锁定当前运动相位；已经越过鱼钩时自动等待下一次过线，第二阶段按点击发起时刻计时。';
scriptEntry.name = '相位锁定定时-v6';
scriptEntry.permissions = ['vision', 'input', 'log'];
workflow.id = 'fishing-phase-locked-v6-workflow';
workflow.name = manifest.name;

archive['scripts/script-1.js'] = script;
archive['workflow.json'] = strToU8(`${JSON.stringify(workflow, null, 2)}\n`);

const integrity = {};
for (const [entryPath, bytes] of Object.entries(archive)) {
  if (entryPath === 'manifest.json') continue;
  integrity[entryPath] = crypto.createHash('sha256').update(bytes).digest('hex');
}
manifest.integrity = integrity;
archive['manifest.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);

const destination = path.resolve(outputPath);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, Buffer.from(zipSync(archive, { level: 6 })));
console.log(destination);
