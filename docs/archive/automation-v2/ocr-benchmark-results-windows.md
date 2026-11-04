# OCR Provider Windows 阶段评估

> 日期：2026-08-31
> 平台：Windows x64
> 结论级别：已完成；PP-OCRv6被拒绝，PP-OCRv3保留并切换为C++ BAO1内存协议。

## 结论

Windows保留`PP-OCRv3`模型，但运行载体已从`PaddleOCR-json + 临时BMP`替换为`Paddle Inference C++ + BAO1 BGRA内存帧`。`RapidOCR + ONNX Runtime + PP-OCRv6 small/tiny`未通过准确率/延迟门槛。

RapidOCR small曾用于验证Linux OCR可用性。PP-OCRv6 tiny随后使用同一语料完成评估，速度虽明显优于small，但准确率下降且仍显著慢于Paddle；四张真实钓鱼像素字也没有优势。Windows和Linux最终均采用Paddle BAO1，RapidOCR运行时与Provider回退已经删除。

## 方法

- 语料：56 张；中文 UI 20、价格数字 20、低分辨率游戏字 10、复杂背景 6。
- 输入：两套 provider 使用相同 BGRA 像素；Rapid 走内存协议，Paddle 因自身协议限制写临时 BMP。
- 预热：5 次。
- 正式轮次：3 轮，共 168 次/provider。
- 线程扫描：Rapid 分别测试 1、4、8、16 线程，正式结果采用最佳的 8 线程；Paddle 使用产品配置的 4 线程。
- 原始结果：`.cache/ocr-benchmark/result-2026-08-31T03-14-47-104Z.json`，该目录不提交 Git。

## 结果

| 指标 | Rapid v6 small | Paddle v3 |
|---|---:|---:|
| 文本 exact accuracy | 100% | 100% |
| normalized edit similarity | 100% | 100% |
| number accuracy | 100% | 100% |
| warm p95 | 727.6ms | 30.7ms |
| cold start（正式轮次） | 750.7ms | 629.9ms |
| runtime 原始体积 | 217.1MiB | 250.4MiB |
| 请求失败 | 0 | 0 |

Rapid 的线程扫描 p95：1线程 2538ms、4线程 881ms、8线程 724ms、16线程 799ms。由此可以排除“默认线程数选错是全部性能差距来源”：调整线程能改善 Rapid，但无法接近 Paddle 的 warm 延迟。

## PP-OCRv6 tiny 补充结果

tiny官方模型经RapidOCR 3.9.2清单中的SHA-256校验：检测1.74MiB、识别4.28MiB，模型合计约6MiB。相同56张语料、5次预热、3轮结果：

| 指标 | Rapid v6 tiny | Rapid v6 small | Paddle v3 |
|---|---:|---:|---:|
| 文本 exact accuracy | 96.4% | 100% | 100% |
| number accuracy | 100% | 100% | 100% |
| warm p50 | 191.8ms | 584.9ms | 19.6ms |
| warm p95 | 237.2ms | 727.6ms | 30.7ms |
| cold start | 675.6ms | 750.7ms | 629.9ms |

tiny将`下一步`稳定误识别为`下生`。四张真实钓鱼像素字不能直接用文件名充当文字真值；其中`上钩.png`图内文字实际是“赶走”，tiny与small在该图识别正确。按人工修正后的真值，tiny、small和Paddle均只准确识别1/4，tiny没有显示整体优势。因此tiny仍未通过文本准确率与warm p95门槛。

## C++ BAO1替换结果

同一56张语料、10次预热、3轮正式测试：

| 指标 | 旧PaddleOCR-json | C++ BAO1 |
|---|---:|---:|
| 文本/数字准确率 | 100% / 100% | 100% / 100% |
| warm mean | 24.8ms | 17.6ms |
| warm p50 | 25.0ms | 15.5ms |
| warm p95 | 35.1ms | 27.8ms |
| 正常cold start | 583ms | 565ms |
| 峰值RSS | 233.9MiB | 234.0MiB |

钓鱼素材14张的返回文本与排序14/14完全一致；C++ Sidecar连续1000次请求0失败，正常关闭、请求中强杀和重新启动均通过。旧EXE已从发布运行时删除。

## 后续独立工作

1. 从实际 Flash/Ruffle 游戏采集并人工标注至少 200 个低分辨率、描边、半透明和动态背景 ROI。
2. 加入跑商价格的 `ReadNumber` 数据，单独统计符号、小数点、千分位和误报。
3. 扩充真实动态游戏语料；当前协议、稳定性、RSS与WSL/Linux比较已完成。

## 最终保留规则

- tiny已明显更慢且准确率下降，Windows应只打包Paddle，Linux暂用Rapid；不为“统一技术栈”牺牲用户体验。
- 若 Rapid 在真实低清游戏文字上显著胜出，可保留为按 profile 选择的识别器，但不能让普通用户手动理解和选择底层引擎。
