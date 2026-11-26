# M2 / 书签与历史（第一片）：收藏夹存储层

2026-11-26 · 对应 [m2-beta §3 剩余范围](../kickoff/m2-beta.md#3-剩余范围)、
[C5-S3 裁决](../discussions/2026-11-21-bfb-next-architecture.md)（文件夹树一步到位）。

## 1. 形态裁决（2026-11-26，抄 Edge）

| 问题 | 裁决 |
| --- | --- |
| 收藏夹入口 | **工具栏按钮 + 飞窗面板**；设置飞窗里的「收藏夹」打开**同一个**面板，不另起一种 |
| 管理页 | 只有从**设置页**进入的才是整页管理器：`bao://favorites`（对应 `edge://favorites`） |
| 空态 | Edge 会在新标签页上留一条带提示的横条；Chrome 空书签时整条不占位（Chromium 142 源码 + 本机 Chrome 158 实测）。**本项按 Edge** —— 空态显示提示条 |
| 横条范围 | 默认只在**新标签页**显示；可开关成「所有标签都显示」（`bookmark_bar.show_on_all_tabs` 语义） |
| 文件夹 | 数据层是树；首版横条只平铺根层，文件夹在**面板里**展开 |

实测证据留档：`docs/design/evidence-2026-11-26-{chrome,edge}158-ntp-empty.png`；
形态演示：[`docs/design/bookmark-bar-demo.html`](../design/bookmark-bar-demo.html)。

## 2. 数据模型（schema v3）

```sql
CREATE TABLE bookmarks(
  id TEXT PRIMARY KEY,
  parent_id TEXT,                -- 永久根为 NULL
  position INTEGER NOT NULL,     -- 同级排序位，0..n-1 连续
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'url')),
  title TEXT NOT NULL,
  url TEXT,                      -- kind='url' 才有
  added_at INTEGER NOT NULL,
  CHECK ((kind = 'url' AND url IS NOT NULL) OR (kind = 'folder' AND url IS NULL)),
  CHECK (parent_id IS NOT NULL OR id IN ('bar', 'other'))
);
CREATE INDEX bookmarks_parent ON bookmarks(parent_id, position);
```

四个决定：

1. **两个永久根落在表里**（`bar` / `other`）：横条渲染谁的子节点不需要额外配置项，
   也不会出现第三个游离的顶层节点；`parent_id IS NULL` 只允许这两行，由 CHECK 兜住。
2. **树而不是扁平**：C5-S3 已裁决按 Chrome/Edge 形态做；扁平升树要数据迁移 + UI 重写。
3. **排序位是整数**：收藏夹规模几百条，移动时整组重排比 fractional index 简单，
   坏数据（`1,2,2,5`）一眼能看出来。
4. **地址合法性不在存储层判断**：存储只保证 `kind`/`url` 自洽；"什么算可收藏的地址"
   是 UI 与导入器的规则，会变。

## 3. 纯层：`shared/bookmarks.ts`

| 函数 | 作用 |
| --- | --- |
| `childrenOf` / `treeOf` | 排序与递归成树（带深度上限：真出现环时宁可少画一层，也不让 UI 栈溢出） |
| `descendantIds` | 递归删除与环检测 |
| `checkPlacement` | **五种拒绝**：节点不存在 / 永久根 / 移到自己下面 / 父节点不存在 / 父不是文件夹 / 移进自己的子孙 |
| `titleFor` | 空标题回落：http(s) 取 host（`example.com`），内部页显示完整地址（`bao://favorites/` 的 host 是 `favorites`，显示成那样反而认不出来） |
| `matchesQuery` | 面板搜索：标题与地址，大小写不敏感 |

这些都在毫秒级用例里穷举——树操作错起来在界面上只表现为「东西不见了」，靠点界面查不出来。

## 4. 迁移

`SCHEMA_VERSION` 2 → **3**。迁移里播种两个永久根；`openStore` 的既有保护不变
（旧库先备份、事务内迁移、版本高于当前直接拒绝）。

## 5. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | **313/313**（新增 30：纯层 16 + 存储 14） |
| `npm run test:data` | 11/11（含 `session-store` 的版本断言改为 3） |
| 隐藏冒烟（全量，4 并发） | **30 个文件 0 失败**，98.5 s |

存储层用例覆盖：播种/重复打开不重播、**v2→v3 迁移后旧设置仍在**、按序排队与
`position` 连续、文件夹嵌套、非法输入、同父重排、跨父移动（两侧都重排）、
环与永久根拒绝、级联删除 + 同级重排、`clearBookmarks` 只清内容、改名与空标题拒绝。

## 6. 未做（后续增量）

1. **UI**：横条（外壳第三行，占高 32 并入视图下移）——**已完成**，见
   [`2026-11-26-bookmark-bar.md`](./2026-11-26-bookmark-bar.md)；飞窗面板、`bao://favorites`
   管理页、星标收藏当前页、设置飞窗里的入口均已就位；
2. **历史**：M2 剩余范围里与书签并列的那一半（`urls` + `visits` 双表，C5-S2 已裁决）；
3. **导入 Chrome/Edge 书签**（书签栏文件夹结构要保住）；
4. **分类清理的「收藏」档**：`clearBookmarks` 已就绪，缺设置页入口；
5. **横条上的文件夹下拉**：裁决为首版不做，文件夹在面板里展开。
