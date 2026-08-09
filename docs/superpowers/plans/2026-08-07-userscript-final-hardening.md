# 用户脚本平台收尾加固(最终轮)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收尾五项:GM_webRequest 注册清理、后台脚本单独重启、GM 值管理 UI、单值上限参数化、冒烟自动化。

**Architecture:** 全部增量。注册清理走 manager `unregisterView` 联动(避免 webContents 事件时序问题);per-script 重启扩展既有 `background-restart` 通道(id 可选);值管理复用 manager 既有值方法,加无 view 依赖的管理方法;值上限走 config store(重启生效,注明);冒烟自动化用 Node 脚本串行执行 + 汇总。

**Tech Stack:** Electron 11.5 / TypeScript / zod / esbuild / Vitest

## Global Constraints

- Electron 11.5.0 锁定;0 新增依赖;纯逻辑模块零 Electron import
- 无参/可选参 IPC 通道 zod 用 `z.object({}).optional()` 或 `.extend` 可选字段
- 冒烟必须 mock 全部 preload 通道 + 固定 userData + `BAO_USERSCRIPT_PRELOAD_PATH`
- 新增 UI 文案随任务 i18n(zh-CN/en)
- **不做**自动更新定时轮询(保持手动;文档注明为后续产品决策)

---

## Task 1: GM_webRequest 注册清理

**Files:**
- Modify: `src/main/modules/userscripts/userscript-manager.ts`(`unregisterView` 已清命令/监听;新增 observer 清理回调注入)
- Modify: `src/main/modules/userscripts/userscript-web-request.ts`(`unregisterForWc(wcId)` 方法)
- Modify: `src/main/modules/userscripts/index.ts`(manager 构造时把 observer 清理挂进 unregisterView 联动)

**Interfaces:**
- `WebRequestObserver.unregisterForWc(wcId: number): void` — 删除该 wc 全部注册

**实现方案:** manager 不加 observer 依赖(保持解耦)——`index.ts` 里 `manager.unregisterView` 被调用后由调用方补清理不可靠;最简:observer 增加 `unregisterForWc`,由 `userscripts.ipc.ts` 无涉——改为 **runtime 与 tabs 之外的统一出口**:manager 增加可选构造回调 `onViewRemoved?: (wcId: number) => void`,`unregisterView` 内调用;index.ts 传 `(wcId) => webRequestObserver?.unregisterForWc(wcId)`。

- [ ] **Step 1: 实现** `userscript-web-request.ts` 加:
```ts
unregisterForWc(wcId: number): void {
  for (const [key, r] of registrations) {
    if (r.wcId === wcId) registrations.delete(key);
  }
},
```
- [ ] **Step 2: manager** `ManagerOptions` 加 `onViewRemoved?: (wcId: number) => void`;⚠️ 参照 `persistValues` 处理:从 `DEFAULT_OPTIONS`/`this.options` 的 `Required<Omit<...>>` 中排除,单独存 `private readonly onViewRemoved?: (wcId: number) => void`(构造 `this.onViewRemoved = options?.onViewRemoved`);`unregisterView` 末尾 `this.onViewRemoved?.(wcId);`
- [ ] **Step 3: index.ts** 构造传 `onViewRemoved: (wcId) => webRequestObserver?.unregisterForWc(wcId)`
- [ ] **Step 4: 验证** `npm run typecheck && npm test -- --run`;重建产物后 `wr-smoke` ALL PASS
- [ ] **Step 5: 提交** `fix(userscripts): GM_webRequest 注册随视图注销清理`

---

## Task 2: 后台脚本单独重启

**Files:**
- Modify: `src/main/ipc/userscripts-admin.ipc.ts`(`userscripts:background-restart` 支持可选 `{ id }`;`userscripts:background-status` 不变)
- Modify: `src/main/modules/userscripts/userscript-background.ts`(`restartScript(scriptId)` 方法:重置该脚本 tracker + 销毁重建)
- Modify: `src/renderer/components/userscripts/UserscriptsPage.tsx`(stopped 横幅每个脚本一个"重启"按钮)
- Modify: i18n zh-CN/en
- Modify: `src/preload/index.ts` + `src/renderer/types/electron.d.ts`(restart 带 id)

**Interfaces:**
- `BackgroundRuntime.restartScript(scriptId: string): void` — 仅该脚本窗口重建 + tracker.reset
- 通道 `userscripts:background-restart` schema `z.object({ id: z.string().optional() }).optional()`:有 id → restartScript,无 → restart

- [ ] **Step 1: runtime** 加 `restartScript(scriptId)`:
```ts
restartScript(scriptId: string): void {
  const state = states.get(scriptId);
  if (!state) return;
  state.tracker.reset(scriptId);
  destroy(state);
  spawn(state);
},
```
接口加 `restartScript(scriptId: string): void`。
- [ ] **Step 2: ipc** `background-restart` handler 改为:
```ts
createValidatedHandler('userscripts:background-restart', z.object({ id: z.string().optional() }).optional(), async (payload) => {
  const runtime = getBackgroundRuntime();
  if (payload?.id) runtime?.restartScript(payload.id); else runtime?.restart();
  return { ok: true };
});
```
- [ ] **Step 3: preload/d.ts**:`backgroundRestart(id?: string)`。
- [ ] **Step 4: UI**:stopped 横幅改为每个 stopped 脚本一行(名称 + 单独重启按钮);i18n `background.restartScript`。
- [ ] **Step 5: 验证 + 提交** `npm run typecheck`;重建产物后 bg-smoke ALL PASS
Commit: `feat(userscripts): 后台 stopped 脚本可单独重启`

---

## Task 3: GM 值管理 UI

**Files:**
- Modify: `src/main/modules/userscripts/userscript-manager.ts`(管理方法:无需 view 的 `listScriptValues(scriptId)/getScriptValue(scriptId,key)/setScriptValue(scriptId,key,value)/clearScriptValues` 已有)
- Modify: `src/main/ipc/userscripts-admin.ipc.ts`(通道 `userscripts:list-values`/`userscripts:set-value-admin`/`userscripts:delete-value-admin`)
- Modify: `src/preload/index.ts` + `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/components/userscripts/UserscriptsPage.tsx`(行内"值"按钮 + 值面板:键值列表/编辑/删除)
- Modify: i18n zh-CN/en
- Test: `tests/userscripts/userscript-manager-values.test.ts` 补管理方法用例

**Interfaces:**
- `UserscriptManager.listScriptValues(scriptId): Record<string, GMSerializable>`(无 view 依赖,直接读 values)
- `UserscriptManager.getScriptValue(scriptId, key): GMSerializable | undefined`
- `UserscriptManager.setScriptValue(scriptId, key, value): boolean`(绕过 setValue 的 view 校验,但保留可序列化/大小校验;触发 noteValueWrite + flush,不广播跨 wc——管理侧变更发 `broadcastUserscriptsChanged` 由 ipc 层做)
- 通道:`userscripts:list-values` `{ id }` → `{ values }`;`userscripts:set-value-admin` `{ id, key, value }` → `{ ok }`;`userscripts:delete-value-admin` `{ id, key }` → `{ ok }`

- [ ] **Step 1: manager 方法 + 单测**
```ts
listScriptValues(scriptId: string): Record<string, GMSerializable> {
  const result: Record<string, GMSerializable> = {};
  for (const key of this.values.list(scriptId)) {
    const value = this.values.get(scriptId, key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}
getScriptValue(scriptId: string, key: string): GMSerializable | undefined {
  return this.values.get(scriptId, key);
}
setScriptValue(scriptId: string, key: string, value: GMSerializable): boolean {
  if (!key) return false;
  const oldValue = this.values.get(scriptId, key);
  try {
    this.values.set(scriptId, key, value);
  } catch {
    return false;
  }
  this.noteValueWrite(scriptId, key, oldValue, value);
  return true;
}
```
单测追加(listScriptValues/setScriptValue 不注册 view 也可用;无效值返回 false;deleteScript 后为空)。
- [ ] **Step 2: ipc + preload + d.ts**
```ts
createValidatedHandler('userscripts:list-values', z.object({ id: z.string() }), async (payload) => ({
  values: getUserscriptManager()?.listScriptValues(payload.id) ?? {},
}));
createValidatedHandler('userscripts:set-value-admin', z.object({ id: z.string(), key: z.string().min(1), value: z.unknown() }), async (payload) => {
  const ok = getUserscriptManager()?.setScriptValue(payload.id, payload.key, payload.value as GMSerializable) ?? false;
  return { ok };
});
createValidatedHandler('userscripts:delete-value-admin', z.object({ id: z.string(), key: z.string().min(1) }), async (payload) => {
  const ok = getUserscriptManager()?.deleteScriptValue(payload.id, payload.key) ?? false;
  return { ok };
});
```
⚠️ manager 需补 `deleteScriptValue(scriptId, key): boolean`(deleteValue 的去 view 版,含 noteValueWrite)。
- [ ] **Step 3: UI**:行内 actions 区加"值"按钮(Database icon);点击开面板(modal/侧栏):列出 key→value(JSON 序列化显示,长值截断),每行可编辑(textarea JSON)与删除;保存经 set-value-admin;删除经 delete-value-admin;刷新列表。i18n:`userscript.values.title/open/edit/save/delete/invalid/empty`。
- [ ] **Step 4: 验证 + 提交** `npm run typecheck && npm test -- --run` + lint
Commit: `feat(userscripts): 管理页 GM 值查看/编辑/删除`

---

## Task 4: 单值上限参数化

**Files:**
- Modify: `src/main/modules/config.ts`(`userscriptMaxValueKB` 字段,默认 16,范围 1–1024)
- Modify: `src/main/ipc/config.ipc.ts`(schema)
- Modify: `src/main/modules/userscripts/index.ts`(构造 `new ValueStore({ maxValueBytes: cfg.userscriptMaxValueKB * 1024 })`)
- Modify: `src/renderer/components/panels/SettingsPanel.tsx`(容量区第 7 项)
- Modify: `src/renderer/types/electron.d.ts` + i18n
- ⚠️ 生效时机:init 时构造 ValueStore,保存后需重启(设置页该字段旁注明;handleSave 的 needsRestart 逻辑保持——容量类字段变化不标 restart?值上限需要重启,单独处理:该字段变化时 needsRestart=true)

- [ ] **Step 1: config/schema/SettingsPanel/electron.d.ts/i18n**(与 Task 7 模式一致,min 1 max 1024 KB)
- [ ] **Step 2: index.ts** `new ValueStore({ maxValueBytes: cfg.userscriptMaxValueKB * 1024 })`
- [ ] **Step 3: SettingsPanel** needsRestart 判定加 `mainForm.userscriptMaxValueKB !== DEFAULT_MAIN_CONFIG.userscriptMaxValueKB`
- [ ] **Step 4: 验证 + 提交** typecheck + 单测 + 容量探针摘要适配(探针 12 加 maxValueKB 字段)
Commit: `feat(settings): 单值上限可配置(重启生效)`

---

## Task 5: 冒烟自动化

**Files:**
- Create: `scripts/run-smokes.cjs`(串行构建 + 依次执行 8 个 electron 冒烟,汇总 PASS/FAIL,非零退出)
- Modify: `package.json`(`test:smokes` script)

**内容:**
- 构建:build-userscripts-admin-smoke.mjs → build-userscript-runtime-smoke.mjs(compatibility 不属本套)
- 依次:`values-persistence`(两进程)→ `gm-capacity` → `userscripts-update` → `menu-command-dedupe` → `userscripts-cookie` → `userscripts-web-request` → `background-script`(跑 2 轮防 flaky)
- 每个冒烟用 `spawnSync('npx', ['electron', path], { stdio: 'inherit' })`;检查输出含 `ALL PASS` 或退出码 0;超时保护(每冒烟 5 分钟)
- 总退出码:全部通过为 0,否则 1

- [ ] **Step 1: 写脚本** `scripts/run-smokes.cjs`(如上)
- [ ] **Step 2: package.json** `"test:smokes": "node scripts/run-smokes.cjs"`
- [ ] **Step 3: 验证** `npm run test:smokes` 全 PASS
- [ ] **Step 4: 提交** `chore: npm run test:smokes 串行跑全部用户脚本冒烟`

---

## Task 6: 文档 + 全量回归

**Files:**
- Modify: `docs/userscript-developer-guide.md`(值管理 UI/单值上限/单独重启;明确"自动更新仍手动")
- Modify: `docs/userscript-user-guide.md`(管理页值操作、后台单脚本重启)
- Modify: `AGENTS.md`(值管理通道、onViewRemoved 联动 landmine 补一句)

- [ ] **Step 1: 文档**
- [ ] **Step 2: 全量回归** `npm run check` + `npm run test:smokes` + probe/probe:deep 全绿
- [ ] **Step 3: 提交** `docs: 收尾加固文档与全量回归`

## 验证矩阵

| 冒烟/测试 | 关键断言 |
|---|---|
| `userscript-manager-values.test.ts` | 管理方法无 view 可用;非法值拒绝 |
| `wr-smoke` | 注册清理不破坏事件分发 |
| `bg-smoke` | 单独重启仅重建目标脚本窗口 |
| `npm run test:smokes` | 8 冒烟串行全 PASS |
| `npm run check` | 全绿 |
