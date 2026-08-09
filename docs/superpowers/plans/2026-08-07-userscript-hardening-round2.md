# 用户脚本平台加固(第二轮)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复第一轮遗留缺陷(后台崩溃计数不重置/卸载残留/更新无互斥/循环 import/粘合层无测试),新增 GM_cookie(只读)、GM_webRequest(仅观察)、UI 级容量配置、脚本导出、后台多窗口隔离。

**Architecture:** 全部增量改动。纯逻辑抽成无 Electron 依赖模块以便 vitest;GM_webRequest 观察器必须组合进 session-manager 的单一 `onBeforeRequest` 监听器(Electron 11 webRequest 监听器重注册即替换,js-patch 共享同回调),onCompleted/onErrorOccurred 独立注册;后台运行时从单窗口重构为 per-script 窗口池,复用崩溃退避纯逻辑;容量配置存 electron-store(config.ts),保存后热应用。

**Tech Stack:** Electron 11.5 / TypeScript / zod / electron-store / esbuild / Vitest

## Global Constraints

- Electron 11.5.0 / Chromium 87 锁定,永不升级;0 新增 npm 依赖
- Electron 11 webRequest 监听器**互斥**:观察器不得独立注册 `onBeforeRequest`,必须经 session-manager 单一回调分发;`onCompleted`/`onErrorOccurred` 未被占用可独立注册
- `release/tests/` 产物不随 `npm run build` 重建——冒烟前跑对应 `build-*.mjs`
- 独立 electron 冒烟必须 mock 全部 preload 通道 + `app.setPath('userData', .../bao-flash-browser)`;冒烟设 `BAO_USERSCRIPT_PRELOAD_PATH`
- 无参 IPC 通道 zod 用 `z.object({}).optional()`
- 日志脱敏遵循 `diagnostic-redaction`:webRequest 事件 URL 必须经 `redactUrlForLog`;cookie 值属脚本主动请求的 GM 能力,受 @connect 域校验,文档注明
- GM_cookie **只读**(list/get,无 set/delete);GM_webRequest **仅观察**(不拦截、不修改、不取消)
- 新增 UI 文案随 Task 同步 i18n(zh-CN/en)
- 纯逻辑模块零 Electron import(vitest 可直接测)

---

## Task 1: 后台崩溃计数跟踪器(纯逻辑)+ 手动重启清零

修复第一轮缺陷:手动「重启后台运行时」后 `crashedCount` 不清零,再崩 1 次即误判"连续 5 次"停止。

**Files:**
- Create: `src/main/modules/userscripts/userscript-crash-tracker.ts`
- Modify: `src/main/modules/userscripts/userscript-background.ts`(用 tracker 替换闭包计数)
- Test: `tests/userscript-crash-tracker.test.ts`

**Interfaces:**
- `createCrashTracker(options?: { stopAfter?: number }): CrashTracker`
- `CrashTracker`:`record(scriptId: string): { crashedCount: number; shouldStop: boolean; nextDelayMs: number }`、`reset(scriptId: string): void`、`crashedCount(scriptId: string): number`(Task 9 的 getStatus 查询用)
- `backoffDelayMs(attempt: number): number` 保持 `userscript-background.ts` 现有导出(1..4 → 1000/2000/4000/8000,≥5 → 60000)

- [ ] **Step 1: 写失败单测** `tests/userscript-crash-tracker.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createCrashTracker } from '../src/main/modules/userscripts/userscript-crash-tracker';

describe('createCrashTracker', () => {
  it('stops after 5 consecutive crashes with backoff 1,2,4,8,60s', () => {
    const tracker = createCrashTracker({ stopAfter: 5 });
    const delays: number[] = [];
    let shouldStop = false;
    for (let i = 0; i < 5; i++) {
      const r = tracker.record('bg-a');
      delays.push(r.nextDelayMs);
      shouldStop = r.shouldStop;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 60000]);
    expect(shouldStop).toBe(true);
  });
  it('tracks crash counts per script independently', () => {
    const tracker = createCrashTracker({ stopAfter: 5 });
    tracker.record('a'); tracker.record('a'); tracker.record('a'); tracker.record('a');
    expect(tracker.record('a').shouldStop).toBe(true);
    expect(tracker.record('b').shouldStop).toBe(false);
    expect(tracker.crashedCount('b')).toBe(1);
  });
  it('reset clears the count (manual restart)', () => {
    const tracker = createCrashTracker({ stopAfter: 3 });
    tracker.record('a'); tracker.record('a');
    tracker.reset('a');
    expect(tracker.record('a').crashedCount).toBe(1);
    expect(tracker.record('a').shouldStop).toBe(false);
    expect(tracker.crashedCount('a')).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npx vitest run tests/userscript-crash-tracker.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现** `userscript-crash-tracker.ts`:
```ts
// Per-script crash tracking with exponential backoff, pure logic (no Electron).
export interface CrashTrackerOptions {
  stopAfter?: number;
}

export interface CrashRecord {
  crashedCount: number;
  shouldStop: boolean;
  nextDelayMs: number;
}

export interface CrashTracker {
  record(scriptId: string): CrashRecord;
  reset(scriptId: string): void;
  crashedCount(scriptId: string): number;
}

export function backoffDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return 1000;
  if (attempt >= 5) return 60_000;
  return 1000 * 2 ** (attempt - 1);
}

export function createCrashTracker(options?: CrashTrackerOptions): CrashTracker {
  const stopAfter = options?.stopAfter ?? 5;
  const counts = new Map<string, number>();
  return {
    record(scriptId: string): CrashRecord {
      const crashedCount = (counts.get(scriptId) ?? 0) + 1;
      counts.set(scriptId, crashedCount);
      return { crashedCount, shouldStop: crashedCount >= stopAfter, nextDelayMs: backoffDelayMs(crashedCount) };
    },
    reset(scriptId: string): void {
      counts.delete(scriptId);
    },
    crashedCount(scriptId: string): number {
      return counts.get(scriptId) ?? 0;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `npx vitest run tests/userscript-crash-tracker.test.ts` Expected: 3 PASS

- [ ] **Step 5: 接入 runtime**:`userscript-background.ts` 删除本地 `crashedCount`/`backoffDelayMs`(后者改为 re-export:`export { backoffDelayMs } from './userscript-crash-tracker';`),用 `createCrashTracker()`;`start()` 开头对当前脚本 `tracker.reset(scriptId)`(手动重启清零——修复 P0);`render-process-gone` 改调 `tracker.record(scriptId)`,`shouldStop` 时 `stop()` + `stopped = true`,`nextDelayMs` 作为退避。
```ts
// userscript-background.ts 内替换要点(单窗口阶段):
import { createCrashTracker, backoffDelayMs } from './userscript-crash-tracker'; // backoffDelayMs 仅为旧测试兼容 re-export
const tracker = createCrashTracker();
// start():tracker.reset(BG_KEY);render-process-gone 时:
//   const r = tracker.record(BG_KEY);
//   if (r.shouldStop) { stop(); stopped = true; return; }
//   backoffTimer = setTimeout(() => { backoffTimer = null; start(); }, r.nextDelayMs);
```
(注意:Task 9 会把 runtime 重写为 per-script 窗口池,tracker 的 scriptId 参数在那里启用;本任务保持单窗口语义,key 用常量 `'__background__'`。)

- [ ] **Step 6: 回归**
Run: `npm run typecheck && npm test -- --run` + `npx electron tests/electron/background-script-smoke.cjs` ALL PASS

- [ ] **Step 7: 提交**
Commit: `fix(userscripts): 后台崩溃退避抽纯逻辑,手动重启清零崩溃计数`

---

## Task 2: 卸载脚本时清理 GM 值残留

**Files:**
- Modify: `src/main/modules/userscripts/userscript-store.ts`(`deleteScript(scriptId)` 方法)
- Modify: `src/main/modules/userscripts/userscript-manager.ts`(`clearScriptValues(scriptId): void` 公开方法,含 persist flush)
- Modify: `src/main/modules/userscripts/index.ts`(`uninstallUserscript` 成功后清理)
- Test: `tests/userscripts/userscript-manager-values.test.ts` 补用例

**Interfaces:**
- `ValueStore.deleteScript(scriptId: string): void` — 删除整个 bucket
- `UserscriptManager.clearScriptValues(scriptId: string): void` — `values.deleteScript` + 清 `scriptByteCounts` + 若启用 persistValues 立即 `flushValues()`

- [ ] **Step 1: 补失败单测**(`tests/userscripts/userscript-manager-values.test.ts` 末尾追加):
```ts
it('clearScriptValues removes the whole script bucket and flushes', () => {
  manager.registerView(7, { mode: 'ppapi', generation: 1, token: 't' });
  manager.setValue(7, 'gone', 'k', 'v');
  manager.setValue(7, 'stay', 'k', 'v');
  manager.clearScriptValues('gone');
  expect(manager.getValuesFor(7, 'gone')).toEqual({});
  expect(manager.getValuesFor(7, 'stay').k).toBe('v');
});
```
(该文件现有 `makeManager` 辅助沿用;若文件无 persistValues 构造,clearScriptValues 的 flush 分支需构造带 persistValues 的 manager——单测断言 bucket 清除即可,flush 行为由现有 values-persistence 冒烟覆盖。)

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/userscripts/userscript-manager-values.test.ts` FAIL(方法不存在)

- [ ] **Step 3: 实现**
`userscript-store.ts`:
```ts
deleteScript(scriptId: string): void {
  this.data.delete(scriptId);
}
```
`userscript-manager.ts`:
```ts
clearScriptValues(scriptId: string): void {
  this.values.deleteScript(scriptId);
  this.scriptByteCounts.delete(scriptId);
  if (this.persistValues) this.flushValues();
}
```
`index.ts` `uninstallUserscript`:
```ts
export function uninstallUserscript(id: string): boolean {
  if (!scriptStore) return false;
  const removed = scriptStore.remove(id);
  if (removed) {
    manager?.clearScriptValues(id);
    reloadManagerScripts();
  }
  return removed;
}
```

- [ ] **Step 4: 跑测试确认通过** — 全量 `npm test -- --run` 绿

- [ ] **Step 5: 提交**
Commit: `feat(userscripts): 卸载脚本时清理其 GM 值残留并落盘`

---

## Task 3: 更新服务收编 index.ts(消除循环 import)+ checkUpdates 防重入

`userscripts-update.ts` ↔ `index.ts` 互相导入(esbuild 可跑但脆弱)。将 `checkUpdates`/`applyUpdate` 整体移入 `index.ts`(模块层本来就持有 store/service),删除 `userscripts-update.ts`;`userscript-versions.ts` 纯模块保留。同时给 checkUpdates 加 in-flight 互斥。

**Files:**
- Modify: `src/main/modules/userscripts/index.ts`(收编 checkUpdates/applyUpdate + inflight 互斥)
- Delete: `src/main/modules/userscripts/userscripts-update.ts`
- Modify: `tests/electron/userscripts-update-smoke.cjs`(加并发断言)
- 引用方不变:`userscripts-admin.ipc.ts` 仍从 `../modules/userscripts` 导入

**Interfaces(签名不变,位置变更):**
- `checkUpdates(): Promise<{ updates: UserscriptUpdateInfo[] }>` — 并发调用返回同一 in-flight promise
- `applyUpdate(id: string): Promise<{ ok: boolean; error?: string }>`
- `UserscriptUpdateInfo` 类型移入 `src/shared/userscript-types.ts`(供 renderer 引用)

- [ ] **Step 1: 移动代码**:将 `userscripts-update.ts` 的 `checkUpdates`/`applyUpdate`/`fetchText`/`fetchLatestVersion` 原样并入 `index.ts` 末尾(import 改为局部已有:`parseUserscriptMetadata`/`compareVersions`/`getRequestService`/`installUserscript`/`listUserscripts`/`setUserscriptEdited` 全部已在 index.ts 作用域);删除 `userscripts-update.ts`;`UserscriptUpdateInfo` 移到 shared types 并从 index.ts re-export(`export type { UserscriptUpdateInfo }`)。

- [ ] **Step 2: 加防重入**:
```ts
let updatesInflight: Promise<{ updates: UserscriptUpdateInfo[] }> | null = null;

export async function checkUpdates(): Promise<{ updates: UserscriptUpdateInfo[] }> {
  if (updatesInflight) return updatesInflight;
  updatesInflight = runCheckUpdates().finally(() => { updatesInflight = null; });
  return updatesInflight;
}

async function runCheckUpdates(): Promise<{ updates: UserscriptUpdateInfo[] }> {
  // …原 checkUpdates 遍历逻辑…
}
```
`applyUpdate` 不互斥(单条,幂等)。

- [ ] **Step 3: 验证无回归**
Run: `npm run typecheck` OK;`npx vitest run tests/version-compare.test.ts tests/userscripts/userscript-parser.test.ts` 绿;重建 admin-module 后 `npx electron tests/electron/userscripts-update-smoke.cjs` ALL PASS

- [ ] **Step 4: 冒烟并发断言**:`userscripts-update-smoke.cjs` 在 server 里加 `let manifestHits = 0;`(`/manifest.json` 分支 `manifestHits += 1`),step 2 处改为:
```js
const [c1, c2] = await Promise.all([mod.checkUpdates(), mod.checkUpdates()]);
check('checkUpdates dedupes concurrent calls', c1 === c2, { sameObject: c1 === c2, manifestHits });
check('checkUpdates reports v2.0.0 via manifest', Boolean(update) && update.latestVersion === '2.0.0', update ?? []);
```
(原 `const checked = await mod.checkUpdates();` 及随后 update 查找基于 c1。)

- [ ] **Step 5: 提交**
Commit: `refactor(userscripts): 更新服务收编 index.ts 消除循环 import;checkUpdates 防重入`

---

## Task 4: 侧边栏命令合并/invoke 路由抽纯函数 + 单测

`for-tab` 合并与 `invoke-command` 双路由目前在 admin ipc 内联,无直接测试。

**Files:**
- Create: `src/main/modules/userscripts/userscript-sidebar.ts`(纯模块)
- Modify: `src/main/ipc/userscripts-admin.ipc.ts`(改用纯函数)
- Test: `tests/userscript-sidebar.test.ts`

**Interfaces:**
```ts
import type { ScriptCommand } from '../../../shared/userscript-types';

// tab 命令原样 + 后台命令标记 background: true
export function mergeSidebarCommands(
  tabCommands: ScriptCommand[],
  bgCommands: ScriptCommand[],
): Array<ScriptCommand & { background?: boolean }>;

// 路由判定:tab 命中 → 'tab';未命中但 commandTarget 存在 → 'background';否则 'none'
export function resolveCommandRoute(
  tabInvoked: boolean,
  hasBackgroundTarget: boolean,
): 'tab' | 'background' | 'none';
```

- [ ] **Step 1: 写失败单测** `tests/userscript-sidebar.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mergeSidebarCommands, resolveCommandRoute } from '../src/main/modules/userscripts/userscript-sidebar';
import type { ScriptCommand } from '../src/shared/userscript-types';

const tabCmd: ScriptCommand = { commandId: 'd:s:1', scriptId: 's', documentId: 'd', title: 'T', isMainFrame: true };
const bgCmd: ScriptCommand = { commandId: 'bd:bs:1', scriptId: 'bs', documentId: 'bd', title: 'B', isMainFrame: true };

describe('mergeSidebarCommands', () => {
  it('keeps tab commands unchanged and marks background commands', () => {
    const merged = mergeSidebarCommands([tabCmd], [bgCmd]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(tabCmd);
    expect(merged[0].background).toBeUndefined();
    expect(merged[1].background).toBe(true);
  });
  it('works with empty background list', () => {
    expect(mergeSidebarCommands([tabCmd], [])).toHaveLength(1);
  });
});

describe('resolveCommandRoute', () => {
  it('prefers the tab view', () => expect(resolveCommandRoute(true, true)).toBe('tab'));
  it('falls back to the background runtime', () => expect(resolveCommandRoute(false, true)).toBe('background'));
  it('returns none when nothing matches', () => expect(resolveCommandRoute(false, false)).toBe('none'));
});
```

- [ ] **Step 2: 跑测试确认失败**(模块不存在)

- [ ] **Step 3: 实现** `userscript-sidebar.ts`:
```ts
import type { ScriptCommand } from '../../../shared/userscript-types';

export function mergeSidebarCommands(
  tabCommands: ScriptCommand[],
  bgCommands: ScriptCommand[],
): Array<ScriptCommand & { background?: boolean }> {
  return [
    ...tabCommands,
    ...bgCommands.map((command) => ({ ...command, background: true })),
  ];
}

export function resolveCommandRoute(tabInvoked: boolean, hasBackgroundTarget: boolean): 'tab' | 'background' | 'none' {
  if (tabInvoked) return 'tab';
  if (hasBackgroundTarget) return 'background';
  return 'none';
}
```

- [ ] **Step 4: admin ipc 接入**(`userscripts-admin.ipc.ts`;⚠️ Task 9 之前 runtime 仍是单窗口——本步用 `getWcId()` 过渡,Task 9 Step 4 改为 `getWcIds()`):
```ts
import { mergeSidebarCommands, resolveCommandRoute } from '../modules/userscripts/userscript-sidebar';
// for-tab:
const manager = getUserscriptManager();
const bgWcId = getBackgroundRuntime()?.getWcId() ?? null;
const bgCommands = bgWcId != null ? (manager?.commandsFor(bgWcId) ?? []) : [];
return {
  scripts: manager?.matchingFor(payload.url) ?? [],
  commands: mergeSidebarCommands(tabManager.getUserscriptCommandsForTab(payload.tabId), bgCommands),
};
// invoke-command:
const tabInvoked = tabManager.invokeUserscriptCommand(payload.tabId, payload.commandId);
const target = getUserscriptManager()?.commandTarget(payload.commandId) ?? null;
const route = resolveCommandRoute(tabInvoked, target !== null);
if (route === 'background' && target) {
  const wc = webContents.fromId(target.wcId);
  if (wc && !wc.isDestroyed()) {
    try {
      wc.send('userscript:menu-invoke', { commandId: payload.commandId, documentId: target.documentId });
      return { ok: true };
    } catch { /* view gone */ }
  }
}
return { ok: route !== 'none' };
```

- [ ] **Step 5: 验证 + 提交**
Run: `npx vitest run tests/userscript-sidebar.test.ts` PASS + `npm run typecheck` OK
Commit: `test(userscripts): 侧边栏命令合并与 invoke 路由抽纯函数并单测`

---

## Task 5: GM_cookie(只读 list/get)

**Files:**
- Create: `src/main/modules/userscripts/userscript-cookie-service.ts`
- Modify: `src/main/modules/userscripts/index.ts`(接线 service 单例 + export)
- Modify: `src/main/ipc/userscripts.ipc.ts`(`userscript:cookie-list`/`userscript:cookie-get` invoke 通道)
- Modify: `src/webview-preload/userscripts/gm-api.ts`(`GM.cookie.list/get` + legacy `GM_cookie`)
- Modify: `src/webview-preload/userscripts/sandbox.ts`(LEGACY_GM_NAMES 加 `'GM_cookie'`)
- Modify: `src/shared/userscript-types.ts`(`GmCookie` 类型)
- Test: Create `tests/electron/userscripts-cookie-smoke.cjs`

**Interfaces:**
- `GmCookie`:`{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expirationDate?: number; session: boolean }`
- `GmCookieService.list(wcId, scriptId, pageUrl, connect, filter: { url?: string; domain?: string; name?: string }): Promise<{ ok: boolean; cookies?: GmCookie[]; error?: string }>`
- `GmCookieService.get(wcId, scriptId, pageUrl, connect, filter: { url: string; name: string }): Promise<{ ok: boolean; cookie?: GmCookie | null; error?: string }>`
- 通道:`userscript:cookie-list` invoke `{ scriptId, pageUrl, url?, domain?, name? }`;`userscript:cookie-get` invoke `{ scriptId, pageUrl, url, name }`
- 安全:目标 host 必须通过 `connectAllows(connect, pageUrl, 'https://' + host + '/')`;结果截断 ≤100 条

**设计要点:**
- 走 `session.fromPartition('persist:').cookies.get(filter)`(Electron 11 支持 `{ url }`/`{ domain }`/`{ name }` 过滤)
- 只读:不实现 set/delete(安全边界,文档注明)
- 校验纯函数 `cookieHostAllowed(connect: string[], pageUrl: string, host: string): boolean` 放 `userscript-versions.ts` 旁的新纯函数导出(复用 `connectAllows`):
```ts
// userscript-versions.ts 追加:
export function cookieHostAllowed(connect: string[], pageUrl: string, host: string): boolean {
  if (!host) return false;
  return connectAllows(connect, pageUrl, 'https://' + host + '/');
}
```
⚠️ `connectAllows` 在 `userscript-request.ts`(纯模块,无 electron)——`userscript-versions.ts` import 它安全。

- [ ] **Step 1: gm-api 接口**:`GmApi` 加:
```ts
cookie: {
  list(details: { url?: string; domain?: string; name?: string }, ondone: (cookies: GmCookie[]) => void): void;
  get(details: { url: string; name: string }, ondone: (cookie: GmCookie | null) => void): void;
};
```
实现(经 `bridge.invoke`):
```ts
const cookie = {
  list: (details, ondone) => {
    void bridge.invoke('userscript:cookie-list', {
      scriptId: script.id,
      pageUrl: String(window.location.href || ''),
      url: details.url, domain: details.domain, name: details.name,
    }).then((raw) => ondone(Array.isArray((raw as { cookies?: unknown })?.cookies) ? (raw as { cookies: GmCookie[] }).cookies : []));
  },
  get: (details, ondone) => {
    void bridge.invoke('userscript:cookie-get', {
      scriptId: script.id,
      pageUrl: String(window.location.href || ''),
      url: details.url, name: details.name,
    }).then((raw) => ondone(((raw as { cookie?: GmCookie | null })?.cookie) ?? null));
  },
};
```
GM 对象加 `cookie`,legacy 加 `GM_cookie: cookie`;sandbox `LEGACY_GM_NAMES` 加 `'GM_cookie'`。

- [ ] **Step 2: service 实现** `userscript-cookie-service.ts`:
```ts
import { session } from 'electron';
import { connectAllows } from './userscript-request';
import type { GmCookie } from '../../../shared/userscript-types';

const MAX_COOKIES = 100;

function toGmCookie(c: Electron.Cookie): GmCookie {
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly,
    expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
    session: c.session,
  };
}

function resolveHost(filter: { url?: string; domain?: string }): string | null {
  try {
    if (filter.url) return new URL(filter.url).hostname;
    return (filter.domain ?? '').replace(/^\./, '').toLowerCase() || null;
  } catch { return null; }
}

export class GmCookieService {
  list(wcId: number, scriptId: string, pageUrl: string, connect: string[],
       filter: { url?: string; domain?: string; name?: string }): Promise<{ ok: boolean; cookies?: GmCookie[]; error?: string }> {
    const host = resolveHost(filter);
    if (!host || !connectAllows(connect, pageUrl, 'https://' + host + '/')) {
      return Promise.resolve({ ok: false, error: 'connect-denied' });
    }
    return session.fromPartition('persist:').cookies.get({ url: filter.url, domain: filter.domain, name: filter.name })
      .then((cookies) => ({ ok: true, cookies: cookies.slice(0, MAX_COOKIES).map(toGmCookie) }))
      .catch((error: Error) => ({ ok: false, error: error?.message ?? 'network' }));
  }

  get(wcId: number, scriptId: string, pageUrl: string, connect: string[],
      filter: { url: string; name: string }): Promise<{ ok: boolean; cookie?: GmCookie | null; error?: string }> {
    const host = resolveHost({ url: filter.url });
    if (!host || !connectAllows(connect, pageUrl, 'https://' + host + '/')) {
      return Promise.resolve({ ok: false, error: 'connect-denied' });
    }
    return session.fromPartition('persist:').cookies.get({ url: filter.url, name: filter.name })
      .then((cookies) => ({ ok: true, cookie: (cookies[0] ? toGmCookie(cookies[0]) : null) }))
      .catch((error: Error) => ({ ok: false, error: error?.message ?? 'network' }));
  }
}
```
`index.ts`:单例 `cookies: GmCookieService | null` + `getCookieService()` 导出 + init 时 `cookies = new GmCookieService();`

- [ ] **Step 3: ipc 通道**(`userscripts.ipc.ts`):
```ts
ipcMain.handle('userscript:cookie-list', async (event, raw: unknown) => {
  const parsed = z.object({ scriptId: z.string(), pageUrl: z.string(), url: z.string().optional(), domain: z.string().optional(), name: z.string().optional() }).safeParse(raw);
  const active = manager(); const service = cookies();
  if (!active || !service || !parsed.success) return { ok: false, error: 'not-ready' };
  const metadata = active.getScriptMetadata(parsed.data.scriptId);
  if (!metadata) return { ok: false, error: 'invalid-arguments' };
  return service.list(event.sender.id, parsed.data.scriptId, parsed.data.pageUrl, metadata.metadata.connect,
    { url: parsed.data.url, domain: parsed.data.domain, name: parsed.data.name });
});
// cookie-get 同构:{ scriptId, pageUrl, url, name } → service.get(...)
```
(import `getCookieService`;handler 内 `const cookies = () => getCookieService();`)

- [ ] **Step 4: 冒烟** `tests/electron/userscripts-cookie-smoke.cjs`:
骨架同 menu-dedupe:重建 runtime-preload + admin-module;mock 通道(get-config/report/menu-register/log/…);本地 server `/set-cookie` 响应 `Set-Cookie: demo=hello; Path=/`;BrowserView 加载 `/` 后 cookies 落 persist partition;
断言:用 fixture 脚本(内联安装,`@connect 127.0.0.1`):
1. `GM_cookie.list({ url: base + '/x' }, cb)` → cb 收到含 `demo` 的 cookie(值为 `hello`)
2. `GM_cookie.get({ url: base + '/x', name: 'demo' }, cb)` → 返回该 cookie
3. 未放行域:`GM_cookie.list({ url: 'https://evil.example/' }, cb)` → cb 收到 `[]`(connect-denied 时返回空数组)
fixture 把结果写入 `GM_setValue('cookie-test', …)`,冒烟轮询 `manager.getValuesFor` 断言;清理:卸载 fixture + 删 cookie。
跑法:`node tests/electron/build-userscripts-admin-smoke.mjs && node tests/electron/build-userscript-runtime-smoke.mjs` 后 `npx electron tests/electron/userscripts-cookie-smoke.cjs`

- [ ] **Step 5: 提交**
Commit: `feat(userscripts): GM_cookie 只读(list/get,受 @connect 域校验)`

---

## Task 6: GM_webRequest(仅观察)

**Files:**
- Create: `src/main/modules/userscripts/userscript-web-request.ts`(观察器)
- Modify: `src/main/modules/session-manager.ts`(单一 onBeforeRequest 回调内分发 beforeRequest 观察;setupSessionOnce 附加 onCompleted/onErrorOccurred)
- Modify: `src/main/modules/userscripts/index.ts`(observer 单例 + export + unregisterView 联动)
- Modify: `src/main/modules/userscripts/userscript-manager.ts`(`unregisterView` 时通知 observer 清理该 wc 的注册——通过注入回调或 index.ts 包装;采用 index.ts 包装:`reloadManagerScripts` 不动,observer 注册表在 wc 销毁时惰性清理)
- Modify: `src/main/ipc/userscripts.ipc.ts`(`userscript:web-request-register`/`-unregister` send 通道)
- Modify: `src/webview-preload/userscripts/gm-api.ts`(`GM_webRequest` + 事件分发)
- Modify: `src/webview-preload/userscripts/sandbox.ts`(LEGACY_GM_NAMES 加 `'GM_webRequest'`)
- Modify: `src/shared/userscript-types.ts`(`GmWebRequestEvent` 类型)
- Test: Create `tests/electron/userscripts-web-request-smoke.cjs`

**Interfaces:**
- `GmWebRequestEvent`:`{ phase: 'before-request' | 'completed' | 'error-occurred'; url: string; method: string; statusCode?: number; error?: string }`(url 已脱敏)
- `userscript-web-request.ts`:
```ts
export interface WebRequestRegistration {
  wcId: number; documentId: string; scriptId: string;
}
export interface WebRequestObserver {
  attach(sess: Electron.Session): void;           // 注册 onCompleted/onErrorOccurred 单例监听(幂等)
  notifyBeforeRequest(details: { url: string; method: string }): void; // session-manager 单一回调内调用
  register(r: WebRequestRegistration): void;      // 重复注册(同 wc+document+script)覆盖
  unregister(wcId: number, documentId: string, scriptId: string): void;
  setMatch(scriptId: string, match: string[]): void; // @match 过滤(脚本变更时更新;manager 侧 loadScripts 后 index.ts 调)
  setSend(send: (wcId: number, channel: string, payload: unknown) => void): void;
}
export function createWebRequestObserver(): WebRequestObserver;
```

**设计要点:**
- Electron 11 webRequest 监听器互斥:`onBeforeRequest` 只能在 session-manager 单一回调内分发(js-patch 共享);`onCompleted`/`onErrorOccurred` 未被占用,observer.attach 独立注册
- 事件匹配:请求 URL 经 `matchesUrl(compileRules({ match }), url)` 过滤(仅匹配该脚本 @match 的请求才会收到回调)——`setMatch` 存 `Map<scriptId, match[]>`;注册表 `Map<key, WebRequestRegistration>`,key = `${wcId}:${documentId}:${scriptId}`
- URL 脱敏:`redactUrlForLog`(`userscript-request.ts` 导出,纯函数)在事件构造时应用
- 发送:经注入的 `send`(index.ts 传 webContents 扫描版 sendToWc);发送时 wc 已销毁 → 删除该注册(惰性清理)
- 生命周期:页面刷新产生新 documentId → 新注册覆盖旧的(旧 key 残留条目由事件到达时清理——注册表 value 含 wcId,发送失败即删除全部该 wcId 条目)

- [ ] **Step 1: gm-api 接口**:`GmApi` 加:
```ts
webRequest(details: {
  onBeforeRequest?: (event: GmWebRequestEvent) => void;
  onCompleted?: (event: GmWebRequestEvent) => void;
  onErrorOccurred?: (event: GmWebRequestEvent) => void;
}): void;
```
实现:
```ts
let webRequestCallbacks: Partial<Record<'before-request' | 'completed' | 'error-occurred', (event: GmWebRequestEvent) => void>> | null = null;

const webRequest = (details: { onBeforeRequest?: (e: GmWebRequestEvent) => void; onCompleted?: (e: GmWebRequestEvent) => void; onErrorOccurred?: (e: GmWebRequestEvent) => void }): void => {
  webRequestCallbacks = {
    'before-request': details.onBeforeRequest,
    'completed': details.onCompleted,
    'error-occurred': details.onErrorOccurred,
  };
  bridge.send('userscript:web-request-register', { scriptId: script.id, documentId });
};

const handleWebRequestEvent = (event: GmWebRequestEvent): void => {
  const cb = webRequestCallbacks?.[event.phase];
  try { if (cb) cb(event); } catch { /* isolated */ }
};
```
GM 对象加 `webRequest`,legacy 加 `GM_webRequest: webRequest`;bootstrap 增加 `ipcRenderer.on('userscript:web-request-event', …)` 按 documentId+scriptId 分发到 `gm.handleWebRequestEvent`(GmApi 接口加 `handleWebRequestEvent(event: GmWebRequestEvent): void`;bootstrap 现有 `userscript:value-changed` 监听器同款写法)。

- [ ] **Step 2: observer 实现** `userscript-web-request.ts`:
```ts
import { compileRules, matchesUrl } from './userscript-matcher';
import { redactUrlForLog } from './userscript-request';
import type { GmWebRequestEvent } from '../../../shared/userscript-types';

export interface WebRequestRegistration {
  wcId: number; documentId: string; scriptId: string;
}
export interface WebRequestObserver {
  attach(sess: Electron.Session): void;
  notifyBeforeRequest(details: { url: string; method: string }): void;
  register(r: WebRequestRegistration): void;
  unregister(wcId: number, documentId: string, scriptId: string): void;
  setMatch(scriptId: string, match: string[]): void;
  setSend(send: (wcId: number, channel: string, payload: unknown) => void): void;
}

export function createWebRequestObserver(): WebRequestObserver {
  const registrations = new Map<string, WebRequestRegistration>();
  const matches = new Map<string, ReturnType<typeof compileRules>>();
  let send: (wcId: number, channel: string, payload: unknown) => void = () => {};
  let attached = false;

  const dispatch = (phase: 'before-request' | 'completed' | 'error-occurred',
                   details: { url: string; method: string; statusCode?: number; error?: string }): void => {
    for (const [key, reg] of Array.from(registrations)) {
      const rules = matches.get(reg.scriptId);
      if (!rules || !matchesUrl(rules, details.url)) continue;
      const event: GmWebRequestEvent = {
        phase, url: redactUrlForLog(details.url), method: details.method,
        statusCode: details.statusCode, error: details.error,
      };
      try {
        send(reg.wcId, 'userscript:web-request-event', { scriptId: reg.scriptId, documentId: reg.documentId, event });
      } catch {
        for (const [k, r] of registrations) if (r.wcId === reg.wcId) registrations.delete(k);
      }
    }
  };

  return {
    attach(sess) {
      if (attached) return;
      attached = true;
      sess.webRequest.onCompleted({ urls: ['*://*/*'] }, (details: any) => {
        dispatch('completed', { url: String(details.url ?? ''), method: String(details.method ?? ''), statusCode: details.statusCode });
      });
      sess.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details: any) => {
        dispatch('error-occurred', { url: String(details.url ?? ''), method: String(details.method ?? ''), error: String(details.error ?? '') });
      });
    },
    notifyBeforeRequest(details) {
      dispatch('before-request', { url: details.url, method: details.method });
    },
    register(r) {
      registrations.set(`${r.wcId}:${r.documentId}:${r.scriptId}`, r);
    },
    unregister(wcId, documentId, scriptId) {
      registrations.delete(`${wcId}:${documentId}:${scriptId}`);
    },
    setMatch(scriptId, match) {
      matches.set(scriptId, compileRules({ match }));
    },
    setSend(fn) { send = fn; },
  };
}
```
(`compileRules({ match })` 合法——RuleSource 字段全可选。)

**bootstrap 分发**(`src/webview-preload/userscripts/bootstrap.ts`,仿现有 `userscript:value-changed` 监听器,`ipcRenderer.on` 与 `gmByScript` 均已存在):
```ts
ipcRenderer.on('userscript:web-request-event', (_event, payload: unknown) => {
  const message = payload as { scriptId?: string; documentId?: string; event?: GmWebRequestEvent };
  if (message.documentId !== documentId) return;
  const gm = gmByScript.get(String(message?.scriptId ?? ''));
  gm?.handleWebRequestEvent(message.event as GmWebRequestEvent);
});
```

- [ ] **Step 3: 接线**
- `index.ts`:observer 单例 `webRequestObserver = createWebRequestObserver()` + `setSend(sendToWc)` + `getWebRequestObserver()` 导出;`reloadManagerScripts()` 里对每个脚本 `observer.setMatch(script.id, script.metadata.match)`(loadScripts 后同步)。
- `session-manager.ts` `applyCompatibilitySessionConfig`:
```ts
import { getWebRequestObserver } from './userscripts';
// onBeforeRequest 回调内、callback({}) 之前:
getWebRequestObserver()?.notifyBeforeRequest({ url: details.url, method: details.method ?? 'GET' });
// 函数末尾:
getWebRequestObserver()?.attach(sess);
```
⚠️ session-manager → modules/userscripts 导入方向:userscripts/index.ts 不 import session-manager(无循环;js-patch 模式同款——js-patch-service 被 session-manager 调用)。
- `userscripts.ipc.ts` 通道:
```ts
registerValidatedListener('userscript:web-request-register',
  z.object({ scriptId: z.string(), documentId: z.string() }),
  (event, payload) => {
    const active = manager();
    if (!active || !active.isScriptInstalled(payload.scriptId)) return;
    getWebRequestObserver()?.register({ wcId: event.sender.id, documentId: payload.documentId, scriptId: payload.scriptId });
  });
registerValidatedListener('userscript:web-request-unregister',
  z.object({ scriptId: z.string(), documentId: z.string() }),
  (event, payload) => {
    getWebRequestObserver()?.unregister(event.sender.id, payload.documentId, payload.scriptId);
  });
```

- [ ] **Step 4: 冒烟** `tests/electron/userscripts-web-request-smoke.cjs`:
骨架同 cookie smoke(重建产物、mock 通道;额外 mock `userscript:web-request-register` 转发 observer.register,`userscript:web-request-event` 由真实 index.ts 逻辑不可用——冒烟直接调 observer:init manager 后 `mod.getWebRequestObserver()`;mock `userscript:web-request-register` handler 内调用 observer.register;页面加载 `/page.html`(server 提供;页面内含一个 `/api/data` 请求?观察器挂 session-manager 回调——冒烟不跑真实 session-manager!冒烟要模拟:直接调 `observer.notifyBeforeRequest({ url, method })` 模拟事件注入,断言 preload 侧回调执行(脚本 `GM_webRequest({ onBeforeRequest: e => GM_setValue('wr', JSON.stringify(e)) })` → 冒烟注入事件 → 轮询值断言 URL 已脱敏)。onCompleted 同法。断言:`wr` 值含 `redacted` 的 query 脱敏(URL `http://127.0.0.1:p/api?token=secret` → 事件 url 为 `http://127.0.0.1:p/api?<redacted>`)。
(说明:真实 session 级事件流由 session-manager 集成保证,冒烟聚焦 observer 分发+脱敏+匹配,事件注入用直接调用。)

- [ ] **Step 5: 提交**
Commit: `feat(userscripts): GM_webRequest 仅观察(before-request/completed/error-occurred,URL 脱敏,@match 过滤)`

---

## Task 7: UI 级容量配置

**Files:**
- Modify: `src/main/modules/config.ts`(Config 加 6 个容量字段 + schema + 默认值)
- Modify: `src/main/ipc/config.ipc.ts`(save-config schema 加字段;保存成功后热应用)
- Modify: `src/main/modules/userscripts/index.ts`(init 读 config 应用;导出 `applyCapacityConfig(cfg)` 供热更新;service 加 `setLimits` 方法)
- Modify: `src/main/modules/userscripts/userscript-request-service.ts`(`setLimits(partial)` 方法)
- Modify: `src/main/modules/userscripts/userscript-download-service.ts`(`setLimits(partial)` 方法)
- Modify: `src/renderer/components/panels/SettingsPanel.tsx`(容量输入区)
- Modify: `src/preload/index.ts` 白名单(无新通道,load/save-config 已存在)
- Modify: `src/renderer/types/electron.d.ts`(config 类型更新)
- Modify: i18n zh-CN/en
- Test: `tests/config-schema.test.ts`?config.ts 依赖 electron-store——vitest 可 import electron-store(node env 可用?electron-store v6 在纯 node 可实例化 ✓)。写单测:`loadConfig` 默认值 + `saveConfig` 原子合并。

**参数(与第一轮默认一致):**
- `userscriptMaxResponseMB`(默认 2)、`userscriptTimeoutSeconds`(15)、`userscriptMaxConcurrentPerScript`(4)、`userscriptMaxConcurrentGlobal`(16)、`userscriptDownloadMaxMB`(8)、`userscriptDownloadConcurrent`(4)
- 上限:1–64 MB / 1–120 s / 1–16 / 1–64 / 1–64 / 1–16(zod int 校验)

- [ ] **Step 1: config 扩展**(`config.ts`):
```ts
export interface Config {
  flashVersion: string; lowEndMode: boolean; downloadEngine: DownloadEngine; downloadDir: string;
  userscriptMaxResponseMB: number; userscriptTimeoutSeconds: number;
  userscriptMaxConcurrentPerScript: number; userscriptMaxConcurrentGlobal: number;
  userscriptDownloadMaxMB: number; userscriptDownloadConcurrent: number;
}
// defaults 与 schema 同步加(默认值如上)
```
`config.ipc.ts` save-config schema 加 `z.number().int().min(1).max(64)` 等;handler 保存成功后:
```ts
import { applyCapacityConfig } from '../modules/userscripts';
// saveConfig 之后:
applyCapacityConfig(cfg);
```

- [ ] **Step 2: service setLimits**(request/download service 各加):
```ts
setLimits(partial: Partial<Pick<GmRequestServiceOptions, 'maxResponseBytes' | 'defaultTimeoutMs' | 'maxConcurrentPerScript' | 'maxConcurrentGlobal'>>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) (this.options as Record<string, unknown>)[key] = value;
  }
}
```
(download 同构:`maxBytes`/`maxConcurrentPerScript`。)

- [ ] **Step 3: init 应用 + 热更新**(`index.ts`):
```ts
import { loadConfig } from '../config';
// initUserscriptManager 内构造 service 处:
const cfg = loadConfig();
requests = new GmRequestService({
  …,
  maxResponseBytes: cfg.userscriptMaxResponseMB * 1024 * 1024,
  defaultTimeoutMs: cfg.userscriptTimeoutSeconds * 1000,
  maxConcurrentPerScript: cfg.userscriptMaxConcurrentPerScript,
  maxConcurrentGlobal: cfg.userscriptMaxConcurrentGlobal,
});
downloads = new GmDownloadService({
  …,
  maxBytes: cfg.userscriptDownloadMaxMB * 1024 * 1024,
  maxConcurrentPerScript: cfg.userscriptDownloadConcurrent,
});

export function applyCapacityConfig(cfg: Config): void {
  requests?.setLimits({
    maxResponseBytes: cfg.userscriptMaxResponseMB * 1024 * 1024,
    defaultTimeoutMs: cfg.userscriptTimeoutSeconds * 1000,
    maxConcurrentPerScript: cfg.userscriptMaxConcurrentPerScript,
    maxConcurrentGlobal: cfg.userscriptMaxConcurrentGlobal,
  });
  downloads?.setLimits({
    maxBytes: cfg.userscriptDownloadMaxMB * 1024 * 1024,
    maxConcurrentPerScript: cfg.userscriptDownloadConcurrent,
  });
}
```
(⚠️ 模块依赖方向:index.ts import '../config'——config.ts 无 electron 依赖问题?有 electron-store,主进程 OK;确认无循环:config.ts 不 import userscripts。)

- [ ] **Step 4: SettingsPanel UI**:`MainConfigForm` 加 6 字段;`useEffect` 读取时一并 set;`handleSave` 传参;表单区加"用户脚本容量"小节;`needsRestart` 不变(热更新无需重启,保存后 toast 仍走 success);i18n:`settings.userscriptCapacity.*`(title/maxResponseMB/timeoutSeconds/concurrentPerScript/concurrentGlobal/downloadMaxMB/downloadConcurrent)。
```tsx
interface MainConfigForm {
  flashVersion: string; lowEndMode: boolean; downloadEngine: DownloadEngine;
  userscriptMaxResponseMB: number; userscriptTimeoutSeconds: number;
  userscriptMaxConcurrentPerScript: number; userscriptMaxConcurrentGlobal: number;
  userscriptDownloadMaxMB: number; userscriptDownloadConcurrent: number;
}
// useEffect 读取:
if (cfg) setMainForm({
  flashVersion: cfg.flashVersion, lowEndMode: cfg.lowEndMode, downloadEngine: cfg.downloadEngine,
  userscriptMaxResponseMB: cfg.userscriptMaxResponseMB, userscriptTimeoutSeconds: cfg.userscriptTimeoutSeconds,
  userscriptMaxConcurrentPerScript: cfg.userscriptMaxConcurrentPerScript, userscriptMaxConcurrentGlobal: cfg.userscriptMaxConcurrentGlobal,
  userscriptDownloadMaxMB: cfg.userscriptDownloadMaxMB, userscriptDownloadConcurrent: cfg.userscriptDownloadConcurrent,
});
// handleSave 传参追加 6 个字段。
// 表单 JSX(插在 mainForm 现有区块后):
<h3 style={{ fontSize: 13, marginTop: 16 }}>{LL.settings.userscriptCapacity.title()}</h3>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
  {[
    ['userscriptMaxResponseMB', LL.settings.userscriptCapacity.maxResponseMB(), 1, 64],
    ['userscriptTimeoutSeconds', LL.settings.userscriptCapacity.timeoutSeconds(), 1, 120],
    ['userscriptMaxConcurrentPerScript', LL.settings.userscriptCapacity.concurrentPerScript(), 1, 16],
    ['userscriptMaxConcurrentGlobal', LL.settings.userscriptCapacity.concurrentGlobal(), 1, 64],
    ['userscriptDownloadMaxMB', LL.settings.userscriptCapacity.downloadMaxMB(), 1, 64],
    ['userscriptDownloadConcurrent', LL.settings.userscriptCapacity.downloadConcurrent(), 1, 16],
  ].map(([key, label, min, max]) => (
    <label key={key as string} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
      <span style={{ opacity: 0.7 }}>{label as string}</span>
      <input
        type="number" min={min as number} max={max as number} step={1}
        value={String(mainForm[key as keyof MainConfigForm] as number)}
        onChange={(e) => handleMainChange(key as keyof MainConfigForm, Number(e.target.value))}
        style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      />
    </label>
  ))}
</div>
```

- [ ] **Step 5: 验证 + 提交**
Run: `npm run typecheck && npm test -- --run`;重建产物后 `npx electron tests/electron/gm-capacity-smoke.cjs` 仍 ALL PASS(默认值不变)
Commit: `feat(settings): 用户脚本容量可配置(响应/超时/并发/下载上限,保存即热应用)`

---

## Task 8: 脚本导出(.user.js)

**Files:**
- Modify: `src/main/ipc/userscripts-admin.ipc.ts`(`userscripts:export-source` invoke 通道)
- Modify: `src/preload/index.ts` 白名单 + api
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/components/userscripts/UserscriptsPage.tsx`(每行导出按钮)
- Create: `src/main/modules/userscripts/userscript-export.ts`(纯函数:`defaultExportFileName`)
- Modify: i18n zh-CN/en
- Test: `tests/userscript-export.test.ts`

**Interfaces:**
- `defaultExportFileName(name: string): string` — 非法字符替换 + `.user.js` 后缀(`name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) + '.user.js'`)
- 通道 `userscripts:export-source` invoke `{ id }` → dialog.showSaveDialog(默认名 defaultExportFileName) → fs.writeFile(script.source) → `{ ok: true, path } | { ok: false, error }`

- [ ] **Step 1: 纯函数 + 单测** `userscript-export.ts` + `tests/userscript-export.test.ts`:
```ts
it('sanitizes file names', () => {
  expect(defaultExportFileName('Game Helper')).toBe('Game_Helper.user.js');
  expect(defaultExportFileName('a/b:c*?')).toBe('a_b_c_.user.js');
});
```

- [ ] **Step 2: ipc + preload + d.ts**
```ts
createValidatedHandler('userscripts:export-source', z.object({ id: z.string() }), async (payload) => {
  const source = getUserscriptSource(payload.id);
  if (source === undefined) return { ok: false, error: 'not-found' };
  const script = listUserscripts().find((s) => s.id === payload.id);
  const win = getWindow();
  const options: Electron.SaveDialogOptions = {
    title: '导出脚本',
    defaultPath: defaultExportFileName(script?.metadata.name ?? payload.id),
    filters: [{ name: 'Userscript', extensions: ['user.js', 'js'] }],
  };
  const result = win && !win.isDestroyed()
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
  try {
    await (await import('fs')).promises.writeFile(result.filePath, source, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
```
preload:`ALLOWED_INVOKE_CHANNELS` 加 `'userscripts:export-source'`;api `exportSource: (id) => safeInvoke('userscripts:export-source', { id })`;electron.d.ts 同步。

- [ ] **Step 3: UI**(UserscriptsPage 行内 actions 区,编辑/删除按钮旁):
```tsx
<button type="button" title={LL.userscript.export()}
  onClick={() => void exportScript(script)}
  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', color: 'var(--text-secondary)' }}>
  <Download className="w-4 h-4" />
</button>
```
```tsx
const exportScript = useCallback(async (script: InstalledUserscript): Promise<void> => {
  const result = (await window.electronAPI.userscripts.exportSource(script.id)) as { ok: boolean; path?: string; error?: string };
  showNotice(result.ok && result.path ? LL.userscript.exported({ path: result.path }) : LL.userscript.exportFailed({ error: result.error ?? 'unknown' }));
}, [showNotice, LL]);
```
i18n:`userscript.export/exported({path})/exportFailed({error})`。

- [ ] **Step 4: 验证 + 提交**
Run: `npm run typecheck && npm test -- --run` + `npm run lint`
Commit: `feat(userscripts): 脚本导出为 .user.js(保存对话框)`

---

## Task 9: 后台多窗口隔离(per-script 窗口池)

将单后台窗口重构为每 @background 脚本一个隐藏窗口:崩溃互不影响,一个脚本禁用只销毁自己的窗口。

**Files:**
- Modify: `src/main/modules/userscripts/userscript-manager.ts`(`ViewRegistration` 加 `backgroundScriptId?: string`;`snapshotBackground` 按该字段过滤)
- Modify: `src/main/modules/userscripts/userscript-background.ts`(重写为窗口池,复用 Task 1 tracker)
- Modify: `src/main/modules/userscripts/index.ts`(接线:注入 `listBackgroundScripts` getter;`reloadManagerScripts` 后 `runtime.sync()`;`getBackgroundRuntime` 不变)
- Modify: `src/main/ipc/userscripts.ipc.ts`(get-config 分派:`getScriptIdForWc`)
- Modify: `src/main/ipc/userscripts-admin.ipc.ts`(for-tab 用 `getWcIds()`;Task 4 已预留)
- Modify: `src/renderer/components/userscripts/UserscriptsPage.tsx`(后台状态区显示停止的脚本名)+ i18n
- Modify: `tests/electron/background-script-smoke.cjs`(双脚本双窗口断言 + 现有断言适配 `getWcIds`)
- Modify: `tests/userscript-manager-background.test.ts`(补 backgroundScriptId 过滤用例)

**Interfaces(重写后):**
```ts
export interface BackgroundScriptStatus {
  scriptId: string; running: boolean; crashedCount: number; stopped: boolean;
}
export interface BackgroundRuntime {
  start(): void;            // 为每个 background 脚本建窗(幂等)
  stop(): void;             // 全部销毁
  restart(): void;          // 全部重建
  sync(): void;             // 按当前脚本集 diff:新增建窗/移除销毁
  getStatus(): { scripts: BackgroundScriptStatus[]; stopped: boolean };
  getWcIds(): number[];
  getScriptIdForWc(wcId: number): string | null;
}
export function createBackgroundRuntime(options: {
  preloadPath: string;
  manager: UserscriptManager;
  partition?: string;
  listBackgroundScripts: () => InstalledUserscript[];   // index.ts 注入,避免循环
}): BackgroundRuntime;
```

**设计要点:**
- 每脚本一个 `BrowserWindow`(`backgroundThrottling: false` 保留);`registerView(wcId, { mode:'ppapi', generation:++gen, token:'background', kind:'background', backgroundScriptId: script.id })`
- `snapshotBackground(wcId)` 只返回该窗口的脚本(`registration.backgroundScriptId` 过滤)
- 崩溃:`tracker.record(scriptId)` → shouldStop → 该脚本 `stopped = true`(其他脚本窗口不受影响);退避重建仅自己
- `sync()` diff:脚本集 vs 窗口池;新脚本建窗、消失的销毁(`tracker.reset` 同步);`stopped` 的脚本不再自动建窗(直到 restartScript/restart)
- `restart()`:重置全部 tracker + 重建全部窗口(等价手动"重启后台运行时")
- generation 每窗口独立递增

- [ ] **Step 1: manager 改动 + 单测**
`ViewRegistration` 加 `backgroundScriptId?: string`;`snapshotBackground`:
```ts
snapshotBackground(wcId: number): FrameSnapshot {
  const registration = this.views.get(wcId);
  if (!registration || registration.kind !== 'background') return { ok: false, scripts: [], values: {} };
  const matched: SnapshotScript[] = [];
  …循环过滤:
  for (const script of this.scripts.values()) {
    if (!script.metadata.background) continue;
    if (registration.backgroundScriptId && script.id !== registration.backgroundScriptId) continue;
    …
  }
}
```
补单测(`tests/userscript-manager-background.test.ts`):
```ts
it('snapshotBackground filters by backgroundScriptId', () => {
  manager.loadScripts([makeScript('bg1', { background: true }), makeScript('bg2', { background: true })]);
  manager.registerView(1, { mode: 'ppapi', generation: 1, token: 't', kind: 'background', backgroundScriptId: 'bg1' });
  const snap = manager.snapshotBackground(1);
  expect(snap.scripts.map((s) => s.id)).toEqual(['bg1']);
});
```

- [ ] **Step 2: runtime 重写** `userscript-background.ts`(完整代码):
```ts
import { BrowserWindow } from 'electron';
import { createCrashTracker } from './userscript-crash-tracker';
import type { UserscriptManager } from './userscript-manager';
import type { InstalledUserscript } from '../../../shared/userscript-types';

export interface BackgroundScriptStatus {
  scriptId: string; running: boolean; crashedCount: number; stopped: boolean;
}
export interface BackgroundRuntimeStatus {
  scripts: BackgroundScriptStatus[]; stopped: boolean;
}
export interface BackgroundRuntime {
  start(): void; stop(): void; restart(): void; sync(): void;
  getStatus(): BackgroundRuntimeStatus;
  getWcIds(): number[];
  getScriptIdForWc(wcId: number): string | null;
}
export interface BackgroundRuntimeOptions {
  preloadPath: string;
  manager: UserscriptManager;
  partition?: string;
  listBackgroundScripts: () => InstalledUserscript[];
}

interface ScriptWindowState {
  scriptId: string;
  window: BrowserWindow | null;
  generation: number;
  tracker: ReturnType<typeof createCrashTracker>;
  backoffTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

export { backoffDelayMs } from './userscript-crash-tracker'; // 旧测试兼容

export function createBackgroundRuntime(options: BackgroundRuntimeOptions): BackgroundRuntime {
  const states = new Map<string, ScriptWindowState>();

  const ensureState = (scriptId: string): ScriptWindowState => {
    let state = states.get(scriptId);
    if (!state) {
      state = { scriptId, window: null, generation: 0, tracker: createCrashTracker(), backoffTimer: null, stopped: false };
      states.set(scriptId, state);
    }
    return state;
  };

  const spawn = (state: ScriptWindowState): void => {
    if (state.window && !state.window.isDestroyed()) return;
    state.stopped = false;
    state.generation += 1;
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        plugins: false,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
        partition: options.partition ?? 'persist:',
      },
    });
    state.window = win;
    const wcId = win.webContents.id;
    options.manager.registerView(wcId, {
      mode: 'ppapi', generation: state.generation, token: 'background',
      kind: 'background', backgroundScriptId: state.scriptId,
    });
    win.webContents.on('render-process-gone', () => {
      const record = state.tracker.record(state.scriptId);
      if (record.shouldStop) {
        destroy(state);
        state.stopped = true;
        return;
      }
      state.backoffTimer = setTimeout(() => { state.backoffTimer = null; spawn(state); }, record.nextDelayMs);
    });
    void win.loadURL('data:text/html;charset=utf-8,');
  };

  const destroy = (state: ScriptWindowState): void => {
    if (state.backoffTimer) { clearTimeout(state.backoffTimer); state.backoffTimer = null; }
    if (state.window && !state.window.isDestroyed()) {
      options.manager.unregisterView(state.window.webContents.id);
      state.window.destroy();
    }
    state.window = null;
  };

  return {
    start(): void {
      for (const script of options.listBackgroundScripts()) spawn(ensureState(script.id));
    },
    stop(): void {
      for (const state of states.values()) destroy(state);
    },
    restart(): void {
      for (const state of states.values()) { state.tracker.reset(state.scriptId); destroy(state); }
      this.start();
    },
    sync(): void {
      const wanted = new Set(options.listBackgroundScripts().map((s) => s.id));
      for (const scriptId of Array.from(states.keys())) {
        if (!wanted.has(scriptId)) { destroy(ensureState(scriptId)); states.delete(scriptId); }
      }
      for (const script of options.listBackgroundScripts()) {
        const state = ensureState(script.id);
        if (!state.stopped) spawn(state);
      }
    },
    getStatus(): BackgroundRuntimeStatus {
      const scripts = Array.from(states.values()).map((s) => ({
        scriptId: s.scriptId,
        running: Boolean(s.window && !s.window.isDestroyed()),
        crashedCount: s.tracker.crashedCount,
        stopped: s.stopped,
      }));
      return { scripts, stopped: scripts.some((s) => s.stopped) };
    },
    getWcIds(): number[] {
      return Array.from(states.values())
        .filter((s) => s.window && !s.window.isDestroyed())
        .map((s) => s.window!.webContents.id);
    },
    getScriptIdForWc(wcId: number): string | null {
      for (const state of states.values()) {
        if (state.window && !state.window.isDestroyed() && state.window.webContents.id === wcId) return state.scriptId;
      }
      return null;
    },
  };
}
```
⚠️ `createCrashTracker` 需暴露 `crashedCount` 查询——Task 1 接口加 `crashedCount(scriptId: string): number`(Step 1 单测同步补一条;`getStatus` 用它)。

- [ ] **Step 3: index.ts 接线**
```ts
backgroundRuntime = createBackgroundRuntime({
  preloadPath: process.env.BAO_USERSCRIPT_PRELOAD_PATH || path.join(__dirname, 'webview-preload.js'),
  manager,
  partition: 'persist:',
  listBackgroundScripts: () => (manager?.backgroundScripts() ?? []),
});
backgroundRuntime.start();
```
`reloadManagerScripts()` 内 `backgroundRuntime?.restart()` 改为 `backgroundRuntime?.sync()`。

- [ ] **Step 4: ipc 适配**
`userscripts.ipc.ts` get-config 分派:
```ts
const bgScriptId = getBackgroundRuntime()?.getScriptIdForWc(event.sender.id) ?? null;
if (bgScriptId != null) {
  event.returnValue = active.snapshotBackground(event.sender.id);
} else {
  event.returnValue = active.snapshotFor(event.sender.id, payload.url, payload.isMainFrame);
}
```
`userscripts-admin.ipc.ts` for-tab(Task 4 已写 `getWcIds()` 版,确认即可);invoke-command 不变(commandTarget 已跨 wc)。

- [ ] **Step 5: UI**:后台状态区改为列出停止的脚本:
```tsx
{bgStatus && !bgStatus.running && bgStatus.scripts.filter((s) => s.stopped).length > 0 ? (…)
```
i18n `userscript.background.stopped` 改 `{scripts}` 参数(`stoppedScripts({ scripts })` 文案:"后台脚本已停止:{scripts}",每脚本一个重启按钮走既有 `background-restart` 全量重启)。

- [ ] **Step 6: 冒烟适配 + 双窗口断言** `background-script-smoke.cjs`:
- `getWcId()` 调用全部改为 `getWcIds()[0]` / 循环;`waitFor` 条件改为 `getWcIds().length >= 1`
- 新增断言:安装第二个 bg fixture(`background-demo2.user.js`,仅 `@background`+值写入)→ `getWcIds().length === 2`;禁用 demo2 → `getWcIds().length === 1` 且剩余窗口仍跑(bg-running 仍为 1);两个窗口 `getScriptIdForWc` 各归其位
- N3 断言:`get-ruffle-mode` 查询计数随窗口数增长

- [ ] **Step 7: 回归 + 提交**
Run: `npm run typecheck && npm test -- --run`;重建产物后连跑 3 次 `background-script-smoke.cjs` ALL PASS
Commit: `feat(userscripts): 后台脚本每脚本独立窗口(崩溃/启停互不影响)`

---

## Task 10: 文档 + 探针 + 全量回归

**Files:**
- Modify: `docs/userscript-developer-guide.md`(GM_cookie 只读安全边界/GM_webRequest 仅观察+URL 脱敏/容量配置/脚本导出/多窗口隔离:崩溃只影响单脚本、stopped 语义)
- Modify: `docs/userscript-user-guide.md`(设置页容量项/导出按钮/后台窗口按脚本隔离)
- Modify: `AGENTS.md`(webRequest 观察器必须组合进 session-manager 单一 onBeforeRequest;多窗口背景运行时 landmine:get-config 按 wc 反查脚本、窗口池 sync)
- Modify: `tools/probe/probes/01-userscripts.cjs`(无需改,容量字段在 config 探针?探针无 config 项——跳过)
- 新增探针(可选):`tools/probe/probes/12-userscript-capacity.cjs` 读 config 容量字段

- [ ] **Step 1: 文档更新**(三份)
- [ ] **Step 2: 探针**(12-userscript-capacity.cjs 读 `userData/config.json` 的容量字段)
- [ ] **Step 3: 全量回归**
Run: `npm run check` 全绿
Run: 重建产物后:`npm run test:userscripts`(required 全过)、`npm run test:userscripts-admin`、7 个既有冒烟(values-persistence×2/gm-capacity/update/menu-dedupe/background×3/cookie/web-request)、`npm run probe`、`npm run probe:deep`
- [ ] **Step 4: 提交**
Commit: `docs+probe: 第二轮加固文档(只读 cookie/观察 webRequest/容量配置/导出/多窗口)与全量回归`

---

## 范围外(明确不做)

- GM_cookie `set`/`delete`、GM_webRequest 拦截/修改(安全边界,见 Global Constraints)
- 自动更新后台定时轮询(仍手动)
- 后台脚本 DOM 访问(设计上无页面)
- 后台窗口按脚本分组的自定义分组策略(每脚本一窗,上限未设;后台脚本数量大时另行评估)

## 验证矩阵

| 冒烟/测试 | 关键断言 |
|---|---|
| `tests/userscript-crash-tracker.test.ts` | 退避 1,2,4,8,60s;5 次停止;reset 清零;per-script 独立 |
| `tests/userscript-sidebar.test.ts` | 合并标记 background:true;路由 tab→background→none |
| `tests/userscript-export.test.ts` | 文件名净化 + .user.js 后缀 |
| `userscripts-cookie-smoke.cjs` | list/get 读回 Set-Cookie;未放行域返回空;无 set/delete API |
| `userscripts-web-request-smoke.cjs` | 事件分发;URL query 脱敏;@match 过滤;仅观察不拦截 |
| `gm-capacity-smoke.cjs`(默认值不变) | 2MB/1.5MB onload、3MB 拒绝、并发 16+limit |
| `background-script-smoke.cjs` | 双脚本双窗口;禁用其一仅销毁自身;其余窗口不受影响;命令/值/connect-denied 仍全过 |
| `npm run check` | i18n+typecheck+lint+vitest+build 全绿 |
