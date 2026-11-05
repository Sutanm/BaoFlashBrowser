#!/usr/bin/env node
/**
 * DevTools 前端自托管的可行性探针（spike，不参与打包）。
 *
 * 目的：用真正的 Chrome DevTools 前端去连本应用暴露出来的 CDP 端口，
 * 验证「M9x 前端 × Chromium 87 后端」到底能不能用，再决定要不要把
 * 它接进应用内抽屉。这里只做静态托管，不碰 src/。
 *
 * 用法：
 *   node tools/devtools-spike/serve.cjs [--port 9300] [--root <front_end 目录>]
 *
 * 默认根目录按顺序尝试：
 *   1. 环境变量 BFB_DEVTOOLS_FRONTEND
 *   2. tools/devtools-spike/front_end
 *   3. <系统临时目录>/chii-spike/package/public/front_end（npm pack chii 解压后的位置）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function argValue(flag, fallback) {
  const at = process.argv.indexOf(flag);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function resolveRoot() {
  const candidates = [
    process.env.BFB_DEVTOOLS_FRONTEND,
    path.join(__dirname, 'front_end'),
    path.join(os.tmpdir(), 'chii-spike', 'package', 'public', 'front_end'),
    path.join(process.env.LOCALAPPDATA || '', 'Temp', 'chii-spike', 'package', 'public', 'front_end'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'inspector.html'))) return candidate;
  }
  return null;
}

const port = Number.parseInt(argValue('--port', '9300'), 10);
const root = argValue('--root', null) || resolveRoot();

if (!root) {
  console.error('[devtools-spike] 找不到 front_end 目录。先执行：');
  console.error('  npm pack chii && tar -xzf chii-*.tgz   # 解压出 package/public/front_end');
  console.error('或指定 --root <front_end 路径> / 设置 BFB_DEVTOOLS_FRONTEND');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/inspector.html';

  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(path.resolve(root))) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(target, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not found: ${pathname}`);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[devtools-spike] serving ${root}`);
  console.log(`[devtools-spike] http://127.0.0.1:${port}/inspector.html?ws=127.0.0.1:9222/devtools/page/<targetId>`);
  console.log('[devtools-spike] targetId 从 http://127.0.0.1:9222/json/list 里取');
});
