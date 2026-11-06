/**
 * CDP 端点的只读查询：解析调试端口、拉 `/json/list`。
 *
 * 单独成模块是为了**打断循环依赖**：`devtoolbox-bridge.ts` 需要
 * `listDebugTargets`，而 `devtoolbox.ts` 又要 import 桥来在创建前端容器之前
 * 完成 attach——两边互相 import 在 CJS 下会拿到半初始化的 exports。
 * 这里没有任何状态，谁 import 都安全。
 */
import { app } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';

export interface DebugTarget {
  id: string;
  type: string;
  url: string;
  title: string;
}

/** Chromium 把实际端口写进 userData 下的 DevToolsActivePort（第一行端口）。 */
export function resolveDebugPort(): number | null {
  const fromSwitch = app.commandLine.getSwitchValue('remote-debugging-port');
  const parsed = Number.parseInt(fromSwitch, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  try {
    const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
    const first = fs.readFileSync(file, 'utf-8').split('\n')[0];
    const fromFile = Number.parseInt(first, 10);
    if (Number.isFinite(fromFile) && fromFile > 0) return fromFile;
  } catch {
    // 没有调试端口：返回 null，UI 显示"未开启调试端口"
  }
  return null;
}

export function fetchTargets(port: number): Promise<DebugTarget[]> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(Array.isArray(parsed) ? parsed as DebugTarget[] : []);
        } catch {
          resolve([]);
        }
      });
    });
    request.on('error', () => resolve([]));
    request.on('timeout', () => { request.destroy(); resolve([]); });
  });
}

/**
 * 给桥用的 target 枚举（`/json/list`）。
 *
 * 桥需要它来伪造 `Target.targetCreated`：S14 基线证明 page-ws 下前端自己
 * `setDiscoverTargets(true)` 后会收到**全部 target** 的创建事件（iframe/外壳/页面，
 * 都是 `attached: true`），前端据此建立 TargetManager 记录。桥走 browser 端点时
 * 这条事件不会自动补，必须由桥扮演 host。
 */
export function listDebugTargets(): Promise<Array<{ id: string; type: string; url: string; title: string }>> {
  const port = resolveDebugPort();
  if (!port) return Promise.resolve([]);
  return fetchTargets(port).then((items) => items.map((item) => ({
    id: item.id, type: item.type, url: item.url, title: item.title,
  })));
}
