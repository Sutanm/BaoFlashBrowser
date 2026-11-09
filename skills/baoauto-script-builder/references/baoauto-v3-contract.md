# `.baoauto` v3 契约速查

本文件随 Skill 附带、离线可用，是"没有仓库检出"环境（普通用户的安装包 + 网页 AI）的
主要事实源。schema 仍以目标版本应用的源码为权威：

- GitHub: https://github.com/Sutanm/BaoFlashBrowser
- Gitee:  https://gitee.com/sutanm/BaoFlashBrowser
- 关键文件：`src/shared/automation/package-v3.ts`（manifest/limits）、
  `src/shared/automation/javascript-api.ts`（`bao.*` 签名）、
  `src/main/modules/automation/package-v3.ts`（导入解析）

应用内也有对应文档：自动化工作台的「接口文档」页（API 签名）。
两处都读不到时，以**目标安装包应用的导入校验**为最终裁决。

## 包结构

```text
manifest.json          # 必须
workflow.json          # 可选，Blockly WorkflowDocumentV3
scripts/*.js|ts        # 可选，沙箱 JS/TS 前端
assets/**              # 可选，图片与图组
profiles/*.json        # 可选，入口/变量/画面预设
```

至少要有一个可运行前端（workflow 或 scripts 二选一及以上）。路径一律为相对 POSIX
路径；绝对路径、盘符、反斜杠、空段、`.` 与 `..` 均为非法。

包级默认预算：64 MiB 压缩、2,000 个条目、单条目 16 MiB、解压总内容 128 MiB。

## manifest.json 全字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | `"baoauto"` | 固定值 |
| `formatVersion` | `3` | 固定值；v1/v2 导入直接拒绝（`UNSUPPORTED_FORMAT`） |
| `id` | `string` | 包标识 |
| `name` | `string` | 显示名 |
| `description` | `string?` | 描述 |
| `frontends.workflow` | `"workflow.json"?` | Blockly 工作流文件 |
| `frontends.scripts` | `ScriptEntry[]` | 沙箱脚本条目，见下表 |
| `frontends.mainEntryId` | `string?` | 主入口；缺省时优先 `workflow`，否则第一个脚本 |
| `features` | `('workflow'\|'javascript'\|'assets'\|'profiles')[]` | 包含的能力 |
| `limits` | `Budget?` | 运行预算声明，见下节 |
| `assetMetadata` | `Record?` | 素材采集参考（viewport/region/surface + 尺寸 + viewportTransform）；外部导入的素材可能没有 |
| `integrity` | `Record<path, sha256>` | 对**每个非 manifest 条目**的 SHA-256 |

### ScriptEntry

| 字段 | 说明 |
|---|---|
| `id` | 脚本标识（mainEntryId 引用它） |
| `name` | 显示名 |
| `path` | 必须匹配 `` `scripts/${string}.${'js'|'ts'}` `` |
| `language` | `'javascript' \| 'typescript'`（可省略，按扩展名推断） |
| `permissions` | 声明的权限子集：`input` `vision` `ocr` `page.read` `page.navigate` `log` `notify` |

权限授予存在**包外**（用户批准），manifest 里写什么都不能自授权限。

## 运行预算（`limits`）

缺省字段沿用平台默认值，所以不写 `limits` 的旧包行为不变。

| 键 | 默认 | 硬上限 | 作用范围 |
|---|---|---|---|
| `maxCalls` | 10,000 | 20,000,000 | 单次运行的 API 调用总数（脚本与工作流共用） |
| `maxWallTimeMs` | 30 分钟 | 7 天 | 单次运行墙钟上限 |
| `maxExecutedNodes` | 100,000 | 20,000,000 | 仅 Blockly：执行节点数 |
| `maxLoopIterations` | 10,000 | 20,000,000 | 仅 Blockly：单循环迭代数 |

```json
"limits": { "maxCalls": 2000000, "maxWallTimeMs": 86400000 }
```

**三条预算独立生效**：长期挂机要同时覆盖 `maxCalls`、`maxWallTimeMs`（脚本运行时）
与 `maxWallTimeMs`（工作流运行时），只声明其一仍会被其余截断。

导入时的拒绝语义（不是静默裁剪）：

- 任何键超过硬上限 → `PACKAGE_INVALID`，拒绝导入；
- `limits` 下出现未知键（如拼错的 `maxCall`）→ 拒绝导入；
- 负数 / 小数 / 非整数字符串 → 拒绝导入。

预算是安全护栏不是能力：调大预算不带来任何新权限。
沙箱另有固定约束（非 manifest 可配）：并发 8、单次 API 调用 30s、源码 512KB、
单请求 64KB、返回值 256KB。

## `bao.*` API 速查

签名权威在 `src/shared/automation/javascript-api.ts`（`BaoAutomationApi`）。要点：

| 方法 | 关键参数 | 返回值要点 |
|---|---|---|
| `input.click(target, opts?)` | `count` 连点次数（双击=2） | `null`；失败抛错 |
| `input.move / drag / keyPress / typeText / scroll` | — | `null` |
| `vision.find(imageLocator)` | threshold / scales / mask / region | `ScriptLocatedTarget \| null`（含 point、ratioBounds、confidence） |
| `vision.exists(locator)` | — | `boolean` |
| `vision.waitForColor(region, colors, opts?)` | `tolerance` `timeoutMs` `pollIntervalMs(1~1000)` `minimumMatchingPixels` `consecutiveFrames` | **不匹配不抛错**：`{ found, matchingPixels, matchingRatio, maxMatchingPixels, matchBounds?, samples, elapsedMs }`。数像素式检测读 `matchingPixels` |
| `vision.waitForRegionChange(region, opts?)` | `colorDelta` `minimumChangedPixels` `changedPixelRatio` `consecutiveFrames` `reference: 'baseline'\|'previous'` | `{ changed, changedPixels, changedRatio, samples, elapsedMs }` |
| `ocr.findText(textLocator)` | `match: exact/contains/normalized` `minConfidence` | `ScriptLocatedTarget \| null`（`ratioPoint` 可直接用于点击） |
| `ocr.readText(region?, minConfidence?)` | — | `string`（读不出返回空串） |
| `ocr.readNumber(region?, locale?)` | — | `number` |
| `page.url / navigate / reload` | — | url 字符串 / `null` |
| `time.sleep(ms) / time.now()` | — | `null` / 单调毫秒数；**无需权限** |
| `log.debug/info/warn/error(msg)` | — | `null`；需要 `log` |
| `notify.show(title, body?)` | — | `null`；需要 `notify` |

## 定位器与区域

`PersistedRegion = { unit: 'ratio'|'logical', x, y, width, height }`。
`ratio` 空间为 **0..10000**（左上原点）。

| Locator | 字段 |
|---|---|
| `image` | `asset`、`method: 'template'\|'color'\|'auto'`、`threshold`、`alternatives?`（同帧多模板）、`scales?`、`mask: 'auto'\|'none'\|'alpha'`、`region?` |
| `text` | `text`、`match`、`minConfidence`、`region?`、`languageHint?` |
| `coordinate` | `point` |
| `firstOf` | `locators[]`（按序容错） |

`TargetRef = { locator, anchor?, offset?, selection? }`；selection 支持
`best / first / last / index / nearest`。

图组（image group）表达同一语义目标的多个视觉变体（方向/动画帧/昼夜/主题）。
threshold 是**验收门槛不是身份证明**：必须用正样本 + 易混淆负样本验证返回的
匹配矩形，不能只看分数。

## 采集与素材

包内采集的素材带 `assetMetadata`（来源 viewport/region/surface + 采集尺寸 +
viewportTransform）；外部导入的素材可能没有该元数据，匹配器可以搜索多个 scale，
但**真机验证不可省**。

## 序列化回环

`loadAutomationPackageV3(bytes)` ↔ `serializeAutomationPackageV3(pkg)` 必须无损保留
全部字段（包括 `limits`）。新增契约字段时，正反用例矩阵见 SKILL.md §4.2。
