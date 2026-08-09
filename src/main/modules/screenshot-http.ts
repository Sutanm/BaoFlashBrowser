// src/main/modules/screenshot-http.ts
// 调试专用 HTTP 口子：仅开发模式（!app.isPackaged）+ BAO_SCREENSHOT_HTTP=1 时启用。
// 安全防线（见设计文档 §方案A）：
//   1. 仅绑定 127.0.0.1 回环
//   2. 随机 token 存内存，请求须带 X-BAO-Token header（浏览器 preflight 拒绝网页侧 CSRF）
//   3. 仅接受 POST /screenshot（GET 不带副作用）
//   4. savePath 等参数复用 captureTab 既有校验（isPathWithinDirectory + .png 白名单）
import http from 'http';
import crypto from 'crypto';
import log from 'electron-log';
import { captureTab, type ScreenshotOptions, type ScreenshotResult } from './screenshot';
import { tabManager } from './tabs';

const MAX_BODY_BYTES = 16 * 1024;
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function randomToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 不配置 Access-Control-Allow-*：任何跨域请求都被浏览器拦截
  });
  res.end(body);
}

/**
 * 纯 handler（可测试）：token 校验 + 参数解析 + 调 captureTab。
 * 缺省 tabId → 当前激活标签页。
 */
export function createScreenshotHttpHandler(token: string) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const addr = req.socket.remoteAddress || '';
      if (!LOOPBACK_ADDRS.has(addr)) { sendJson(res, 403, { success: false, code: 'FORBIDDEN', error: 'Loopback only' }); return; }
      if (req.method !== 'POST' || (req.url || '').split('?')[0] !== '/screenshot') {
        sendJson(res, 404, { success: false, code: 'NOT_FOUND', error: 'POST /screenshot only' }); return;
      }
      if (req.headers['x-bao-token'] !== token) {
        sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', error: 'Invalid or missing token' }); return;
      }
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(req)) as Record<string, unknown>;
      } catch (e) {
        sendJson(res, 400, { success: false, code: 'BAD_REQUEST', error: e instanceof Error ? e.message : String(e) }); return;
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { success: false, code: 'BAD_REQUEST', error: 'Body must be a JSON object' }); return;
      }
      const opts: ScreenshotOptions = {};
      if (typeof body.save === 'boolean') opts.save = body.save;
      if (typeof body.savePath === 'string') opts.savePath = body.savePath;
      if (typeof body.returnData === 'boolean') opts.returnData = body.returnData;
      if (body.rect && typeof body.rect === 'object') {
        const r = body.rect as Record<string, unknown>;
        if (typeof r.x === 'number' && typeof r.y === 'number' && typeof r.width === 'number' && typeof r.height === 'number') {
          opts.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
      }
      const tabId = typeof body.tabId === 'string' && body.tabId ? body.tabId : tabManager.getActiveId();
      if (!tabId) {
        sendJson(res, 400, { success: false, code: 'NO_ACTIVE_TAB', error: 'No tabId provided and no active tab' }); return;
      }
      const result: ScreenshotResult = await captureTab(tabId, opts);
      sendJson(res, result.success ? 200 : 400, result);
    } catch (e) {
      log.error('[Screenshot HTTP] request failed:', e instanceof Error ? e.message : e);
      sendJson(res, 500, { success: false, code: 'SERVER_ERROR', error: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function startScreenshotHttpServer(): void {
  const token = process.env.BAO_SCREENSHOT_TOKEN || randomToken();
  const port = Number(process.env.BAO_SCREENSHOT_PORT) || 44123;
  const server = http.createServer(createScreenshotHttpHandler(token));
  server.on('error', (e) => {
    log.warn('[Screenshot HTTP] failed to start debug server:', e instanceof Error ? e.message : String(e));
  });
  server.listen(port, '127.0.0.1', () => {
    log.info(`[Screenshot HTTP] debug server ready: http://127.0.0.1:${port}/screenshot (X-BAO-Token: ${token})`);
  });
}
