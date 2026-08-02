const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const targetDir = path.join(projectRoot, 'release', '.app-metadata');

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(targetDir, 'package.json'));
console.log('[build] prepared isolated application metadata');
