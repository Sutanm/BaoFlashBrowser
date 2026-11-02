# Tesseract x86 与 Paddle 效果验证

日期：2026-11-02。结论：Tesseract x86 可运行，适合继续研究为清晰数字/普通文字的备用引擎；本轮结果不足以支持把它作为 Win32 上与 Paddle 等效的 OCR 功能直接发布。未接入主程序，现有安装包不变。

## 环境与方法

- 同一台 Windows x64 主机。Tesseract 是真实 x86 进程，worker 的 `IntPtr.Size=4`；未测试真实 32 位 Windows 系统。
- 最终对比使用 UB Mannheim `v5.3.0.20221222` x86 原生 DLL，经 Chocolatey 归档取得安装程序；SHA-256 为 `33D7824A440E1660B74DC55F10355B346A22FDBE430143F7F6885CFA3CFDF7E7`，与该包的校验说明一致。程序只解压到 `.cache`，没有运行安装器。
- 模型为 `tesseract-ocr/tessdata_fast` 的 `chi_sim+eng`，固定提交 `87416418657359cb625c412a48b6e1d6d41c29bd`。CDN 下载结果按 Git blob SHA-1 与仓库树交叉验证：中文 `388bac276d033d06e5ed5ba7a7ad14ae58f97dab`，英文 `bbef4675053b5b468cdb477053e28b1c698ba08e`。
- Paddle 使用项目现有 Windows Paddle Inference / PP-OCRv3 BAO1 sidecar。
- 两者都常驻进程、加载模型后预热 5 次；61 张图片各测 3 轮，正反顺序交替。最终整轮对比统一设置 `OMP_THREAD_LIMIT=1`。耗时不含冷启动、离线预处理和 RSS 采样；Tesseract 路径包含 PNG 读取/解码，Paddle 输入为预解码 BGRA，因此不是严格的纯推理耗时对比。
- 56 张既有合成图：20 个中文按钮、20 个交易数字、10 个低分辨率样本、6 个背景干扰样本；另加 4 张人工转写的钓鱼素材和 1 张无文字图标负样本。
- Tesseract 测试 PSM 6（文本块）、7（单行）、11（稀疏文字）；并对 PSM 6/7 补测最近邻放大 3 倍加白边、灰度归一化/反色/二值化/小图放大。共 7 组配置。
- 只比较文字内容和数字提取，未实现 Tesseract 的坐标、置信度、主程序适配或发布集成。

## 结果

以下计数按独立图片计，3 次重复结果一致；中文使用去空白后整串完全匹配，数字按首个数字值匹配。Tesseract 两列是固定配置，不是逐图选最优。

| 指标 | Paddle | Tesseract PSM 6 原图 | Tesseract PSM 7 原图 |
| --- | ---: | ---: | ---: |
| 普通中文按钮（20 张） | 20/20 | 18/20 | 13/20 |
| 清晰交易数字（20 张） | 20/20 | 20/20 | 20/20 |
| 低分辨率中文（5 张） | 5/5 | 0/5 | 2/5 |
| 背景干扰中文（3 张） | 3/3 | 0/3 | 2/3 |
| 全部数字样本（28 张） | 28/28 | 24/28 | 25/28 |
| 真实有文字素材（4 张） | 1/4 | 0/4 | 0/4 |
| 无文字图标（1 张）正确返回空白 | 1/1 | 0/1 | 0/1 |
| 全体样本热态平均耗时 | 12.5 ms | 15.5 ms | 14.7 ms |
| 全体样本 P95 耗时 | 20.9 ms | 37.8 ms | 50.2 ms |
| 采样进程峰值 RSS | 约 410 MiB | 约 75 MiB | 约 75 MiB |

PSM 11 的普通中文按钮为 18/20，全部数字为 22/28；真实素材仅无文字图标正确，4 张文字素材仍未完全匹配。放大/二值化两类预处理均未提高本批图片的整体准确率，部分明显退化。这不代表其他预处理或较大模型一定无效。

真实素材的逐图表现：

| 素材 | 人工转写 | Paddle | Tesseract 观察 |
| --- | --- | --- | --- |
| `拉杆.png` | 拉杆 | 控 | 误读为英文字母或返回空白 |
| `收线.png` | 收线 | 空白 | 误读或返回空白 |
| `test2.png` | 收线 | 空白 | 误读或返回空白 |
| `test.png` | 转身 / 技能 / 钓鱼 / 复制昵称 / 职业 | 全部正确 | PSM 11 能读出这些词，但混入额外符号；单行模式不适合此菜单 |

真实样本非常少；前三张是图标与像素描边文字混在一起的小素材，不能据此推导所有游戏的识别率。完全匹配指标也比“找到某个按钮词”更严格，逐图原文保存在 JSON 中。

## 体积与接入判断

原始 Tesseract 安装器展开约 260 MiB，包含训练工具、文档、其他文件和大量调试信息，不能作为最终集成体积。另行复制 worker 的原生依赖闭包（27 个 DLL）、去除调试信息并保留中英文 fast 模型，验证目录约 **24.1 MiB**；该目录复测成功识别“开始游戏”和“1,280”。这只是依赖精简验证，不是已完成的可分发 OCR 安装包。

最初也测试过 Charles Weld NuGet 5.2.0 包内的原生库；它实际报告 Tesseract 5.0.0。其结果另存 `results-tesseract50.json`，未与上表的 5.3.0 结果混用。

建议：本轮不自动修改 Win32 发布能力。如果后续决定接入，先限定清晰数字/普通中文作为备用能力，再补充更多目标游戏截图和真实 32 位系统验证；不要承诺与 Win64 Paddle 等效。若只为识别固定像素按钮，现有图像匹配也值得优先评估。

## 复现与产物

- 驱动：`tools/ocr-benchmark/tesseract-x86-worker.cs`，用 .NET Framework C# 编译器 `/platform:x86 /define:TESSERACT53` 编译，输出 `ocr-worker.exe`；与 5.3.0 DLL 放在同一目录。
- 该目录下放置 `tessdata-fast/chi_sim.traineddata` 与 `eng.traineddata`。
- 运行：设置 `BAO_TESSERACT_RUNTIME_DIR`、`OMP_THREAD_LIMIT=1`，执行 `node tools/ocr-benchmark/compare-tesseract.cjs`。
- 原始结果：`.cache/ocr-benchmark/tesseract-comparison/results.json`，包含全部配置、轮次、耗时、实际文字及错误。
- 运行前需存在合成图目录和可选的真实素材目录。缺少真实素材时脚本会跳过，对比报告的样本数将不同。

发行来源：[UB Mannheim 存档](https://digi.bib.uni-mannheim.de/tesseract/)、[Chocolatey 对应归档](https://community.chocolatey.org/packages/tesseract-ocr/5.3.0.20221222)、[官方 fast 模型库](https://github.com/tesseract-ocr/tessdata_fast)。
