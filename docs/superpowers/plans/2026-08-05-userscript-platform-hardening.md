# 脚本平台加固 + 背景脚本运行时 — 实施计划(修订版)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 路 5 项补强(GM 值持久化 / GM_log / 容量参数化 / @updateURL 自动更新)+ `@background` 常驻后台运行时,兼容性 ~90% → ~95%,具备后台常驻能力。

**Architecture:** 全部为增量改动,不重构现有链路。值持久化接线已有原子 `ValueStore.save/load`;背景脚本复用现有 webview-preload 运行时,在隐藏 `BrowserWindow` 中常驻,复用现有 IPC 通道。自动更新拉取走 `GmRequestService`(带 @connect 校验),不新增绕过安全模型的拉取路径。

**Tech Stack:** Electron 11.5 / TypeScript / zod / electron-store / electron-log / esbuild / Vitest

## Global Constraints

- Electron 11.5.0 / Chromium 87 锁定,永不升级
- **0 新增 npm 依赖**
- `release/tests/` 产物不被 `npm run build` 重建——冒烟前必须跑对应 `build-*.mjs`(admin-module / runtime-preload / compatibility)
- 独立 electron 冒烟必须 mock 全部 preload 通道 + `app.setPath('userData', .../bao-flash-browser)`
- 无参 IPC 通道 zod 用 `z.object({}).optional()`
- 凭据/敏感值永不进日志与诊断;日志脱敏遵循 `diagnostic-redaction`
- 新增 UI 文案**随 Task 同步** i18n(`src/renderer/i18n/zh-CN/index.ts` + `en/index.ts`,baseLocale zh-CN)
- `edited: true` 的脚本(用户编辑过)不被自动更新覆盖(与 BUNDLED_SCRIPTS 语义一致,index.ts:43)

---

## Task 1: GM 值持久化(跨重启保留)

**Files:**
- Modify: `src/main/modules/userscripts/userscript-manager.ts`(构造 options `persistValues`、scheduleSave/flushValues)
- Modify: `src/main/modules/userscripts/index.ts`(接线 load/save、before-quit flush)
- Test: `tests/values-persistence.test.ts`(vitest)+ Create: `tests/electron/values-persistence-smoke.cjs`

**Interfaces:**
- `UserscriptManager` 构造新增:`{ persistValues?: { file: string; debounceMs?: number; urgentBytes?: number } }`
- 新方法:`flushValues(): void`;`persistValuesFile(): string | undefined`;`loadValues(file: string): void`
- `ValueStore` 已有 `save(file)/load(file)`(原子 tmp+rename),不改
- ⚠️ **N1:`values` 是 private 字段(`userscript-manager.ts:49`),测试必须走公开方法**——用 `m2.loadValues(file)` + `m2.getValuesFor(1,'s')`(需注册 view)

**设计要点(P1-1):**
- debounce **200ms**(非 500ms);单值序列化 > **1KB** 或该脚本累计 > 8KB 时**立即同步 flush**,不等 debounce
- `app.on('before-quit')` 调 `flushValues()`(同步 writeFileSync+rename,毫秒级;文档注明崩溃/断电可能丢最近 debounce 窗口)
- 文件:`userData/userscript-values.json`(与 userscripts.json 同目录,可读命名)

- [ ] **Step 1: 写失败单测** `tests/values-persistence.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { ValueStore } from '../src/main/modules/userscripts/userscript-store';
import { UserscriptManager } from '../src/main/modules/userscripts/userscript-manager';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usv-'));
const file = path.join(dir, 'values.json');
let manager: UserscriptManager;

beforeEach(() => {
  manager = new UserscriptManager(new ValueStore(), {
    persistValues: { file, debounceMs: 200, urgentBytes: 1024 },
    sendToWc: () => {},
  });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('persistValues', () => {
  it('persists across manager instances', () => {
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    manager.setValue(1, 's', 'k', 'v1');
    manager.flushValues();
    const m2 = new UserscriptManager(new ValueStore(), { sendToWc: () => {} });
    m2.loadValues(file); // 公开方法(values 是 private)
    m2.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    expect(m2.getValuesFor(1, 's').k).toBe('v1');
  });
  it('large value flushes immediately without explicit flush', async () => {
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    manager.setValue(1, 's', 'big', 'x'.repeat(2000));
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(file)).toBe(true);
  });
  it('small value lands after debounce', async () => {
    manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't' });
    manager.setValue(1, 's', 'k', 'v1');
    await new Promise((r) => setTimeout(r, 350));
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).s.k).toBe('"v1"');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run tests/values-persistence.test.ts`
Expected: FAIL(persistValues 选项不存在)

- [ ] **Step 3: manager 实现**(`userscript-manager.ts`):
```ts
export interface UserscriptManagerOptions {
  requireCache?: RequireCache;
  sendToWc?: (wcId: number, channel: string, payload: unknown) => void;
  maxSnapshotBytes?: number;
  maxSourceBytesPerPage?: number;
  maxResourceBytesPerPage?: number;
  persistValues?: { file: string; debounceMs?: number; urgentBytes?: number };
}
```
构造函数存 `persistValues`;新增:
```ts
private persistTimer: ReturnType<typeof setTimeout> | null = null;
private pendingPersistBytes = 0;

private scheduleSave(): void {
  if (!this.persistValues) return;
  this.pendingPersistBytes += 0; // recomputed in setValue path below
  if (this.persistTimer) return;
  const debounceMs = this.persistValues.debounceMs ?? 200;
  this.persistTimer = setTimeout(() => { this.persistTimer = null; this.flushValues(); }, debounceMs);
}

flushValues(): void {
  if (!this.persistValues) return;
  try { this.values.save(this.persistValues.file); } catch { /* disk full etc: keep in memory */ }
}

persistValuesFile(): string | undefined { return this.persistValues?.file; }

loadValues(file: string): void { this.values.load(file); } // N1: 公开入口(values 保持 private)
```
在 `setValue` 成功路径追加:`this.noteValueWrite(scriptId, key, value)`;`deleteValue` 同样。`noteValueWrite` 计算该 key 序列化字节,若 > urgentBytes(默认 1024)立即 `flushValues()`,否则 `scheduleSave()`。`unregisterView` 不改。

- [ ] **Step 4: 跑测试确认通过**
Run: `npx vitest run tests/values-persistence.test.ts` Expected: 3 PASS

- [ ] **Step 5: index.ts 接线**:
```ts
import { join } from 'path';
// 在 new UserscriptManager(...) 处:
manager = new UserscriptManager(new ValueStore(), {
  requireCache,
  sendToWc: ...,
  persistValues: { file: join(app.getPath('userData'), 'userscript-values.json'), debounceMs: 200, urgentBytes: 1024 },
});
manager.values.load(join(app.getPath('userData'), 'userscript-values.json'));
app.on('before-quit', () => { manager?.flushValues(); });
```

- [ ] **Step 6: 冒烟** `tests/electron/values-persistence-smoke.cjs`:
两个 electron 进程:进程 A(代码同 menu-dedupe 骨架:init manager + `manager.setValue(wc,'baoflash-demo-test','visits',42)` + `manager.flushValues()` + 断言文件存在)→ `app.exit(0)`;进程 B:init manager + `expect(manager.values.get(...)).toBe(42)`。冒烟脚本本身拆成两个入口(按 `process.argv.includes('--second')` 分支),跑完 B 打印 `VALUES-PERSISTENCE PASS`。
注意:userData 固定 `%APPDATA%\bao-flash-browser`;跑完把临时值写回原值(读旧值,进程 B 结束时恢复)。

- [ ] **Step 7: check 无回归 + 提交**
Run: `npm run typecheck && npm test -- --run`
Commit: `feat(userscripts): GM 值跨重启持久化(200ms debounce+大值即时 flush)`

---

## Task 2: GM_log(平台日志 + 限频)

**Files:**
- Modify: `src/webview-preload/userscripts/gm-api.ts`(GmApi.log 接口 + 实现 + legacy + GM 对象)
- Modify: `src/webview-preload/userscripts/sandbox.ts:26-45`(`GM_log` 加进 LEGACY_GM_NAMES)
- Modify: `src/main/ipc/userscripts.ipc.ts`(新通道 `userscript:log`,含 per-script 限频)
- Modify: `tests/electron/menu-command-dedupe-smoke.cjs`(mock `userscript:log` + 断言)

**Interfaces:**
- `GmApi.log(message: string, level?: 'info'|'warn'|'error'): void`(同步 send)
- 通道 `userscript:log`:zod `{ scriptId: string, level: z.enum(['info','warn','error']).optional(), message: string.max(4000) }`
- 限频(P1-2):per-script 10 条/秒,超限丢弃并记一条 warn(每脚本每 30s 至多一条);实现放 `userscripts.ipc.ts` 模块级 `Map<scriptId, { count, windowStart }>`

**设计要点:**
- 主进程侧 electron-log:`log[level]('[userscript:'+scriptId+']', message)` → 落 `userData/logs/main.log`,04-logs 探针可见(文档注明)
- 不新增 manager 状态;限频逻辑独立小函数,便于单测

- [ ] **Step 1: 冒烟前置修改** `menu-command-dedupe-smoke.cjs`:
```js
const logEvents = [];
ipcMain.on('userscript:log', (_event, payload) => { logEvents.push(payload); });
// 结尾断言(在所有 PASS 后):
check('GM_log reached main process', logEvents.some((l) => String(l.message).includes('probe-log-marker')));
```
fixture 脚本 `demo-test.user.js` 顶部加:`GM_log('probe-log-marker', 'info');`(注意:所有测试页面都会发,无副作用)

- [ ] **Step 2: 单测限频逻辑** Create `tests/userscript-log-rate.test.ts`(纯函数):
```ts
import { describe, it, expect } from 'vitest';
import { createLogRateLimiter } from '../src/main/ipc/userscript-log-rate';
const limiter = createLogRateLimiter({ perSecond: 10 });
it('allows up to 10 per second', () => {
  let ok = 0;
  for (let i = 0; i < 10; i++) if (limiter.allow('s')) ok++;
  expect(ok).toBe(10);
  expect(limiter.allow('s')).toBe(false);
});
```
新文件 `src/main/ipc/userscript-log-rate.ts`(纯函数,`allow(scriptId): boolean` + `warnOnce(scriptId): boolean`,窗口 1s,内部 Map 清理)

- [ ] **Step 3: 实现三处**(gm-api / sandbox / ipc)
`gm-api.ts`:
```ts
const log = (message: string, level?: 'info' | 'warn' | 'error'): void => {
  bridge.send('userscript:log', {
    scriptId: script.id,
    level: level ?? 'info',
    message: String(message ?? '').slice(0, 4000),
  });
};
```
加入 GmApi 接口、GM 对象、legacy(`GM_log: (m, l) => log(m, l)`);sandbox `LEGACY_GM_NAMES` 加 `'GM_log'`。
`userscripts.ipc.ts`(⚠️ **N2:必须新增 `import log from 'electron-log';`**(当前该文件只 import 了 `{ clipboard, ipcMain, Notification }`);且**不能用 `fn?.(...) ?? log.info(...)` 写法——void 返回会触发右侧造成双重记录**):
```ts
registerValidatedListener('userscript:log',
  z.object({ scriptId: z.string(), level: z.enum(['info','warn','error']).optional(), message: z.string().max(4000) }),
  (event, payload) => {
    const active = manager();
    if (!active || !active.isScriptInstalled(payload.scriptId)) return;
    if (!logLimiter.allow(payload.scriptId)) {
      if (logLimiter.warnOnce(payload.scriptId)) log.warn('[userscripts] log rate limit hit for ' + payload.scriptId);
      return;
    }
    const level = payload.level ?? 'info';
    const fn = (log as unknown as Record<string, (m: string) => void>)[level] ?? log.info;
    fn(`[userscript:${payload.scriptId}] ${payload.message}`);
  });
```

- [ ] **Step 4: 单测 + 冒烟通过**
Run: `npx vitest run tests/userscript-log-rate.test.ts` PASS;重建 runtime-preload + admin-module,跑 menu-command-dedupe-smoke.cjs 全 PASS

- [ ] **Step 5: 提交**
Commit: `feat(userscripts): GM_log 落平台日志(per-script 限频 10/s)`

---

## Task 3: GM_xmlhttpRequest / GM_download 容量参数化

**Files:**
- Modify: `src/main/modules/userscripts/index.ts:89-106`(参数)
- Create: `tests/electron/gm-capacity-smoke.cjs`

**参数(写死默认,不做 UI 配置):**
- `GmRequestService`:`maxResponseBytes: 32KB → 2MB`、`defaultTimeoutMs: 3000 → 15000`(默认值,脚本可经 details.timeout 覆盖)、`maxConcurrentPerScript: 2 → 4`、`maxConcurrentGlobal: 8 → 16`
- `GmDownloadService`:`maxBytes: 8KB → 8MB`、`maxConcurrentPerScript: 2 → 4`
- 理由(P1-3):@connect + 公网放行 + 私网拦截已构成安全边界;容量仅限单次响应(⚠️ **N7:`maxConcurrentGlobal: 16` 是全局硬上限,每脚本 4 不会突破全局——最坏 16 并发 × 15s**,占用可控);安全上限拒绝断言保留。文档明确区分「GM_xmlhttpRequest 响应上限(2MB)」与「快照上限(64KB)」

- [ ] **Step 1: 冒烟** `tests/electron/gm-capacity-smoke.cjs`(骨架同 menu-dedupe):
本地 http server 提供:
- `/big-file.bin`:100KB 随机字节
- `/big-response`:2.5MB 文本
- `/huge-response`:3MB 文本
脚本(fixture 内联,不装 store——直接用 `manager.snapshotFor` 走不了内联脚本;改为注册临时脚本:`installUserscript` 一个专用 fixture `gm-capacity.user.js`,装完测完卸载)
断言:
1. `GM_download('/big-file.bin')` → onload,文件存在且 100KB
2. `GM_xmlhttpRequest('/big-response')` → onload,responseText.length ≥ 2.5MB
3. `GM_xmlhttpRequest('/huge-response')` → onerror,error 含 size-limit(>2MB 拒绝)
4. 并发:同时发 20 个 xhr → 全部 onload(global 16 不阻塞,或阻塞但最终完成——断言全部完成,超时 30s)
注意:冒烟需 mock `userscript:download`/`userscript:xhr-request`/`userscript:log` 等全部通道(调真实 service:直接 `manager.getRequestService()` 不可行——admin-module 导出了 getRequestService!直接调用 service.request(wcId, ...) 并 await,绕过 IPC)。

- [ ] **Step 2: 改 index.ts 参数**(如设计要点)
- [ ] **Step 3: 冒烟通过**
Run: `npx electron tests/electron/gm-capacity-smoke.cjs` 全 PASS
- [ ] **Step 4: 提交**
Commit: `feat(userscripts): GM_xmlhttpRequest 响应 2MB/超时 15s;GM_download 8MB`

---

## Task 4: @updateURL/@downloadURL 手动检查更新

**Files:**
- Modify: `src/shared/userscript-types.ts`(ParsedUserscriptMetadata 加 `updateUrl`/`downloadUrl`)
- Modify: `src/main/modules/userscripts/userscript-parser.ts`(SCALAR_KEYS 加 `updateurl`/`downloadurl`)
- Create: `src/main/ipc/userscripts-update.ts`(更新服务:checkUpdates/applyUpdate + compareVersions)
- Modify: `src/main/ipc/userscripts-admin.ipc.ts`(通道 `userscripts:check-updates`/`userscripts:apply-update`)
- Modify: `src/preload/index.ts` 白名单 + `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/components/userscripts/UserscriptsPage.tsx`(检查更新按钮、可更新行、已编辑标记)+ i18n zh-CN/en
- Test: `tests/version-compare.test.ts` + `tests/userscript-parser.test.ts`(补用例)+ Create: `tests/electron/userscripts-update-smoke.cjs`

**Interfaces:**
- `compareVersions(a, b): -1|0|1` —— 数字分段比较,**短补 0 对齐**(`1.2 === 1.2.0`);非数字段视为 0(不支持预发布语义,`1.2.0-beta === 1.2.0`,文档注明)
- `checkUpdates(): Promise<{ updates: Array<{ id, name, currentVersion, latestVersion, updateUrl }> }>`:
  - 遍历 `metadata.updateUrl` 非空的脚本;`edited === true` 的**跳过**(P1-5)
  - 拉取经 `GmRequestService`(P0-1):系统 scriptId `__platform_updater__`,pageUrl `''`,connect 校验 = `metadata.connect`;**updateUrl 的 host 必须在 @connect 内或与 @match 同域,否则拒绝**
  - 响应 ≤2MB(默认服务上限),超时 15s
  - 内容解析(P1-4 双路径):先试 JSON(`{ version, updateURL? }`)→ 取 version 比较、若含 updateURL 则作为本体再拉取;否则当作脚本本体 `parseUserscriptMetadata().version` 比较
- `applyUpdate(id): Promise<{ ok, error? }>`:重新拉取本体(同校验)→ 版本更高才 `installUserscript(source, { enabled: 保留, id })`;**清除 edited 标志**(新版本已替换用户改动,index.ts 语义);失败保持原样

- [ ] **Step 1: 单测** `tests/version-compare.test.ts`:
```ts
import { compareVersions } from '../src/main/ipc/userscripts-update';
it('1.2.10 > 1.2.9', () => expect(compareVersions('1.2.10', '1.2.9')).toBe(1));
it('1.2 === 1.2.0', () => expect(compareVersions('1.2', '1.2.0')).toBe(0));
it('1.2.0-beta === 1.2.0 (no prerelease semantics)', () => expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(0));
it('invalid segments treated as 0', () => expect(compareVersions('1.a.3', '1.0.3')).toBe(0));
```
⚠️ **N6:`updateHostAllowed(connect, match, updateUrl)` 必须是与 compareVersions 同文件的独立纯函数**,单测覆盖:
```ts
import { updateHostAllowed } from '../src/main/ipc/userscripts-update';
it('connect host allows', () => expect(updateHostAllowed(['api.example.com'], [], 'https://api.example.com/v2.user.js')).toBe(true));
it('connect wildcard allows', () => expect(updateHostAllowed(['*.example.com'], [], 'https://a.example.com/x.user.js')).toBe(true));
it('match host falls back (weak path)', () => expect(updateHostAllowed([], ['https://game.example.com/*'], 'https://game.example.com/update.user.js')).toBe(true));
it('data: source rejected', () => expect(updateHostAllowed([], [], 'data:text/plain,x')).toBe(false));
it('unrelated host rejected', () => expect(updateHostAllowed(['api.example.com'], [], 'https://evil.example.net/x.user.js')).toBe(false));
```
⚠️ **N8:updater 串行执行(一次一个,更新非性能关键路径),wcId 用 `-1`**(非真实 wc,不占并发槽;`__platform_updater__` 不进入 `userscripts:list`——它从不写入 script-store,天然不出现,冒烟断言确认)
parser 补用例:`@updateURL https://x/y.user.js` → metadata.updateUrl === 'https://x/y.user.js'。

- [ ] **Step 2: 实现** parser/types + `userscripts-update.ts`(compareVersions + checkUpdates/applyUpdate,复用 GmRequestService;注意 P0-1 的 host 校验函数 `updateHostAllowed(connect, match, url)` 独立纯函数便于单测)
- [ ] **Step 3: IPC + preload + UI**:管理页顶部"检查更新"按钮(loading→toast);可更新行显示"更新(v2.0.1)"按钮;`edited` 脚本行显示"已编辑"小标 + 更新按钮点击提示"该脚本已被编辑,应用更新将覆盖你的改动"(二次确认);⚠️ **N6:仅靠 `@match` 域放行(无 `@connect`)的脚本,更新行显示"弱安全更新源"小提示**
- [ ] **Step 4: i18n**:zh-CN/en 各加 `userscripts.update.*` 文案(button/latest/none/edited/confirm/success/failed/rate-limit/weak-source)
- [ ] **Step 5: 冒烟** `tests/electron/userscripts-update-smoke.cjs`:
本地 server:`/v1.user.js`(版本 1.0.0,`@updateURL /manifest.json`,`@connect 127.0.0.1`)、`/v2.user.js`(2.0.0)、`/manifest.json`(`{"version":"2.0.0","updateURL":"/v2.user.js"}`)
断言链:
1. 安装 v1
2. `checkUpdates()` → 报可更新(latestVersion 2.0.0;JSON 元数据路径)
3. `applyUpdate()` → 版本 2.0.0、enabled 保留
4. edited 脚本:`updateUserscriptSource` 后 checkUpdates 跳过
5. 无 @connect 的脚本:checkUpdates 拒绝(host 校验)
- [ ] **Step 6: 提交**
Commit: `feat(userscripts): @updateURL 手动检查更新(connect 校验+edited 跳过+JSON/本体双路径)`

---

## Task 5: @background 背景脚本运行时(核心)

**Files:**
- Modify: `src/shared/userscript-types.ts`(`background: boolean`)
- Modify: `src/main/modules/userscripts/userscript-parser.ts`(FLAG_KEYS 加 `background`)
- Modify: `src/main/modules/userscripts/userscript-manager.ts`:
  - ⚠️ **N9:`ViewRegistration` 加 `kind?: 'tab' | 'background'` 字段**(`manager.ts:17-21`),`spaNavigate` 开头 `if (this.views.get(wcId)?.kind === 'background') return;`——比 manager 持有 backgroundRuntime 更解耦
  - URL 匹配跳过 background 脚本(`matchesUrl` 循环加 `if (script.metadata.background) continue;`)
  - `snapshotFor` 的 require/resource 拼接抽成私有 `assembleScriptPayload(script)`(P1-8,两个分支共用)
  - 新方法 `backgroundScripts(): InstalledUserscript[]` 或 metadata 过滤;`snapshotBackground(wcId): FrameSnapshot`(取 background 脚本,走 assembleScriptPayload,同预算)
  - 命令:`commandTarget` 已有;`commandsFor(wcId)` 不变
- Create: `src/main/modules/userscripts/userscript-background.ts`(隐藏窗口生命周期:创建/加载/崩溃退避重建/销毁)
- Modify: `src/main/modules/userscripts/index.ts`(init 创建后台、before-quit 销毁、脚本变更后重建)
- Modify: `src/main/ipc/userscripts.ipc.ts`(`get-config` 对后台 wc 走 `snapshotBackground`)
- Modify: `src/main/ipc/userscripts-admin.ipc.ts`(`for-tab` 合并后台命令;`invoke-command` 改:先按 tab wc 找命令,找不到经 `commandTarget` 定位后台 wc 发送(P0-2))
- Modify: `src/renderer/components/panels/UserscriptsPanel.tsx`(后台命令带「后台」徽标,P1-9)+ i18n
- Modify: `src/main/modules/tabs.ts`(无——invoke 逻辑移到 admin ipc 侧;`tabManager.invokeUserscriptCommand` 保持原签名,admin ipc 内先查 tab 再查后台)
- Test: Create `tests/electron/background-script-smoke.cjs` + `tests/electron/fixtures/background-demo.user.js`(仅测试用,**不进 BUNDLED_SCRIPTS**,P2-5)

**设计要点:**
- 后台上下文 = 隐藏 `BrowserWindow({ show: false, webPreferences: { preload: webview-preload.js 路径, contextIsolation: true, plugins: false, partition: 'persist:' } })`,`loadURL('data:text/html;charset=utf-8,')`
- `manager.registerView(bgWcId, { mode: 'ppapi', generation: ++gen, token: 'background', kind: 'background' })`;**每次重建 generation 递增**(P1-7)
- ⚠️ **N3:`get-ruffle-mode` 无需改 tabs.ipc.ts**——现有 handler(`tabs.ipc.ts:14-22`)对未登记 wc 经 `getRuffleForWC` 返回 undefined → `{ enabled: false }`,且 handler 已随应用启动注册,不会触发 Landmine #2;但冒烟必须断言"后台窗口 sendSync('get-ruffle-mode') 在 100ms 内返回 `{enabled:false}`"(超时即 Landmine 复现)
- ⚠️ **N5:pageUrl 实际是 `data:text/html;charset=utf-8,` 而非空串**——bootstrap 发的是 `window.location.href`;`new URL(data:...)` 成功但 `.origin === 'null'`,同源放行不可能命中,效果等同空串(只剩 `@connect` 放行)。**无需 patch preload**,文档按此表述
- ⚠️ **N4:`get-config` 分派必须显式按 `event.sender.id` 判定**(handler 收到的 payload 无 background 标识):
```ts
registerValidatedListener('userscript:get-config', z.object({ url: z.string(), isMainFrame: z.boolean(), documentId: z.string() }), (event, payload) => {
  const active = manager();
  if (!active) { event.returnValue = { ok: false, scripts: [], values: {} }; return; }
  const bgWcId = backgroundRuntime?.getWcId();
  if (bgWcId != null && event.sender.id === bgWcId) {
    event.returnValue = active.snapshotBackground(bgWcId);
  } else {
    event.returnValue = active.snapshotFor(event.sender.id, payload.url, payload.isMainFrame);
  }
});
```
`backgroundRuntime` 单例从 `userscripts/index.ts` 导出(与 `getUserscriptManager()` 同级)
- 崩溃退避(P1-6):1s→2s→4s→8s→60s 上限;连续 5 次停止重建,`getBackgroundStatus()` 暴露 `{ running, crashedCount, stopped }`;管理页显示"后台运行时已停止" + "重启后台运行时"按钮(经 `userscripts:background-restart` 通道)
- 脚本启停/更新/卸载 → 重建后台窗口(简化:销毁重建,新 wc 重新 get-config)
- GM_xmlhttpRequest 后台语义(P0-3):`pageUrl` 为 data: URL(origin null)→ connectAllows 只认 `@connect` 列表(同源放行失效);文档 + gm-api 在 xhr 失败时把 error 传给 onerror(已有);**后台脚本必须显式 `@connect`**
- 值监听(P2-6):重建后 listener 丢失是脚本作者责任;文档强调"后台脚本需在顶层重新注册 listener";冒烟断言重建后 listener 需重注册才生效
- 命令 UX(P1-9):for-tab 返回命令带 `background: true` 标记,面板渲染「后台」徽标

- [ ] **Step 1: parser/types + 单测**
parser `FLAG_KEYS` 加 `'background'`;types 加 `background: boolean`。vitest:`@background` 解析为 true;manager 单测(新 `tests/userscript-manager-background.test.ts`):
```ts
// background 脚本不出现在 snapshotFor 的 URL 匹配结果
const snap = manager.snapshotFor(1, 'http://example.com/', true);
expect(snap.scripts.some((s) => s.id === 'bg')).toBe(false);
// snapshotBackground 返回它
const bg = manager.snapshotBackground(1);
expect(bg.scripts.some((s) => s.id === 'bg')).toBe(true);
```

- [ ] **Step 2: manager 改造**(assembleScriptPayload 抽取 + snapshotBackground + background 过滤 + spaNavigate 过滤)——先跑旧冒烟确认无回归(snapshotFor 重构后 menu-dedupe/11-views 仍 PASS)

- [ ] **Step 3: `userscript-background.ts` 生命周期模块**:
```ts
export interface BackgroundRuntime {
  start(): void; stop(): void; restart(): void;
  getStatus(): { running: boolean; crashedCount: number; stopped: boolean };
  getWcId(): number | null;
}
```
实现要点:`start()` 幂等;`render-process-gone` → backoff 重建或停止;`stop()` 销毁窗口+unregisterView+清 timer。

- [ ] **Step 4: index.ts 接线**(创建 BackgroundRuntime;`ensureBundledScripts`/`reloadManagerScripts` 后 `bg.restart()`;before-quit `bg.stop()`)+ ipc 改造(get-config 分支;for-tab 合并;invoke-command 双路由;`userscripts:background-restart`/`userscripts:background-status` 通道 + preload 白名单 + electron.d.ts)

- [ ] **Step 5: 面板 UI**:命令带 `background` 字段渲染徽标;管理页后台状态区(停止时显示 + 重启按钮);i18n zh-CN/en

- [ ] **Step 6: 冒烟** `tests/electron/background-script-smoke.cjs` + fixture `background-demo.user.js`:
fixture 内容:元数据 `@background` + `@connect 127.0.0.1` + `@match *://*/*`(验证被排除出 URL 匹配);document-end 时 `GM_setValue('bg-running', 1)` + `GM_registerMenuCommand('后台命令', () => GM_setValue('bg-ran', 1))` + 每 2s `GM_setValue('bg-tick', ++n)`
断言:
1. 后台 wc 存在,报告含 phase bootstrap(background 标记)
2. `snapshotFor(url)` 不含 bg 脚本;`snapshotBackground` 含
3. ⚠️ **N3:后台 wc 上 `sendSync('get-ruffle-mode')` 100ms 内返回 `{ enabled: false }`**
4. for-tab 命令列表含「后台命令」且 `background: true`
5. invoke「后台命令」→ 后台脚本回调执行(`bg-ran === 1`)
6. setEnabled(false)+restart → 后台脚本停止(报告不再产生)
7. 无 @connect 的 xhr(可加 fixture 第二脚本)→ onerror 含 connect-denied(P0-3 验证)
8. 模拟连续崩溃(在 fixture 里 `window.__crashSim = true` 时抛错)?——用 `process.crash()`?Electron 11 无此 API;改为 5 次手动 `kill` 后台 wc 太重——简化:单测退避调度函数(纯逻辑,把 backoff 序列算出来断言 1,2,4,8,60),不模拟真实崩溃
- [ ] **Step 7: 提交**
Commit: `feat(userscripts): @background 常驻后台运行时(隐藏窗口+退避重建+命令/值复用)`

---

## Task 6: 文档 + 探针 + 全量回归

**Files:**
- Modify: `docs/userscript-developer-guide.md`(值持久化/GM_log/容量参数/自动更新/background 章节:后台 @connect 要求、listener 重建丢失、崩溃停止语义、不走 Ruffle)
- Modify: `docs/userscript-user-guide.md`(检查更新按钮、已编辑标记、后台命令徽标、后台运行时停止提示)
- Modify: `AGENTS.md`(background 运行时 landmine:后台 wc 的 get-config 分支、崩溃退避、值监听丢失)
- Modify: `tools/probe/probes/01-userscripts.cjs`(detail 加 `background`/`updateUrl`/`edited` 字段,P2-3)
- Modify: `tools/probe/probes/11-views.cjs`(可选:断言 for-tab 命令含 background 标记——若后台 fixture 已安装)

- [ ] **Step 1: 文档更新**(三份)
- [ ] **Step 2: 探针更新**(01-userscripts detail 字段)
- [ ] **Step 3: 全量回归**
Run: `npm run check`(i18n+typecheck+lint+vitest+build)全绿
Run: 重建产物后 `npm run test:userscripts`、`npm run test:userscripts-admin`、4 个新冒烟(values-persistence/gm-capacity/userscripts-update/background)、`npm run probe`、`npm run probe:deep`
- [ ] **Step 4: 提交**
Commit: `docs+probe: 平台加固与背景脚本文档、探针字段、全量回归`

---

## 范围外(明确不做)
- `GM_cookie` / `GM_webRequest`(安全权衡,另立项)
- 自动更新后台定时轮询(仅手动触发)
- 后台脚本访问页面 DOM(设计上无页面)
- UI 级容量配置(参数写死默认)
- 内置 background 演示脚本(不进 BUNDLED_SCRIPTS;如需要是产品决策,单独立项)
- listener 订阅持久化重放(仅文档化 + 冒烟断言,不实现)
- **css-fixer / BUNDLED_SCRIPTS / bundled-scripts/ 机制**(`index.ts:17-53` 的内置脚本安装更新链路):用户自行添加并另行审计,**本计划不修改、不文档化、不测试该机制**,Task 6 的文档/探针更新一律不触碰其行为

## 验证矩阵

| 冒烟 | 关键断言 |
|---|---|
| `values-persistence-smoke.cjs` | 进程 A flush → 进程 B 读到相同值;单测覆盖 debounce/大值即时 flush |
| `gm-capacity-smoke.cjs` | 100KB download onload;2.5MB xhr onload;>2MB 拒绝;20 并发全部完成(受全局 16 上限约束,断言全部完成非全部并发) |
| `userscripts-update-smoke.cjs` | JSON 元数据路径;本体路径;edited 跳过;无 @connect 拒绝(弱安全路径走 @match 放行);enabled 保留;`__platform_updater__` 不出现在 `userscripts:list` |
| `background-script-smoke.cjs` | 后台执行报告;URL 匹配排除;命令合并+invoke 生效;启停生效;无 @connect xhr 被拒(connect-denied);退避序列(单测);**后台 wc `sendSync('get-ruffle-mode')` 100ms 内返回 `{enabled:false}`(防 Landmine #2)** |
