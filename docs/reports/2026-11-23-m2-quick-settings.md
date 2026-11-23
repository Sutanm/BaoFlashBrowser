# M2 增量 2（下半）：齿轮快捷设置飞窗

2026-11-23 · 对应[架构 §3 外壳与标签](../discussions/2026-11-22-bfb-next-architecture.md#3-外壳标签与隔离)与用户确认的入口形态（**设置标签页 + 齿轮飞窗，双入口同源同步**）。上半（`bao://settings` 页面）见 [2026-11-23-m2-settings-page.md](2026-11-23-m2-settings-page.md)。

## 1. 方案与依据

| 决策 | 选择 | 依据 |
| --- | --- | --- |
| 飞窗载体 | **窗口内 `WebContentsView`**（复用 `panel`/`toast` 的同一套叠加层机制），不新建原生窗口 | 用户拍板（方案 A）：Electron 不适合照抄 Chromium 的原生 view 体系；飞窗只有 5 行，窗口内足够 |
| 能否超出窗口 | **不能**；按窗口内容区夹取，内容超出时面板内部滚动 | Chromium 的菜单是独立 `Widget`、夹到显示器工作区（`menu_controller.cc` 的 `monitor_bounds`、`MenuHost : public Widget`），Electron 的 WCV 做不到；用 A 就把「不超过窗口」写成合同 |
| 定位 | 顶边压齿轮按钮下沿（0 缝）、右边缘与按钮对齐 | 用户要求「紧贴按钮、不留缝」 |
| 视觉 | 圆角 12、投影 `0 12px 48px α.24 + 0 0 24px α.12`、边框用 `--stroke-divider`、无关闭按钮、底部「全部设置」通栏行 | Chromium 数值：`kMenuRadius → kMediumSmall = 12`（`layout_provider.cc`）、`bubble_menu_shadow_elevation = 12` + `MakeMdShadowValues`（`menu_config.h` / `shadow_value.cc`）、`kColorMenuBorder` |
| 同步 | 与设置页共用同一个主进程 store：任一侧写入都会广播 | 架构 §4「主进程持业务权威，渲染层只拿投影」 |

## 2. 改了哪些文件

新增：

| 文件 | 作用 |
| --- | --- |
| `app/src/renderer/QuickSettings.vue` | 飞窗面板（主题 / 默认引擎 / 全部设置），自绘 Chromium 数值，自己测量高度 |
| `app/tests/smoke/quick-settings.test.cjs` | 2 条合同用例 |

修改：

| 文件 | 改动 |
| --- | --- |
| `app/src/shared/overlay.ts` | `OverlayKind` 加 `quick`；新增 `set-quick` / `resize-quick` / `close-quick` 命令与 `quick-opened` / `quick-closed` 事件；`OverlayBridge` 对应方法 |
| `app/src/main/shell-overlays.ts` | `KINDS` 加 `quick`；`sender()` 识别第三种角色；`ensure/sync/close` 按 kind 泛化；新增 `clampBelow()`（贴按钮的飞窗**保顶边**、只压高度）；`escape()` 先关飞窗再关引擎面板；面板/飞窗只在窗口前台时抢焦点 |
| `app/src/preload/index.ts` | 暴露 `setQuick/resizeQuick/closeQuick` |
| `app/src/renderer/main.ts` | `?baoOverlay=quick` 挂 `QuickSettings.vue` |
| `app/src/renderer/App.vue` | 工具栏齿轮按钮；`quickBounds()` 按齿轮矩形算定位（左/上/下 16 px、右 8 px 投影留白）；开关与互斥（开飞窗关引擎面板，反之亦然）；Esc/点外部/窗口缩放/切标签关闭 |
| `app/src/main/browser-window.ts` | 命令发送者闸门：`quick` 角色只允许 `set-setting` 与 `open-settings`（引擎操作仍只属于 `panel`） |
| `app/scripts/test.cjs` | 冒烟列表加入 `quick-settings` |

## 3. 实跑命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `node scripts/test.cjs smoke`（隐藏） | ✅ **26 通过 + 6 跳过、0 失败**，103.7 s（32 条用例，含新增 2 条） |
| `node scripts/test.cjs data` | ✅ 6/6，20.4 s |
| 真实应用截图（出厂内核，`capturePage`） | 浅色/深色两张，见 `docs/design/renders/quick-settings-app-*.png` |

`quick-settings.test.cjs` 覆盖：

1. 齿轮打开飞窗 → 视图 `y+16 === 齿轮下沿`、`x+宽-8 === 齿轮右缘`、四个方向都不越出内容区；
2. 计算样式 `border-top-left-radius === 12px`（Chromium 数值）；
3. 面板里改主题 → 外壳 `dataset.theme`、`nativeTheme.themeSource` 一起变；
4. 与设置页双向同步：设置页读到深色；设置页写回浅色后飞窗的选中行跟着变；
5. 底部「全部设置」→ 关飞窗并切到设置标签页；
6. Esc 关闭（飞窗自身键盘路径）、点外壳其它位置关闭；
7. 最小窗口（520×360）：视图不越出内容区、面板 `overflow-y: auto` 且 `scrollHeight > clientHeight`（真滚动，不是被裁掉）。

## 4. 实现里踩到的四个坑（都写进代码注释）

1. **测量用 `getBoundingClientRect().height` 会自激收缩**：面板 `max-height` 依赖视图高度（`100vh`），测量→缩视图→再测量，最后塌成 44 px 一条。改用 `scrollHeight`（内容高度）后稳定。
2. **通用 `clampBounds()` 会把飞窗整体上移**：它先夹位置再夹尺寸，最小窗口下 `y` 从 62 被夹成 25，飞窗从按钮下沿跳到窗口顶部。新增 `clampBelow()`：**顶边不动**，只压高度。
3. **外壳不能调 `close-quick`**：那是 quick 角色自己「关闭并请求焦点归还」的命令；外壳侧关闭走 `set-quick(null)`（与引擎面板用 `set-panel(null)` 一致），否则发送者校验会拒掉。
4. **飞窗是独立文档，必须自己 `applyShellTheme()`**：不调用时 CSS 变量不存在，暗色下会渲染成白底黑字（截图里抓到过）。

分辨率细节：`scrollHeight` 不含边框，视图高度 = 内容 + 32 + 2，避免"刚好相等"时冒出滚动条。

## 5. 未验证 / 不承诺

1. **前台全量冒烟未跑**（本次只跑了隐藏模式；改动只涉及 overlay，但发布前应跑 `npm run smoke:foreground`）。
2. **打包产物未跑**（`smoke:packaged`）：飞窗不涉及产物差异，但未实测。
3. **多显示器 / 125%–200% 缩放**未验证：定位用的是 CSS 像素，Electron 的 `getBounds()` 也是 DIP，预期一致但没在双屏上试。
4. **飞窗内键盘导航**只做到 Tab/点击 + Esc；没有实现方向键在选项间移动（引擎面板也没有）。
5. **滚动条外观**未定制：溢出时是 Chromium 默认滚动条（与 Chrome 菜单一致，但不是 Fluent 风格）。
6. 观察到一个**偶发不稳定**：一次全量跑里 `engine` 用例在等引擎面板控件时超时（45 s），单独跑与随后重跑全量都通过——怀疑是长套件下窗口/浮层加载慢，未定位。

## 6. 下一步

M2 剩余：书签/历史（SQLite v2/v3 + 外壳 UI）、下载（策略与 UI）、会话恢复、未加载占位、两阶段引擎切换、i18n、标签分组/搜索、发布门禁。
