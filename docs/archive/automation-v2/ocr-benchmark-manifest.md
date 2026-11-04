# Automation 2.0 OCR Benchmark Manifest

> 状态：Windows与Linux评估及切换已执行。两端均使用Paddle Inference C++ BAO1 Sidecar与PP-OCRv3。

Windows x64与manylinux 2.28自包含Sidecar均已完成启动自检和内存渲染中文数字图的真实推理；这只证明管线可运行，不构成候选模型benchmark结论。OCR运行时已切换为headless OpenCV依赖，页面图片识别worker不在本轮范围内。

## 候选矩阵

| ID | Runtime | Model | 角色 |
|---|---|---|---|
| `baseline-paddle-v3` | Paddle Inference C++ Sidecar（旧对照为PaddleOCR-json） | PP-OCRv3 | 当前默认 |
| `rapid-v6-small` | RapidOCR / ONNX Runtime sidecar | PP-OCRv6 small | 已拒绝候选 |
| `rapid-v6-tiny` | RapidOCR / ONNX Runtime sidecar | PP-OCRv6 tiny | 已拒绝候选 |

候选使用同一BAO1协议和语料完成过评估，结果记录在阶段报告中。正式仓库只保留Paddle BAO1运行时、当前Provider与可复用语料生成/基准工具；被拒绝的Rapid运行时和构建源码不再维护。

## Corpus分层

| Suite | 最低样本数 | 内容 | 主要指标 |
|---|---:|---|---|
| `ui-zh` | 150 | 中文按钮、菜单、通知、混合中英 | exact、edit similarity |
| `trade-number` | 200 | 价格、数量、货币、千分位、小数、正负号 | number accuracy |
| `game-low-res` | 200 | 低分辨率/缩放/压缩/描边游戏文字 | exact、number accuracy |
| `region-noise` | 100 | 背景纹理、动画帧、透明叠层、局部ROI | false positive、p95 |
| `recovery` | 30 | timeout、进程退出、坏响应、cancel | restart、queue recovery |

每个样本记录：稳定ID、来源许可、原始尺寸、ROI、预期文本/数字、语言、缩放方式、标签。真实账号、token、用户名、聊天内容不得进入corpus。

## 运行协议

1. Windows x64、同一台机器、AC供电、固定CPU线程数。
2. 每个provider预热10次；正式样本随机顺序运行3轮。
3. 同时记录cold start、warm p50/p95/mean、峰值RSS、模型与runtime磁盘体积。
4. timeout统一30秒；hang必须kill并在下一请求重启。
5. 保存原始逐样本JSON，汇总报告不得只保留平均值。

## 替换门槛

- `trade-number` number accuracy不得低于baseline，且绝对值至少99%。
- `ui-zh` normalized edit similarity不得比baseline下降超过0.5个百分点。
- `game-low-res` exact或number accuracy至少一项显著优于baseline。
- warm p95不高于baseline；tiny若准确率达标，体积/内存优势可作为默认游戏profile依据。
- recovery suite全部通过，连续1000次请求无永久queue阻塞。

只有三候选在同一corpus上的报告经审核后，才能修改默认OCR；Pixel OCR不属于本manifest。

## 2026-08-31 Windows 阶段结果

评估工具：`npm run benchmark:ocr`。工具生成逐样本 JSON，包含中文 UI、价格数字、低分辨率游戏字和复杂背景四组语料；每个 provider 使用同一份 BGRA 像素输入。详细阶段报告见 `ocr-benchmark-results-windows.md`。

| Provider | 可控语料文本/数字准确率 | warm p50 | warm p95 | cold start | runtime |
|---|---:|---:|---:|---:|---:|
| PP-OCRv6 small / RapidOCR / ONNX Runtime（8线程） | 100% / 100% | 约585ms | 约728ms | 约751ms | 217.1MiB |
| PP-OCRv3 / PaddleOCR-json（4线程） | 100% / 100% | 约20ms | 约31ms | 约630ms | 250.4MiB |

阶段决定：Windows只保留PP-OCRv3；PP-OCRv6 small未通过warm p95门槛，tiny也未通过准确率与延迟门槛。随后C++ BAO1 Sidecar在相同PP-OCRv3模型上通过准确率、延迟、RSS与1000次稳定性门禁，正式替换旧PaddleOCR-json路径协议。Linux也已切换到Paddle C++。

Linux Paddle先以Python PoC补测相同PP-OCRv3模型，56/56文本正确，随后完成Paddle Inference C++ Sidecar。正式产物在多轮56张测试中mean约47–78ms、p95约115–187ms；1008次连续请求通过，mean 67.7ms、p95 158.8ms、峰值RSS约322MiB。自包含归档约120MiB，最高GLIBC要求2.28。Linux默认provider已经切换为Paddle。

严格同机 Linux Rapid PP-OCRv6 small 对照同样为56/56，但初始化约3444ms、mean约678ms、p95约836ms；Paddle的mean/p95分别约快17.8/15.2倍。Rapid在真实像素字上会返回更多低置信候选，但包含`a收线`、`赶走人`、`0拉托`等附加或错误字符，没有表现出可直接替代Pixel OCR的精确度优势。

PP-OCRv6 tiny补测：文本exact 96.4%、数字100%、warm p95 237.2ms；同场Paddle文本/数字均100%、warm p95 30.7ms。四张真实钓鱼像素字经人工校正真值后，tiny、small和Paddle均只准确1/4，没有候选表现出整体优势。Windows删除RapidOCR运行时的性能与准确率决策条件已经满足；恢复压力测试不再阻挡Windows删包，只用于Linux provider验收。
