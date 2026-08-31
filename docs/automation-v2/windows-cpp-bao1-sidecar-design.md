# Windows Paddle C++ BAO1 Sidecar 设计

> 状态：已通过门禁并替换生产基线
> 日期：2026-08-31
> 决策原则：先构建、同场测试，达到门槛后才删除 `PaddleOCR-json`。

## 1. 目标与非目标

目标是让Windows与Linux在OCR边界上采用相同的`BAO1 + BGRA内存帧`协议，同时保持Windows PP-OCRv3的准确率和低延迟。2026-08-31门禁通过后，Windows默认已切换为Paddle Inference C++ Sidecar。

本批不升级模型，不引入PP-OCRv6，不修改Capture/Coordinate/TextLocator语义，也不同时评估Pixel OCR。这样测试只回答一个问题：去掉BMP落盘并统一Sidecar后，是否比现有Windows实现更合适。

## 2. 已确认的基线

当前`native/ocr/win64`为PaddleOCR-json 1.4.1精简包：

- Paddle Inference 2.3.2；
- OpenCV 4.10 `opencv_world4100.dll`；
- PP-OCRv3 detector/recognizer和中文字典；
- 目录约250.42MiB；
- 每次识别把BGRA转换为BMP，写入临时目录，再向子进程发送`image_path`。

现有目录已经包含`paddle_inference.dll`、MKL、oneDNN、OpenCV和模型。正式替换应复用这些文件，只把约1MiB的`PaddleOCR-json.exe`替换为BAO1 Sidecar，不允许并排打包第二套推理库或模型。

官方Windows C++部署要求Visual Studio 2022、CMake和x64 Release构建；Paddle预编译库使用MSVC ABI，不能用MinGW混编。参考：

- https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/local_inference/cpp/OCR_windows.md
- https://www.paddlepaddle.org.cn/inference/master/guides/install/download_lib.html

## 3. 目标结构

```text
BrowserViewCaptureService
        │ BGRA Buffer + width/height
        ▼
AutomationOcrEngine
        │ BAO1 binary frame over stdin
        ▼
bao-paddle-ocr-sidecar.exe
        ├── Paddle Inference 2.3.2
        ├── OpenCV 4.10
        └── PP-OCRv3 det/rec
        │ JSON line over stdout
        ▼
OcrTextItem[] + AutomationFrameTransform
```

Windows与Linux共用以下行为：

- 同一个BAO1帧格式、64MiB像素上限和响应校验；
- stdout只允许协议JSON，所有引擎日志进入stderr且主进程持续消费；
- 单实例串行请求；
- 30秒启动/请求deadline；
- Abort时杀进程，下一请求重新启动；
- 不创建临时图片、临时目录或外部网络请求。

## 4. 候选实现策略

### 4.1 ABI与依赖

候选以PaddleOCR-json 1.4.1对应的Paddle Inference 2.3.2构建资源为准，避免拿Linux 2.6.2头文件链接Windows 2.3.2 DLL。构建输入必须固定URL、版本和SHA256。

优先复用现有发行包的DLL和模型；编译时需要的头文件与`.lib`只保留在`.cache/ocr-paddle-win-cpp`，不进入最终安装包。OpenCV编译输入必须与`opencv_world4100.dll`的MSVC ABI一致。

### 4.2 源码复用

复用经过固定提交审核的PaddleOCR/PaddleOCR-json detector、recognizer、预处理和后处理代码。Sidecar只新增：

- BAO1读取和长度校验；
- BGRA到BGR转换；
- UTF-8 JSON序列化；
- stdout/stderr隔离；
- 常驻进程循环和错误边界。

不得把Linux ELF、Python、ONNX Runtime、RapidOCR或第二套模型带进Windows候选。

### 4.3 候选隔离

候选先输出到`.cache/ocr/windows-cpp-candidate`，Provider通过测试专用命令显式启动。构建、测试和失败均不得覆盖`native/ocr/win64`。只有ADR记录“通过”后，才修改`prepare-ocr-runtime.cjs`和Electron Builder。

## 5. 测试矩阵

基线与候选在同一台Windows机器、相同4线程、相同BGRA像素和随机顺序下各运行3轮；前10张作为预热，不计入warm统计。

| 维度 | 测试 |
|---|---|
| 准确率 | 56张可控语料；中文、数字、低分辨率和噪声分层 |
| 真实素材 | 钓鱼素材“收线/上钩/拉杆/赶走”及完整截图 |
| 延迟 | cold start、warm mean/p50/p95、引擎时间、协议时间 |
| 稳定性 | 1000次连续请求、空结果、坏帧、进程退出 |
| 生命周期 | timeout、Abort、close、杀进程后下一请求恢复 |
| 资源 | 峰值RSS、runtime目录、最终安装包增量 |
| 文件系统 | OCR前后检查，不得生成`bao-ocr-*`临时目录或BMP |

## 6. 替换门槛

候选只有同时满足以下条件才替换：

1. 可控语料文本和数字结果不低于基线，不能靠降低阈值增加误报；
2. 真实素材结果至少与基线一致；
3. warm p95不超过`max(基线×1.15, 基线+5ms)`；
4. cold start不超过基线15%；
5. 峰值RSS不超过基线10%；
6. 1000次请求、取消、超时和崩溃恢复全部通过；
7. 最终OCR目录不增加第二套runtime，体积增量不超过5MiB；
8. Windows 7兼容边界不因新EXE或VC Runtime被无意提高。

如果准确率相同且延迟落在15%以内，可凭“无落盘、跨平台协议统一、维护一套生命周期”判定替换；超过该范围则保留PaddleOCR-json，并记录候选失败数据。

## 7. 替换后的清理

通过后一次性执行：

- Windows Provider改为BAO1 Sidecar；
- 删除`bitmapToBmp`、临时目录写入和旧JSON path协议；
- 删除`PaddleOCR-json.exe`，保留其仍需遵守的上游许可证和来源记录；
- Windows/Linux共用通用`BaoOcrSidecarEngine`，名称和错误信息不再带Rapid；
- 更新发布校验，禁止Windows OCR包重新出现旧EXE或临时BMP实现。

未通过则不做上述清理，也不保留永久双实现到正式安装包。

## 8. 执行结果

使用Visual Studio 2022 Build Tools、CMake与Ninja完成x64 Release构建。Sidecar复用PaddleOCR-json 1.4.1的C++推理源码、Paddle Inference 2.3.2和现有PP-OCRv3模型；预编译EXE的SHA-256固定为`b79b17e29515397ee37b52549d87d0d98ae8862777696b4d583e0d4b2ad9b8a7`。

| 门禁 | 旧PaddleOCR-json | C++ BAO1 | 结果 |
|---|---:|---:|---|
| 56张文字/数字准确率 | 100% / 100% | 100% / 100% | PASS |
| warm mean | 24.8ms | 17.6ms | PASS，-29% |
| warm p95 | 35.1ms | 27.8ms | PASS，-21% |
| 正常cold start | 583ms | 565ms | PASS |
| 峰值RSS | 233.9MiB | 234.0MiB | PASS |
| 真实钓鱼素材 | 基准输出 | 14/14完全一致 | PASS |
| 连续请求 | 未在本批重跑 | 1000/1000 | PASS |
| close/强杀/重启 | 基准 | 全部通过 | PASS |

新EXE首次复制到陌生路径时可能被Windows Defender扫描一次，本机首次启动约2.4秒；同一路径后续恢复到约0.58秒，仍远低于30秒启动deadline。这属于签名/扫描的一次性部署成本，不计入热态推理，但在发布验收中保留记录。

PE检查结果为x64 CUI、OS/subsystem 6.0，仅直接依赖`paddle_inference.dll`、`opencv_world4100.dll`和`KERNEL32.dll`。正式运行时删除旧`PaddleOCR-json.exe`，未增加第二套DLL或模型，目录体积反而约减少0.43MiB。
