# Automation 2.0 OCR Benchmark Manifest

> 状态：Harness Ready；候选模型对比尚未执行；当前默认仍为 PaddleOCR-json + PP-OCRv3。

## 候选矩阵

| ID | Runtime | Model | 角色 |
|---|---|---|---|
| `baseline-paddle-v3` | PaddleOCR-json sidecar | PP-OCRv3 | 稳定基线 |
| `rapid-v6-small` | RapidOCR / ONNX Runtime sidecar | PP-OCRv6 small | 默认候选 |
| `rapid-v6-tiny` | RapidOCR / ONNX Runtime sidecar | PP-OCRv6 tiny | 游戏自动化候选 |

候选Sidecar和v6模型尚未进入仓库，因此本阶段不伪造比较结果、不下载未审计二进制，也不切换默认provider。接入候选时必须实现同一个`TextRecognizer`合同，并通过`ocr-benchmark.ts`运行以下manifest。

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
