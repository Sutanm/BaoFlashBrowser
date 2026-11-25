> **已落地（2026-11-25 22:40 标注）**：本文 §5 建议的三步验证已全部走完，结论与实测见
> [overlay-shared-process-demo.md](2026-11-25-overlay-shared-process-demo.md) §5–§7：共享进程已成为**默认**，
> 常驻预热（`always`）也是默认档；§0 表格里的 ②（`incrementCapturerCount` 不是 JS API）与 ③（`pointerdown` 提前）
> 都已确认——②取消，③被"常驻预热"取代（比提前指针事件更彻底）。
> 另外本文"preload 不继承 ⇒ 角色判定要重写"的担忧，实际解法是**借 opener 的 contextBridge**（同源同进程可跨窗口调用）。

# 评审：「浮层寄居外壳渲染进程」方案（附 clone() 重新审计）

2026-11-25 · 对象：外部方案评估（`window.open` + `createWindow` 让浮层复用外壳渲染进程、`incrementCapturerCount` 替代内核补丁、pointerdown 提前触发）。
性质：**已在本机自编译 E39 内核上跑通验证**，不是纸面推演。

## 0. 结论

| 主张 | 判定 | 依据 |
| --- | --- | --- |
| ① `window.open` + `createWindow` 把 guest 包成 WCV，浮层与外壳**共用渲染进程** | ✅ **成立，已实测** | 同 pid、渲染进程数 1、WCV 接管成功、子文档正常渲染且背景透明 |
| ② 用 `incrementCapturerCount` 替代内核补丁 | ❌ **需修正** | 它**不是 JS API**：Electron 39 与 44 的 `electron.d.ts` 都没有；只在 C++ 的 `capturePage()` 内部调用。要用就得加 shell 补丁 |
| ③ 把打开时机提前到 `pointerdown` | ✅ 合理，但优先级低 | 我们已有 hover 预热（更早）；只有在「不预热」策略下才有额外收益 |
| ④ 压缩冷启动剩余部分（拆计时、小 bundle、`v8CacheOptions`） | ✅ 合理 | `v8CacheOptions: 'bypassHeatCheck'` 在 E39 是合法取值 |
| ⑤ 不要用全局 `--process-per-site` | ✅ 同意 | 它会把同站点页面标签也合进一个进程 |
| ⑥ `Menu.popup` 适合列表类浮层 | ✅ 同意 | 与现有「引擎下拉」评估一致 |

## 1. ① 的实测细节（自编译 E39，`0A7C92A9`）

demo：外壳页 `window.open('/child.html')`，主进程在 `setWindowOpenHandler` 里 `createWindow` → `new WebContentsView({ webContents: options.webContents })` → 挂到窗口 → 返回 `view.webContents`。

```
[wo] createWindow 收到 guest id=2 pid=692
[wo] shell pid=692
[wo] guest  pid=692   same=true
[wo] renderers=[692]                     ← 全应用只有一个渲染进程
[wo] child facts={"child":"string","preload":"undefined",
                  "openerMarker":"shell-alive","w":320,"h":240,
                  "bg":"rgba(0, 0, 0, 0)"}
[wo] view attached=true bounds={"x":0,"y":0,"width":320,"height":240}
```

同时确认了实现约束（源码 `lib/browser/guest-window-manager.ts`）：

```js
const webContents = createWindow({ webContents: guest, ...options })
if (webContents !== guest) throw new Error('Created window should be connected to webContents passed with options object.')
```

→ `createWindow` 拿到的就是 Chromium 建好的 guest，**必须原样返回**；而 `WebContentsView({ webContents })` 正是接管它的合法入口（我们做 clone 时已验证过这个接管路径）。

### 回复没提、但落地会撞到的四件事

| 项 | 影响 |
| --- | --- |
| **preload 不继承** | 实测子文档里 `window.__shellPreload` 是 `undefined`。浮层现在靠 `preload/index.js` 暴露的 `baoOverlay` 桥（`resize-*` / `report-ready` / `close-quick`），迁过去后这条桥**不能用**，得改成同源直连（`window.opener` / `postMessage` / 直接操作 `popup.document`） |
| **角色判定要重写** | `shell-overlays.ts` 的 `sender()` 用「frame URL 带 `baoOverlay=overlay` + sender === flyout.webContents」认角色；共享进程后 sender 是新的 guest，判定要换成「是不是我们注册过的那个 guest」 |
| **外壳的 open handler 现在是全 deny** | `browser-window.ts:1947` `setWindowOpenHandler(() => ({ action: 'deny' }))`，要改成**只精确放行浮层 URL**，其余仍 deny（外壳是受信任代码，但仍不该开任意窗口） |
| **`outlivesOpener` 默认 false** | 子窗口会随 opener 关闭；retire/销毁都要显式管理，否则回到「界面没了但外壳以为还开着」那类问题 |

另外回复自己承认的代价成立：**外壳与浮层同崩溃域、同主线程**。

## 2. ② 的更正：`incrementCapturerCount` 在 E39 与 E44 都不是 JS API

E39 的用法只在 C++ 内部（`electron_api_web_contents.cc:3658`，`capturePage` 实现里）：

```cpp
auto capture_handle = web_contents()->IncrementCapturerCount(
    rect.size(), stay_hidden, stay_awake, /*is_activity=*/true);
```

所以「不用改内核就能做到 paintWhenInitiallyHidden 的语义」在 E39 上不成立。可选路径三条：

1. **加一个小 shell 补丁**：暴露 `webContents.incrementCapturerCount()`，返回一个 handle（析构时自动 decrement）。约 20–30 行，比 PPAPI 补丁小得多，但要进内核账。
2. **用现有全局开关**：`--disable-backgrounding-occluded-windows`（自动化模式已经在用）。
3. **保持“挂载但不显示”**而不是 `removeChildView`：先量一下重显时是否真的重建合成面，再决定要不要动。

建议先做 3 的测量——如果"移出窗口再挂回"本来就不重建合成面，这条根本不必优化。

## 3. clone() 重新审计（结论不变，但理由升级）

| 项 | 结论 |
| --- | --- |
| 能否用于**标签复制** | ❌ 仍然不能 |
| 理由 1（preload） | **升级为普适结论**：进程共享路径拿不到 preload——`window.open` 子窗口同样 `preload: undefined`。所以这不是 clone 的移植缺陷，而是 Electron 的行为 |
| 理由 2（PPAPI） | 不变：同一渲染进程里的第二个 PPAPI 实例无法实例化（克隆体 `<embed>` 退化成普通元素） |
| 内核补丁 0007 的处置 | **保留**（无消费者、无副作用），"何时再看"补一条：若上游让同进程 frame 也能拿到 startup data/preload，clone 与 `window.open` 会同时解锁 |
| 未来若要"复制标签保历史" | 仍只有两条路：`clone()`（等上游）或 `navigationHistory.getAllEntries() + restore()`（现成、无进程共享） |

## 4. 若采纳①，需要动的代码面

| 文件 | 改动 |
| --- | --- |
| `src/main/shell-overlays.ts` | 从「主进程 loadURL 建 WCV + 预热」改成「等外壳发起的 guest → 包 WCV」；`sender()`/命令集按新身份重写；retire/close 生命周期重排 |
| `src/renderer/App.vue` | 打开浮层改成 `window.open(...)`（同源、不带 noopener）；定位/测量改走 opener 直连或 postMessage |
| `src/preload/index.ts` | 浮层不再依赖 `baoOverlay` 桥（或保留外壳侧、去掉浮层侧） |
| `src/main/browser-window.ts` | 外壳 `setWindowOpenHandler` 从 deny-all 改成"精确放行浮层 URL + 其余 deny" |
| 测试 | `quick-settings.test.cjs` / `overlay-prewarm-hidden.test.cjs` 里按 `?baoOverlay=overlay` 找视图的写法要改（guest 的 URL 相同但身份不同） |

## 5. 建议的验证顺序

1. **用真实 `index.html?baoOverlay=overlay` 做迁移 demo**（不是玩具页）：验证冷启动时间、叠加层测量链路、透明背景、以及「外壳卡顿拖累浮层」的实际体感。
2. 在同一 demo 上量 ②：先看"移出窗口再挂回"是否重建合成面，再决定要不要暴露 capturer count。
3. ③ pointerdown 最后加，收益相对小。
