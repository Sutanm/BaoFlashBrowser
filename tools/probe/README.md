# AI 开发协助工具包 — 探针原型库

针对 BaoFlashBrowser 的**精准探针工具包**。设计目标:AI 或开发者**不必重复测试**来决定"在哪里加探针、实现哪些功能"——找到对应原型,复制 `_template.cjs` 二次开发即可。探针执行有硬超时护栏,永不挂满默认超时;日志**只读追加,不清理、不截断**。

## 快速开始

```bash
npm run probe          # 纯 Node 快检(秒级):构建新鲜度/脚本/配置/git/日志
npm run probe:deep     # Electron 深层:主进程模块健康 + 运行时健康(BrowserView)
node tools/probe/host.cjs --only 00,03   # 指定探针(支持前缀)
node tools/probe/host.cjs --json         # JSON 输出(喂 AI)
SMOKE_TIMEOUT=200 npm run probe:deep     # 提高宿主 watchdog(默认 90s)
```

## 探针清单

| id | 探针 | 宿主 | 回答的问题 |
|---|---|---|---|
| `00-build` | 构建产物新鲜度 | 纯 Node | 产物是否过期?该跑哪个 build?(源码 mtime vs 产物) |
| `01-userscripts` | 已安装脚本 | 纯 Node | userData 里装了哪些脚本、启停状态、版本 |
| `02-config` | 配置快照 | 纯 Node | flashVersion / lowEndMode / downloadEngine 等 |
| `03-git` | git 状态 | 纯 Node | 分支、未提交文件、最近提交 |
| `04-logs` | 日志尾部 | 纯 Node | 日志路径、尾部 N 行、error/warn 计数(**不清理日志**) |
| `10-main-process` | 主进程模块健康 | Electron | userscript manager 能否初始化、与磁盘存储是否同步 |
| `11-views` | 运行时健康 | Electron | 真实 BrowserView:主框架/iframe 脚本执行、命令去重、命令生效 |

## 架构

```
host.cjs / host-electron.cjs     宿主原型:发现探针 → 逐探针执行 → 汇总输出
lib/context.cjs                  上下文:项目根、userData、日志定位、mtime 工具
lib/timeout.cjs                  超时原语:withTimeout / waitFor 轮询 / 进程级 watchdog
lib/reporter.cjs                 输出:文本表 / --json;部分失败不中断,退出码=失败数
probes/_template.cjs             新探针模板(复制即二次开发)
probes/<NN>-<name>.cjs           探针实例(00-09 纯 Node,10-19 Electron)
```

## 二次开发:新增一个探针

1. **复制** `probes/_template.cjs` → `probes/12-my-check.cjs`;
2. 填四个字段 + `run(ctx)`:
   ```js
   module.exports = {
     id: '12-my-check',        // 唯一,前缀 12 表示第 12 号探针
     name: 'my check',         // 表格显示名
     needsElectron: false,     // true 则放 host-electron.cjs 里跑
     timeoutMs: undefined,     // 可选:探针级预算
     async run(ctx) {
       // ctx = { root, userData, logFile, readJsonSafe, latestMtime, exists }
       //   needsElectron 探针额外有 ctx.electron = { app, BrowserWindow, BrowserView, ipcMain }
       return { ok: true, summary: '一行摘要', detail: { ...任意 JSON } };
     },
   };
   ```
3. 不需要改宿主——两个宿主自动发现 `probes/*.cjs`(跳过 `_template.cjs`),按 `needsElectron` 分流;
4. 运行验证:`npm run probe -- --only 12`。

## 规则(硬性)

- **只读**:探针不得写 userData/配置/产物/应用状态。深层探针 `initUserscriptManager()` 只读不保存。
- **日志**:只读追加。禁止删除、清空、截断日志文件——完整日志留给后续调试。
- **超时**:所有等待必须走 `lib/timeout.cjs`(waitFor/withTimeout);宿主还有进程级 watchdog
  (默认 90s,`SMOKE_TIMEOUT` 覆盖),任何探针都无法挂满 5 分钟。
- **永不中断他人**:探针失败只计失败数,不影响其他探针执行。
- **喂 AI**:`--json` 输出结构化结果;日志探针输出完整文件路径,AI 可按需全量读取。

## 选型速查(遇到问题用哪个)

| 症状 | 先跑 |
|---|---|
| "冒烟测的是旧代码/行为不对" | `00-build` → 看 stale 项,跑对应 build 命令 |
| "脚本没生效/装没装" | `01-userscripts`(快)+ `10-main-process`(深) |
| "页面挂了/渲染卡死" | `04-logs`(错误计数)+ `11-views`(运行时健康) |
| "启动配置不对" | `02-config` |
| "改到一半忘了改了什么" | `03-git` |
| "验证新站点/新场景" | 复制 `11-views`,改 fixture 页与断言 |

## 与现有测试的关系

- 工具包**不替代** `tests/electron/*` 冒烟;`11-views` 是 menu-command-dedupe 冒烟的
  "探针化"原型,供复制扩展。
- `lib/timeout.cjs` 的超时原语可被现有冒烟直接 require 使用(可选加固,未强制接入)。
- 不触碰 `src/main/modules/diagnostics.ts`(平台诊断导出,属产品功能)。
