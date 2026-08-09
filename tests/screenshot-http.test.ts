// @vitest-environment node
import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createScreenshotHttpHandler, randomToken } from '../src/main/modules/screenshot-http';

const captureTabMock = vi.fn();
const getActiveIdMock = vi.fn();

vi.mock('../src/main/modules/screenshot', () => ({
  captureTab: (tabId: string, opts: unknown) => captureTabMock(tabId, opts),
  getScreenshotDir: () => 'C:\\shots',
}));
vi.mock('../src/main/modules/tabs', () => ({
  tabManager: { getActiveId: () => getActiveIdMock() },
}));

const TOKEN = randomToken();
let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer(createScreenshotHttpHandler(TOKEN));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('screenshot http debug server', () => {
  it('generates a 32-char hex token', () => {
    expect(randomToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects missing or wrong token with 401', async () => {
    const missing = await post('/screenshot', {});
    expect(missing.status).toBe(401);
    const wrong = await post('/screenshot', {}, { 'x-bao-token': 'nope' });
    expect(wrong.status).toBe(401);
  });

  it('rejects non-/screenshot paths with 404', async () => {
    const res = await post('/other', {}, { 'x-bao-token': TOKEN });
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON body with 400', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(baseUrl + '/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bao-token': TOKEN },
      }, (r) => {
        r.resume();
        r.on('end', () => resolve({ status: r.statusCode || 0 }));
      });
      req.on('error', reject);
      req.end('{not json');
    });
    expect(res.status).toBe(400);
  });

  it('uses the active tab when tabId is omitted', async () => {
    getActiveIdMock.mockReturnValue('tab-active');
    captureTabMock.mockResolvedValue({ success: true, width: 100, height: 50 });
    const res = await post('/screenshot', { save: true, returnData: false }, { 'x-bao-token': TOKEN });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(captureTabMock).toHaveBeenCalledWith('tab-active', { save: true, returnData: false });
  });

  it('passes an explicit tabId and savePath through', async () => {
    captureTabMock.mockResolvedValue({ success: true, filePath: 'C:\\shots\\a.png' });
    const res = await post('/screenshot', { tabId: 'tab-9', savePath: 'D:\\x\\a.png' }, { 'x-bao-token': TOKEN });
    expect(captureTabMock).toHaveBeenCalledWith('tab-9', { savePath: 'D:\\x\\a.png' });
    expect(res.json.filePath).toBe('C:\\shots\\a.png');
  });

  it('returns 400 when no tabId and no active tab', async () => {
    getActiveIdMock.mockReturnValue(null);
    const res = await post('/screenshot', {}, { 'x-bao-token': TOKEN });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('NO_ACTIVE_TAB');
  });

  it('surfaces captureTab failures as 400 with the error code', async () => {
    captureTabMock.mockResolvedValue({ success: false, code: 'MINIMIZED_INACTIVE', error: 'nope' });
    const res = await post('/screenshot', { tabId: 'tab-1' }, { 'x-bao-token': TOKEN });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('MINIMIZED_INACTIVE');
  });

  it('does not leak capture output without the token (blind request)', async () => {
    captureTabMock.mockClear();
    const res = await post('/screenshot', { tabId: 'tab-1', save: true });
    expect(res.status).toBe(401);
    expect(captureTabMock).not.toHaveBeenCalled();
  });
});
