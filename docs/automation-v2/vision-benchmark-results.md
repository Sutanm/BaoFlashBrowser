# Automation 2.0 图像定位基准报告

> 日期：2026-08-31
> 基线：`@techstark/opencv-js 4.12.0-release.1` + Worker + BGRA 内存帧
> 平台：Windows x64；WSL2 Linux x64

## 1. 目的

本报告只评估图片 Locator，不与 OCR 指标混用。目标是回答：

1. 当前 OpenCV.js 是否仍可作为默认模板定位基线；
2. Windows 与 Linux 是否产生一致结果；
3. 性能瓶颈来自截图、场景大小、模板数量、缩放档还是 Worker 启动；
4. 哪些失败需要改算法，哪些不能靠降低统一阈值掩盖。

## 2. 工具与复现

执行：

```text
npm run benchmark:vision
```

它会：

1. 在 `.cache/vision-benchmark/corpus` 生成版本 1 manifest；
2. 将所有 PNG 解码成明确宽高的 BGRA 原始帧；
3. bundle 与生产代码相同的 `AutomationVisionService`、Scheduler 和 `OpenCvWorkerMatcher`；
4. 分别记录 Worker 启动、每样本首请求、暖态 mean/p50/p95、score、位置误差、算法分支、WASM heap 和进程 RSS；
5. 将逐样本 JSON 写入 `.cache/vision-benchmark/result-*.json`，该目录不提交 Git。

Linux 不需要再次安装 Sharp：语料在 Windows 生成一次后，WSL runner 直接读取同一份 BGRA 内存帧。因此两个平台比较的是相同字节输入，而不是各自 PNG 解码结果。

## 3. 语料

基础语料不依赖用户目录：

| Suite | 内容 |
|---|---|
| web-ui | 仓库内真实 Automation 工作台截图与 UI crop |
| transparent-sprite | 带透明边缘的 sprite，验证 alpha mask |
| low-variance | 低方差纯色块，验证 SQDIFF 分支 |
| multi-instance | 同一模板出现三次，验证候选与 NMS |
| roi | 与 multi-instance 相同场景，仅搜索局部区域 |
| scale | 最近邻放大的 1.25 倍像素图 |

如果存在 `BAO_VISION_REAL_CORPUS_DIR`，或默认的桌面“钓鱼素材包”，还会加入：

- 1418×839 真实游戏截图与 4 张不存在于当前画面的操作素材，验证误报和最坏负样本性能；
- 真实“收线”像素素材合成正样本；
- Chrome 恐龙真实截图与完全一致的 54×46 crop。

## 4. 结果

### 4.1 汇总

| 指标 | Windows x64 | WSL2 Linux x64 |
|---|---:|---:|
| 样本通过 | 8/9 | 8/9 |
| Worker 启动 | 160.1ms | 371.7ms |
| 进程 RSS | 93.7MiB | 144.2MiB |
| Web UI 整图 warm p95 | 70.5ms | 68.4ms |
| 恐龙真实 crop warm p95 | 14.0ms | 13.6ms |
| 真实大图负样本 warm p95 | 393.0ms | 430.0ms |
| 1.25 像素缩放最强 score | 0.6067 | 0.6067 |

Windows 使用 2 次 warmup、10 轮；WSL 使用 1 次 warmup、3 轮。WSL 数据足以验证功能一致性和大致性能级别，但正式发布数字仍应增加轮数并在原生 Linux CI/实体机复测。

### 4.2 正确性

- 普通网页 UI、透明素材、低方差素材、多实例、ROI、真实像素素材和恐龙真实 crop 均通过；
- 命中样本位置误差为 0–1 像素；
- 真实大图负样本在 0.90 条件下没有误报；其最强候选仅约 0.32，距离阈值约 -0.58；
- Windows 与 Linux 的通过/失败集合完全相同；
- 三种算法分支均得到覆盖：`ccoeff`、`ccorr-mask`、`sqdiff`。

### 4.3 V4 已确认失败：最近邻像素缩放

1.25 倍像素样本的位置和尺寸都正确，最强候选也是正确的 1.25 scale，但 score 只有约 `0.6067`。当前 Worker 对放大模板使用 `INTER_LINEAR`，而游戏像素画常使用 nearest-neighbor；两个重采样结果边缘不同。

这个问题不能通过降低全局阈值解决：降低到约 0.60 会同时显著扩大普通 UI 和大图负样本的误报面。正确方向是：

1. 增加受控的 nearest 插值候选；或
2. 可靠检测像素素材后选择 nearest；或
3. 将插值策略作为高级 Locator 参数，同时保持普通用户默认自动选择。

在没有新增普通网页缩放反例前，不应直接把所有放大模板从 linear 全局改为 nearest。

### 4.4 性能结论

- Worker 启动不是连续监测的主要成本；启动后 Windows/Linux 的模板匹配耗时接近；
- ROI 对性能有决定性作用。小型多实例整图为数毫秒，局部 ROI 可进一步降到约 1ms；
- 1418×839 × 4 templates × 3 scales 的负样本必须跑完整搜索，warm p95 达到约 0.4 秒；
- 因此普通用户的“指定游戏区域”和 Locator Region 不是装饰选项，而是关键性能边界；
- 默认三个缩放档在负样本上成本最高，后续应评估按素材/Surface 缩放策略裁剪，而不是无限追加 scale。

## 5. 技术选型结论

当前证据不支持立即废弃 OpenCV：

- 同一 WASM 算法在 Windows/WSL 行为一致；
- 1×普通 UI、透明图、低方差、多实例和真实游戏 crop 均正确；
- 已有 Worker、缓存、Scheduler、NMS、ROI 和跨平台发布路径。

同时也不能宣布当前实现已经完成：

- nearest-neighbor 像素缩放未通过；
- 大图、多模板、多 scale 的负样本约 0.4 秒；
- WSL 验证是 Node/Worker/BGRA/OpenCV.js 管线，不等于 Linux Electron BrowserView 的完整端到端发布验收。

下一步优先在 OpenCV 基线上做两个有数据支撑的候选实验：像素 nearest 插值策略，以及负样本 scale 剪枝。只有候选在同一 corpus 上改善失败项且不降低 web-ui/误报指标，才进入产品代码。原生 OpenCV、ONNX 或其他后端也必须使用这份 manifest 比较，不能另选有利样本。

## 6. V5 放大插值 A/B（2026-08-31）

V5 在同一 corpus 中新增一条 1.25 倍线性重采样的 Web UI 样本，并让 Matcher 可在启动时选择 `linear` 或 `nearest`。产品路径仍只运行一种策略，不会把两种插值都跑一遍。

| 候选 | Windows | WSL2 Linux | 像素图 score | 平滑 UI score | 大图负样本最强 score |
|---|---:|---:|---:|---:|---:|
| linear | 9/10 | V4 已验证共同失败 | 0.6067 | 约 0.92 | 约 0.32 |
| nearest | 10/10 | 10/10 | 1.0000 | 约 0.93 | 约 0.32 |

Windows 使用 1 次 warmup、5 轮；WSL nearest 使用 1 次 warmup、3 轮。两种插值在 Windows 的缩放样本耗时均约 5–7ms，没有证据表明 nearest 会引入额外运行成本。nearest 修复了像素素材，同时没有降低新增平滑 UI 样本分数，也没有抬高真实大图负样本的最强候选。

因此 V5 将模板放大默认值改为 `INTER_NEAREST`，缩小仍使用 `INTER_AREA`，alpha mask 继续使用 `INTER_NEAREST`。内部仍保留 linear 构造选项，专门用于未来 corpus 回归和后端比较；普通用户与脚本作者不需要理解或配置插值方式。

## 7. V6 可信 Surface scale 策略（2026-08-31）

逐项计时确认，真实 1418×839 负样本的成本均匀分布在三档和四张素材上：

| 维度 | 操作数 | `matchTemplate` 耗时 |
|---|---:|---:|
| scale 1.0 | 4 | 约118ms |
| scale 0.75 | 4 | 约112ms |
| scale 1.25 | 4 | 约133ms |
| 单张素材 | 3 | 约89–95ms |

固定调整顺序不会减少负样本总工作量。审计同时确认，早期 v3 包只保存 PNG，没有记录取材时的 Surface 尺寸，因此不能安全地对所有素材删除缩放档。

V6 为新取材素材增加可选 `manifest.assetMetadata`：助手在绑定游戏 Surface 后取材时，记录参考 Surface 宽高；普通页面取材、任意区域取材和外部导入素材不会被标记为可信 Surface。运行与助手识别仅在以下条件全部成立时使用单一预测 scale：

1. Locator 没有显式设置 scales；
2. 当前识别位于一个明确的 Surface 区域内；
3. 图片组每张素材都带可信 Surface 参考尺寸；
4. 当前区域相对参考区域为近似等比缩放；
5. 图片组各素材预测值差异不超过2%，且结果位于0.25–4范围。

任一条件不成立就继续使用 `[0.75, 1, 1.25]`，所以旧素材、外部图片、非等比画面和专业作者显式配置不会被静默改变。

相同真实负样本的 A/B：

| 平台 | 三档 warm p95 | 可信单档 warm p95 | 降幅 | 结果 |
|---|---:|---:|---:|---|
| Windows x64 | 约407ms | 约127ms | 约69% | 均无误报 |
| WSL2 Linux x64 | 约383ms | 约131ms | 约66% | 均无误报 |

单档不是全局默认，也不是把容错能力交给普通用户配置；它是新素材携带可靠来源信息后由 Core 自动选择的优化。已有素材若希望获得该收益，需要在绑定游戏画面后重新取材。

## 8. V7 Electron 端到端验收（2026-08-31）

新增 `tests/electron/fixtures/automation-vision-e2e.html`，由项目锁定的 Electron 11、真实 BrowserView 和真实 OpenCV Worker 加载，不用浏览器外部截图模拟产品链路。页面提供响应式 Canvas、彩色像素靶和可见尺寸/坐标信息，也可以直接在 BaoFlashBrowser 中打开进行人工复核。

自动 smoke 覆盖以下闭环：

1. 初始 BrowserView 640×480，Canvas 为600×200；
2. 通过产品相同的逻辑 BGRA 帧归一化路径截取56×40素材；
3. 记录素材的600×200 Surface 参考尺寸，并生成两张参考一致的图片组素材；
4. BrowserView 改为790×480，Canvas 响应式变为750×250；
5. 重新通过特征码定位 Canvas，Core 为整个图片组选择唯一的1.25 scale；
6. 真实 OpenCV 命中目标，最强分数约0.9839；
7. 不带元数据的旧素材仍通过默认三档命中；
8. 同一 smoke 继续验证 CDP lease 恢复、OCR入口、Surface相对点击和窗口 resize 后坐标。

验收机 Windows 缩放为150%。Electron 直接 `capturePage(rect)` 得到84×60物理像素，而产品归一化取材得到56×40逻辑像素。测试明确断言后者，避免测试自身绕过 Capture Service 后制造假的 scale 回归。执行命令：`npm run probe:automation-authoring`。
