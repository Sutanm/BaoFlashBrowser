import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(directory, '..', 'src', 'main', 'modules', 'userscripts', 'bundled-scripts', 'automation-frame-assistant.user.js');
const source = fs.readFileSync(target, 'utf8');
const normalized = source.replace(/\n\/\/ @updateHash\s+\S+/u, '');
const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
const next = /\n\/\/ @updateHash\s+\S+/u.test(source)
  ? source.replace(/(\n\/\/ @updateHash\s+)\S+/u, `$1${hash}`)
  : source.replace(/(\n\/\/ @version\s+\S+)/u, `$1\n// @updateHash  ${hash}`);
if (next !== source) fs.writeFileSync(target, next, 'utf8');
console.log(`[build-automation-assistant] ${next === source ? 'verified' : 'wrote'} ${target} (updateHash=${hash})`);
