# M2 / 收藏夹（第三轮）：收藏夹横条

2026-11-26 · 承接 [`2026-11-26-bookmarks-store.md`](./2026-11-26-bookmarks-store.md)（存储层与形态裁决）、
飞窗两轮（[`2026-11-26` 的提交](../../app/README.md)）。

## 1. 范围

工具栏下面那**第三行**：把「收藏夹栏」根下的网址平铺出来，点一下在当前标签打开。

| 项 | 裁决 | 依据 |
| --- | --- | --- |
| 高度 | **32** | Chromium 的 `BOOKMARK_BAR_HEIGHT` 是 28（触摸 UI 36，`chrome/browser/ui/layout_constants.cc:29`）；我们的工具栏按钮大一号（32 vs 28），横条按钮 24 + 上下 4px 内距 |
| 显示档位 | `ntp`（**默认**）/ `always` / `never` | Edge「显示收藏夹栏」的三档；Chromium 用两个布尔 pref 拼出同样三档，拆开会让「从不」和「仅新标签页」在设置页里没有名字。默认档排**第一行**（用户第一眼该看到自己当前的状态） |
| 空态 | 一行提示条 + 「立即管理收藏夹」 | Edge 实测（`docs/design/evidence-2026-11-26-edge158-ntp-empty.png`）；Chrome 空书签整条不占位 |
| 内容层级 | 只平铺「收藏夹栏」根下**一层** | 与 Chromium 的横条一致；文件夹在**面板**里展开，横条下方的文件夹下拉（独立弹出层 + 自动关闭 + 键盘可达）本版不做 |
| 放不下的项 | 藏掉 + 右侧 `»` | Chromium 的 `first_hidden_node_idx_` + overflow 菜单；我们的 `»` 直接打开收藏夹面板（不自己画菜单） |
| 工具栏下边框 | 横条出现时**不画** | Edge 实测只有横条底部那一道线 |

## 2. 一个判定，两处消费

```
shared/bookmarks.ts:  showsBookmarkBar(mode, internal) → boolean      ← 规则本体
        └─ main/browser-window.ts  bookmarkBarShown(tab)              ← 规则 + 时序
             ├─ layout():  y = 40 + 44 + (bar ? 32 : 0)
             └─ state().bookmarkBarShown → renderer 的 :v-if
```

两处各写一遍就是这类"固定高度条"最典型的错位：条画出来了、页面视图却压在下面一截。
本轮第一版真的踩到了——**设置写进库、界面也变了，就是视图没让位**。根因不在判定，而在
设置变更的广播路径：`refreshAllWindows()` 只做 `refreshSettings()` + `broadcastSettings()`，
`layout()` 从来没被调用；外壳之所以看起来"变了"，是因为命令返回值里带了新状态。
修法是把重排放进 `refreshProjection()`（`layout()` → `publish()`），并让 `refreshAllWindows()`
调它——**任何改变外壳高度的设置项都必须走这条路**，用例直接量视图 `y` 把这条钉住。

### 2.1 判定为什么最终由主进程给

第二版把"画不画"改成外壳只消费 `state.bookmarkBarShown`：规则本体仍是那个纯函数，但这条
判定还带**时序**——见 §2.2。外壳拿 `settings` + `active.internal` 自己算，就会把横条算早收。

### 2.2 导航途中按住（"横条先消失再跳转"）

**现象**（2026-11-26 反馈）：从新标签页输入网址回车，横条先消失，页面区域先变白，然后页面
才出现——看起来像"点了没反应"。

**原因**：离开 NTP 要换 WebContents（内部会话永不承载 http(s)），`tab.internal` 在导航**开始**
那一刻就清了，而新视图还是白的。横条绑在 `internal` 上，于是它抢在页面之前收。

**依据**：Chromium 在**提交**时才重算横条——`BookmarkBarController::DidFinishNavigation` →
`UpdateBookmarkBarState(StateChangeReason::kTabState)`（`bookmark_bar_controller.cc:218`）。

**做法**：`Tab.barHold`。`leaveNewTab()` 里置位（在 `swapView` 之前，否则第一次投影就已经收了），
新视图的 `did-navigate` / `did-fail-load` / `did-stop-loading` / `destroyed` 四个一次性事件
谁先到谁放开（`release()` 幂等），放开时 `layout()` + `publish()`：横条与新页面**同一帧**变。
`never` 档优先于按住——用户明确关掉的东西不能因为"时序"又画出来。

用例 `bookmark-bar.test.cjs` 的时序那条起了一个**慢服务器**（800 ms 才回 HTML），在"导航途中"
的 250 ms 里反复采样横条必须还在；把 `barHold` 改成 `false` 时它第 1 次采样就红（已验证）。

## 3. 点击与锚定

- **网址项**：`open-bookmark` 命令，地址由主进程按 id 从库里取（界面拿不到任意导航能力）。
- **文件夹项**：打开收藏夹面板，**锚在那颗按钮下**（不是工具栏的收藏夹按钮）。
  面板是 320 宽的飞窗，横条上的按钮普遍靠左（右缘 291 < 320 + 边距 6），右对齐会被夹到
  窗口最左边、看起来跟按钮没关系。所以 `flyoutBounds()` 加了 `anchorLeft`：**右边放不下时
  改成左对齐**（卡片左缘贴住按钮左缘）。这条同时惠及以后所有靠左的锚点。
- **右键**：原生菜单（`bookmark-bar-menu` → `Menu.popup`）。菜单回调跑在主进程里，没有
  "命令结果"可返回，所以写设置失败必须自己 `overlays.notifyFailure()` 送回外壳的提示条——
  否则用户看到的就是"点了没反应"。这一条是新加的通道（`report-failure` 之前只有浮层能用）。
- **点击穿透**：横条在视图**上方**（属于外壳文档），不涉及飞窗那套投影边距转发。

## 4. 溢出：为什么用 `visibility` 而不是 `v-if`

Chromium 是"排一遍、量每个按钮、放不下的 `SetVisible(false)`"。我们照做，但藏的方式是
`visibility: hidden`：

```
排一次（全部项都在布局里）→ 从左边累加 offsetLeft + offsetWidth → 超过 limit 的项藏掉
```

`display: none` 会让被藏的项宽度变 0，第二次测量时它们又"放得下"了 → 来回抖。
`visibility: hidden` 保留布局，测量因此**一次收敛**；`tabindex="-1"` + `aria-hidden` 保证
被藏的项不进入键盘/读屏顺序。`»` 绝对定位在右端、宽度由测量预留（`BAR_OVERFLOW_WIDTH`），
所以它的出现与否不会反过来改变量到的 limit。

## 5. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | **358/358**（新增 7：显示规则 4、左对齐锚定 2、默认档兜底 1） |
| 隐藏冒烟（全量） | 见 §5.1 |
| `bookmark-bar.test.cjs` | 3 条：显示规则/页面让位/点击导航/文件夹锚定/设置页三档；**导航途中按住**；显示档位跨重启保留 |

## 5.1 全量结果

**31 个文件 0 失败**，110.5 s（4 并发，隐藏窗口；默认档排第一行 + 横条"等页面提交再收"
之后重跑）。

## 6. 未做

1. **横条上的文件夹下拉**（点文件夹在条下方弹一层列表、里层再套）——需要独立弹出层；
   当前是"点文件夹 → 打开收藏夹面板"；
2. **`bao://favorites` 管理页**：拖动排序、重命名/删除文件夹、导入 Chrome/Edge 书签；
3. **favicon 管道**：横条与面板里的条目现在用通用页面图标；
4. **中键在新标签页打开收藏**（`open-bookmark` 目前只导航当前标签）；
5. **历史**（`urls` + `visits` 双表）。

## 7. 证据

`docs/evidence/2026-11-26-bookmark-bar-{empty,light}.png`（外壳 + 页面视图按真实 bounds 合成，
像素未做任何修饰；两张都是**默认档**：空态提示条、新标签页上的三项）。

只在**默认档**下截图是刻意的：上一版证据是在探针里手动切到「始终显示」之后拍的，于是
"网页上也有一条横条"、"设置页里选中『始终显示』"这两张图和产品默认行为自相矛盾
（2026-11-26 反馈）——证据必须是默认行为的样子，想拍别的档位就得单独标注。
