# Paddle C++ BAO1 Sidecar

Windows与Linux共用的Paddle Inference OCR进程源码。stdin接收`BAO1`头和BGRA内存帧，stdout只输出逐行JSON协议；Paddle/OpenCV日志必须留在stderr。

## Windows发布输入

- Visual Studio 2022 Build Tools x64、CMake、Ninja；不得使用MinGW；
- PaddleOCR-json `release/1.4.1` C++源码归档SHA-256：`b42b384097fd03d9a239ec09df31192b7317cb24229e714515bf8230bc2c14ae`；
- Paddle Inference 2.3.2 Windows x64 AVX MKL归档SHA-256：`01eb6e18067deba3ff5b6bbcc6c081a9b3361c2873ce327ccddca95bd61e5557`；
- 正式`paddle_inference.dll` SHA-256：`8b668ecd448de98e20c3315acf942c9d6039dd213494a34507754e8b08b9a01f`；
- 正式`opencv_world4100.dll` SHA-256：`e6e31e55b9b377b775782c4b27a80b2460dffe3dbee7898e034d25729dca0198`。

在Visual Studio Developer PowerShell中调用`build_windows.ps1`并传入上述开发包、OpenCV源码头文件和与正式DLL匹配的import library。设计与门禁见`docs/automation-v2/windows-cpp-bao1-sidecar-design.md`。构建完成后必须运行：

```powershell
npm run benchmark:ocr:corpus
node tools/ocr-benchmark/windows-cpp-gate.cjs .cache/ocr-benchmark/corpus
```

通过门禁的Windows预编译EXE位于`prebuilt/win32-x64`，SHA-256为`b79b17e29515397ee37b52549d87d0d98ae8862777696b4d583e0d4b2ad9b8a7`。`build/prepare-ocr-runtime.cjs`会验证该值，再与官方运行库和模型组装OCR发行目录。
