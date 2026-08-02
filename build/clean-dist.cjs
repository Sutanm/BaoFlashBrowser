const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
console.log('[build] removed stale dist output');
