# Automation 2.0 OCR 跨平台方案

> 状态：已完成
> 日期：2026-08-31
> 范围：Windows x64、Linux x64；macOS 仅保留接口与构建位，不承诺本轮发布质量。

## 1. 结论

Automation Core 只依赖 `AutomationOcrEngine`，不依赖 PaddleOCR、RapidOCR、Python 或某个平台。默认选择策略为：

1. Windows x64 使用 `Paddle Inference C++ 2.3.2 + PP-OCRv3` BAO1 Sidecar，不再落盘BMP，也不打包或回退到RapidOCR；
2. Linux x64 使用随安装包分发的 `Paddle Inference C++ + PP-OCRv3` Sidecar，不打包或回退到RapidOCR；
3. 两者都不存在时，给普通用户显示“当前安装包不包含 OCR”，不要求用户安装 Python、模型或系统库；
4. `PP-OCRv6 tiny` 只进入相同协议和 benchmark，不在没有数据时直接设为默认。

2026-08-31 补充：Windows和Linux均已完成Paddle Inference C++自包含Sidecar与BAO1内存协议。Windows通过56张语料、真实素材和1000次稳定性门禁；Linux通过manylinux 2.28构建、发布校验与1008次连续请求。默认策略统一为Paddle；Rapid候选未通过门禁，其运行时代码、构建入口和缓存产物已删除，仅保留评估结论。

RapidOCR 官方文档说明 PP-OCRv6 的 ONNX Runtime 支持从 `rapidocr>=3.9.0` 开始，`small` 是默认模型量级；因此不能使用最初考虑的 3.8.x 版本冒充 PP-OCRv6。构建锁定当前已发布的 `rapidocr==3.9.2`，并显式选择 `PP-OCRv6/small/onnxruntime`。参考：

- https://rapidai.github.io/RapidOCRDocs/main/install_usage/rapidocr/parameters/
- https://rapidai.github.io/RapidOCRDocs/main/model_list/
- https://github.com/RapidAI/RapidOCR

## 2. 为什么采用独立 Sidecar

Electron 11 固定在 Node 12/Chromium 87，直接在主进程加载 `onnxruntime-node` 会同时受 Node ABI、Electron ABI、原生动态库搜索路径和崩溃隔离影响。独立进程有以下边界：

- OCR 崩溃或卡死不会带崩 Electron 主进程；
- Windows 与 Linux 各自构建自包含目录，应用层协议完全一致；
- 超时或取消时可以杀掉 Sidecar，下一次请求自动重启；
- 原始 BGRA 帧通过 stdin 传输，不再为每次 OCR 写临时 BMP；
- 日后替换为 C++/Rust Sidecar 时，Automation Core 无需变化。

Sidecar 使用“目录式自包含发行”而非要求用户安装 Python。构建机使用 Python/PyInstaller 只是发布过程，最终用户只看到 BaoFlashBrowser 安装包。

## 3. 进程协议

协议版本为 `bao-ocr/1`，同一进程串行处理请求。

主进程写入：

```text
4 bytes  magic = BAO1
4 bytes  little-endian JSON header length
4 bytes  little-endian bitmap length
N bytes  UTF-8 JSON header
M bytes  top-to-bottom BGRA bitmap
```

请求头包含 `id`、`width`、`height`、`format=bgra`。Sidecar stdout 只允许逐行 JSON：

```json
{"type":"ready","protocol":1,"provider":"paddle-inference","model":"PP-OCRv3"}
{"type":"result","id":1,"items":[{"text":"购买","score":0.98,"box":[[1,2],[30,2],[30,18],[1,18]]}],"timings":{"ocrMs":12}}
```

诊断信息只写 stderr。主进程限制 header、像素长度、尺寸和响应结构，坏响应、超时、退出和取消都会终止当前子进程，避免队列永久卡死。

## 4. Provider 生命周期

```text
AutomationTextRecognitionService
              │
       AutomationOcrEngine
              │
       createAutomationOcrEngine
              │
   Bao1OcrSidecarEngine
 Windows/Linux Paddle Inference
```

Provider 必须支持：`recognize(frame, signal)`、`close()`、单实例串行化、30 秒 deadline、取消、崩溃后重启。工作流会话拥有自己创建的 provider；工作台测试中心复用一个 authoring provider，关闭服务时统一释放。

## 5. 发布布局

```text
resources/native/ocr/
├── paddle/                        # 仅Linux
│   ├── bao-paddle-ocr-sidecar
│   ├── lib/                       # Paddle/OpenCV/MKL动态库
│   ├── models/                    # PP-OCRv3 det/rec
│   ├── OCR-RUNTIME.json
│   └── LICENSE-PaddleOCR
├── bao-paddle-ocr-sidecar.exe     # 仅Windows
├── *.dll                          # Windows Paddle/OpenCV/MKL
└── models/                        # Windows PP-OCRv3 det/rec/cls
```

Windows与Linux OCR版都只携带各自平台的Paddle Inference C++ Sidecar和同一PP-OCRv3模型族。标准版不携带OCR runtime。构建阶段检查可执行文件、模型、manifest和许可证，运行时绝不联网下载。

## 6. 模型与性能策略

- v6 small：跨平台 OCR 版的首选候选；中文、英文、数字统一路径。
- v6 tiny：使用同一个 Sidecar，通过独立 runtime 目录进入 benchmark。
- v3 baseline：Windows/Linux当前默认；Windows旧路径协议实现已在BAO1候选通过后删除。
- 捕获仍由 `CaptureService` 完成；OCR 只接收已裁剪的 ROI 帧，不自行理解“页面/游戏”。
- Sidecar 常驻、固定 CPU 线程数，避免每步重复加载模型。

切换默认的量化门槛继续沿用 `ocr-benchmark-manifest.md`：数字准确率、低分辨率游戏文本、warm p95、RSS、安装体积、取消/崩溃恢复必须同场比较。没有报告时不宣称 v6 一定优于 v3。

## 7. 跨平台构建

Sidecar 必须在目标系统原生构建，不能在 Windows 交叉打出 Linux 可执行文件：

- Windows x64：Visual Studio 2022 + Paddle Inference 2.3.2 C++，预编译Sidecar由SHA-256锁定；
- Linux x64：manylinux_2_28基线容器 + Paddle Inference C++ 2.6.2 + PaddleOCR release/2.7；
- CI 构建后运行协议自检，再由 Electron Builder 复制当前平台目录；
- `verify-release` 校验可执行文件架构、manifest、模型文件、许可证，并拒绝把 Windows DLL/EXE 放入 Linux 包。

仓库提供可复现源码、锁定依赖与构建脚本。Linux使用官方PaddleOCR release/2.7源码和SHA256锁定的Paddle Inference 2.6.2 CPU/MKL库构建，产物安装到被gitignore的`native/ocr/paddle/linux-x64`，不提交二进制。

Linux “原生构建”不等于“可在所有 Linux 发布”。`verify-release` 会扫描 Sidecar 目录内所有 ELF 的 `GLIBC_*` 需求并强制最高不超过 2.28。使用更新发行版直接冻结只适合功能诊断；正式构建必须使用 manylinux_2_28 或等价基线容器。

仓库内`tools/ocr-paddle-cpp/Dockerfile.manylinux`、`build_manylinux.sh`和`build/install-paddle-linux-runtime.cjs`组成发布链：容器内编译、收集动态库和模型、生成归档，再经路径安全检查安装。Sidecar直接接收BGRA，不依赖Python或临时图片。

## 8. 验收

1. 协议测试覆盖正常结果、空结果、坏响应、超时、取消、进程退出和下一请求恢复；
2. Windows：只允许Paddle provider，成品中出现Rapid目录即发布失败；
3. Linux：OCR 包不依赖系统 Python，断网可识别；
4. 识别请求不创建临时图片文件；
5. 连续 1000 次请求无队列死锁，进程RSS和warm p95被benchmark记录；（当前已通过1008次）
6. 标准包内不得出现 OCR runtime，OCR 包不得混入其他平台二进制。

## 9. 本轮实测记录

- Windows x64 Sidecar 启动自检：通过；
- BGRA 内存协议 + PP-OCRv6 small 实际推理：通过，渲染文本 `TEST 123` 返回含 `123` 的结果；
- Windows OCR 源资源发布校验：22 个关键文件通过；
- 历史Windows Rapid冻结目录约259MB，与PaddleOCR-json runtime（约263MB）处于同一量级；small/tiny评估失败后，Windows已停止打包Rapid，避免双runtime体积；
- WSL2 Ubuntu 26.04 x64 的首次诊断产物约355MB、最高依赖 `GLIBC_2.43`，被新增的 `GLIBC_2.28` 发布门禁正确拒绝；
- manylinux_2_28 + Python 3.11.13重新冻结后的目录约354MB，全目录最高要求恰为 `GLIBC_2.28`，Linux OCR源资源校验19项通过；
- 兼容产物分别在 glibc 2.28容器和WSL Ubuntu 26.04中实际识别“开始游戏”与“123”，单次冷启动推理约864ms/1024ms；
- OCR构建以`opencv-python-headless==5.0.0.93`替换RapidOCR传递引入的完整OpenCV，并排除Windows FFmpeg视频DLL；Linux解压目录由353.1MB降至309.1MB、归档由146.8MB降至131.0MB，Windows目录由247.0MB降至217.1MB；
- 第一轮 56 张可控语料、3 轮横向 benchmark：small 与 baseline 准确率均为 100%，small warm p95 约728ms、baseline约31ms；Windows 因此切回 Paddle 优先。真实游戏 corpus 与 tiny 仍待完成。

### Linux Paddle PP-OCRv3 可行性验证（2026-08-31）

验证使用 `python:3.11-slim-bookworm` 容器、`paddlepaddle==2.6.2`、`paddleocr==2.7.3`，直接挂载并加载 Windows baseline 使用的三套模型和字典，不下载第二份模型：

- `ch_PP-OCRv3_det_infer`
- `ch_PP-OCRv3_rec_infer`
- `ch_ppocr_mobile_v2.0_cls_infer`
- `dict_chinese.txt`

容器以只读工作区、禁用网络、移除 capabilities 的方式运行。旧 Paddle 2.6.2 Linux wheel 会污染 zlib 符号，导致后加载的 pyclipper 崩溃；探针通过在 Paddle 前预加载 pyclipper规避，只用于确认模型和推理性能。正式产物不得依赖该 Python 导入顺序，继续采用 Paddle Inference C++ 独立 Sidecar。

```text
3 张中文快速样本                  PASS（开始游戏 / 购买 / 出售）
56 张可控语料                    PASS，56/56 文本正确
模型初始化                       约 486ms
热态单张均值 / p50 / p95         约 38ms / 38ms / 55ms
真实像素字                       识别“赶走”；“收线、拉杆”未检出
PoC Docker image                 约 607MB（不是发布产物）
```

真实像素字结果与Windows baseline一致：通用PP-OCRv3对极小像素字体召回不足，需要后续Pixel OCR或模板识别，不属于Linux平台回归。

同一 Docker Linux 引擎、同一批 56 张图片、同一 BGRA 内存输入的 Rapid PP-OCRv6 small 对照结果如下。两者均为单进程常驻、逐张串行识别；Paddle 使用4线程，Rapid 使用当前产品默认8线程。

| Linux provider | 文本结果 | 启动 | mean | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| Paddle PP-OCRv3 Python PoC | 56/56 | 486ms | 38ms | 38ms | 55ms |
| Rapid PP-OCRv6 small发布Sidecar | 56/56 | 3444ms | 678ms | 673ms | 836ms |

同机数据中，Paddle mean约快17.8倍、p50约快17.6倍、p95约快15.2倍，启动约快7.1倍。真实钓鱼像素字上，Rapid倾向低阈值多猜，出现`a收线`、`赶走人`、`0拉托`；Paddle更保守，正确返回“赶走”但漏掉“收线、拉杆”。Rapid的额外召回没有形成稳定精确文本，不能抵消延迟差距。

### Linux Paddle C++正式产物（2026-08-31）

| 项目 | 结果 |
|---|---:|
| 56张可控语料 | 56/56文本正确 |
| 原生容器启动 | 约350–390ms |
| 4/8线程多轮mean | 约47–78ms |
| 多轮p95 | 约115–187ms |
| 1008次连续请求 | PASS，mean 67.7ms，p95 158.8ms |
| 峰值RSS | 约322MiB |
| 解压目录 / gzip归档 | 约404MiB / 120MiB |
| GLIBC上限 | 2.28，发布门禁PASS |

从Windows DrvFS只读挂载运行时，模型初始化约2.4秒；复制到容器原生文件系统后约0.35秒。该差异属于WSL挂载文件系统开销，不代表Linux AppImage内的正常启动时间。
