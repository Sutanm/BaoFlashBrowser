# 2026-11-20 · Chromium 142 / Electron 39 「空载编译」打通报告

> 目的：回答「142 这颗内核在本机到底能不能编出来」——这是升级 142 的**唯一硬门槛**，比 PPAPI 接线更早决定成败。
> 环境：Chromium `142.0.7444.52`（`7efca501`）/ Electron `v39.0.0` / VS2022 `C:\BuildTools` MSVC 14.44 / clang `llvmorg-22-init-8940` / Python 3.11 / sccache 0.19.0 / `-j 8`
> 树：`D:\electron-build-142\cr`（独立于已交付的 140 基线 `D:\electron-build-140`）
> 方法：**不带任何 PPAPI 代码**做一次完整 `gn gen` + `ninja electron`，只验收「能否产出并启动 electron.exe」
> 结论：**通过**。见 §一。

---

## 一、结论

```
[1358/1358] LINK electron.exe electron.exe.pdb        exit code 0
electron.exe   300.3 MB   17:12:21
```

启动验证（真实进程，非静态检查）：

| 键 | 值 |
| --- | --- |
| `process.versions.electron` | **39.0.0** |
| `process.versions.chrome` | **142.0.7444.52** |
| `process.versions.node` | 22.20.0 |
| `process.versions.v8` | 14.2.231.14-electron.0 |
| `process.versions.modules` | 140 |
| `app.whenReady()` | **true** |
| 退出码 / 耗时 | 0 / 0.4 s，stderr 空 |

验收脚本 `D:\electron-build-142\probe\main.js` 只做 `app.whenReady()` 后打印版本并 `app.quit()`，不建窗口。`appReady=true` 说明 **Chromium 142 的进程模型、线程初始化、资源加载全部可用**，不是只把版本字符串编进去了。

构建统计：

| 项 | 值 |
| --- | --- |
| `gn gen` | 28,193 个 target / 4,313 个 gn 文件 / **18.1 s** |
| 最终成功那次构建 | 12:03:09 → 17:12:30 = **5 h 09 min** |
| 编译次数（sccache 统计） | **36,882**，失败 **0** |
| 产物体积 | `out/Testing` 16.2 GB / 116,368 文件；`electron.exe` 300.3 MB；`electron.exe.pdb` 1.98 GB |
| D 盘剩余 | 85.1 GB |

---

## 二、时间线：7 次构建，6 次失败全部来自「环境缺口」

| # | 起 | 止 | 步数 | 失败点 | 缺口类别 |
| --- | --- | --- | --- | --- | --- |
| 1 | 11:19:23 | 11:19:35（12 s） | — | `esbuild.exe` missing and no known rule | cipd 包 |
| 2 | 11:22:06 | 11:22:19（13 s） | — | `electron/node_modules/@primer/octicons/build/build.css` | yarn 依赖 |
| 3 | 11:29:11 | 11:38:41（9.5 min） | 3,747 / 44,994 | `FileNotFoundError: gpu/webgpu/DAWN_VERSION` | gclient hook 生成物 |
| 4 | 11:44:26 | 12:01:31（17 min） | 4,796 / 41,248 | `[WinError 2]` 调 `rc.exe` | gclient hook 下载物 |
| 5 | 12:03:09 | 16:39:39（**4 h 36 min**） | 31,887 / 36,453 | `npm run pre-flight` 依赖版本不匹配 | node_modules 版本 |
| 6 | 16:40:58 | 16:59:21（18 min） | 3,210 / 4,567 | `generate_config_gypi.py` 找不到 `gn.bat` | PATH |
| 7 | 17:00:04 | 17:12:30（12.5 min） | **1,358 / 1,358** | — | **成功** |

关键观察：**没有一次失败是 Chromium 142 代码本身的问题**。六次全是我们「为了绕开被墙的 cipd 而跳过 `gclient sync/runhooks` 的一部分」所留下的欠账，逐个显形。

---

## 三、环境缺口清单（7 项，**可复现清单**）

### 3.1 cipd 全域不可用 → 用 140 树替代

`chrome-infra-packages.appspot.com:443` 直连不通（`storage.googleapis.com` 通），而 **cipd 没有超时机制**：`.cipd_client` 13 分钟只消耗 0.19 s CPU，纯等重试，理论上无限挂起。

| 缺少的 cipd 包 | 处置 | 版本是否一致 |
| --- | --- | --- |
| `infra/3pp/tools/ninja` → `third_party/ninja/ninja.exe` | 从 140 树拷 | ✅ **pin 完全相同** `version:3@1.12.1.chromium.4` |
| `gn/gn/windows-amd64` → `buildtools/win/gn.exe` | 从 140 树拷 | ⚠️ 140 是 `3a4f5cea`(gn 2265)，142 要 `81b24e01`；实测**可用** |
| `infra/3pp/tools/7z/windows-amd64` → `third_party/lzma_sdk/bin/win64` | 从 140 树拷 | ⚠️ 140 是 24.09，142 要 25.01；只影响打包脚本 |
| `infra/3pp/tools/esbuild` → `third_party/devtools-frontend/src/third_party/esbuild/esbuild.exe` | 从 140 树拷 | ✅ **pin 相同** `0.25.1` |

其余 cipd 包（`tools/luci-go`、`third_party/siso`、`third_party/updater/*`、`enterprise_companion`、`screen-ai`、`apache-windows-arm64`、`tools/skia_goldctl`、`dawn/tools/golang`、`components/variations/test_data/cipd`、`content/test/data/gpu/meet_effects_videos`）**本地编译用不到**，全图扫描确认它们不在 `electron` 目标的依赖链上。

### 3.2 electron 的 node_modules

`src/electron` 从未 `yarn install`。两步解决：

1. `robocopy` 从 140 树拷 54,094 个文件 / 328 MB / 26 s —— 先让构建能读到 `@primer/octicons/build/build.css` 这类静态输入；
2. 跑构建后被 `npm run pre-flight`（electron 的依赖自检）拦住，8 个包版本对不上（140 带的是 electron v38 的版本）：

| 包 | 拷来 | v39 要求 |
| --- | --- | --- |
| `@azure/storage-blob` | 12.25.0 | ^12.28.0 |
| `@electron/lint-roller` | 3.1.1 | ^3.1.2 |
| `@octokit/rest` | 20.1.1 | ^20.1.2 |
| `@types/stream-json` | 1.7.7 | ^1.7.8 |
| `@xmldom/xmldom` | **缺失** | — |
| `folder-hash` | 2.1.2 | ^4.1.1 |
| `remark-preset-lint-markdown-style-guide` | 4.0.0 | ^6.0.1 |
| `stream-json` | 1.8.0 | ^1.9.1 |

`npm install --no-save --ignore-scripts --no-audit --no-fund --legacy-peer-deps` 装这 8 个，**26 秒**完成（registry 走 `registry.npmmirror.com`），`npm run pre-flight` 输出 `Dependencies are all up to date, looking good!`。

### 3.3 `--nohooks` 导致的生成物与下载物

| 缺失文件 | 来源 hook | 处置 |
| --- | --- | --- |
| `build/util/LASTCHANGE` + `.committime` | `lastchange` | 跑 `build/util/lastchange.py` |
| `gpu/config/gpu_lists_version.h` | `gpu_lists_version` | 同上（`-m GPU_LISTS_VERSION --revision-id-only`） |
| `skia/ext/skia_commit_hash.h` | `lastchange_skia` | 同上（`-s src/third_party/skia`） |
| `gpu/webgpu/DAWN_VERSION` + `dawn_commit_hash.h` | `lastchange_dawn` | 同上（`-s src/third_party/dawn`） |
| `build/toolchain/win/rc/win/rc.exe` | `rc_win`（`chromium-browser-clang/rc` 桶） | 从 140 树拷 590 KB |

`DAWN_VERSION` 这一项最坑：它不是源码文件，报错埋在 `third_party/dawn/generator/dawn_version_generator.py` 的 Jinja2 渲染里，表面看像「dawn 模板坏了」。

### 3.4 PATH：`generate_config_gypi.py` 需要裸 `gn.bat`

`third_party/electron_node/tools/generate_config_gypi.py` 里写死 `GN = 'gn.bat' if sys.platform == 'win32'`，用 `subprocess.check_output([GN, 'args', ...])` 调裸命令名。而 `depot_tools/gn.bat` 本身只是转发给 `gn.py`，`gn.py` 再在 PATH 里找 `gn.exe`。

所以构建时必须前置**两个**目录：

```
PATH = D:\depot_tools;<src>\buildtools\win;<src>\third_party\ninja;%PATH%
```

少了 `buildtools\win` 就是 `gn.py: Unable to find gn in your $PATH`。

### 3.5 唯一一处「上游行为回退」：`dbghelp.dll`

```diff
-# Chromium 142（上游）
- debug_files = [('dbghelp.dll', False), ('dbgcore.dll', True)]
+# 回退到 140 语义
+ debug_files = [('dbghelp.dll', True),  ('dbgcore.dll', True)]
```

位置 `build/vs_toolchain.py`。142 把 `dbghelp.dll` 从 optional 改成 **required**，而本机 Windows SDK `10.0.26100.0` 没装 "Debugging Tools for Windows" 组件，`gn gen` 直接抛异常。

**为什么选择改代码而不是装组件**：

- `build.ninja` 里 `copy_dlls` 命中数为 **0** —— 这三个 DLL（`dbghelp`/`dbgcore`/`msdia140`）只服务于崩溃转储符号化，我们根本不构建那一步；
- 装 SDK 组件要动 **已交付的 140 基线共用的那份 SDK**，风险不对等；
- 这个改动语义上只是「回到 140 的行为」，不是新发明。

等 142 全部验证通过后可 revert 并补装组件。

---

## 四、断网状态下的依赖同步（本次最耗时的部分）

### 4.1 现象

`gclient sync --nohooks` 表现为「下载 14.4 GiB，1.2 MiB/s，ETA 3–4 小时」。真实原因有两层：

1. `D:\git_cache\chromium.googlesource.com-chromium-src`（chromium/src 的本地 git 缓存，14.9 GB）**整个不见了**，只剩一个 0 字节的 `.locked`；gclient 判定缓存无效 → 走 GCS bootstrap 快照 `gs://chromium-git-cache/v2/chromium.googlesource.com-chromium-src/<n>/`，46 个 pack 合计 **14.4 GiB**；
2. 缓存重建后 gclient 会把缓存仓库的 `remote.origin.url` **改写回** `https://chromium.googlesource.com/chromium/src.git` 再 fetch；当时 `127.0.0.1:10808` 代理已死、`chromium.googlesource.com` 直连被墙 → fetch 失败 → gclient **删掉缓存** → 再回去下 14.4 GiB。**死循环**。

### 4.2 还有一个「假死」

`git fetch` 成功后触发 `git maintenance run --auto` → `git repack` 全量重打 14.9 GB：`pack-objects` 吃 **13 GB 内存 / 300 s CPU**，表面看就是「卡住不动」。必须在缓存仓库里关掉：

```
git config gc.auto 0
git config gc.autopacklimit 0
git config gc.autodetach 0
git config maintenance.auto false
```

### 4.3 解决：全离线

1. 用 142 树自己的 `.git` 硬链接重建缓存：`git clone --bare --local` → **0.8 秒、零网络、零额外磁盘**；
2. 扫 `D:\git_cache` 下 149 个缓存仓库的 `remote.origin.url`，自动生成 **277 条 `url.<本地路径>.insteadOf <https 地址>`**，把所有远端重定向到本地裸库；
3. 树的 `port` 远端（`github.com/Sutanm/chromium.git`）临时指向本地缓存；
4. `gclient sync --nohooks --no_bootstrap -j8` → **44 个 DEPS 依赖全部落盘**（v8 / skia / icu / ffmpeg / angle / dawn / catapult / webrtc / pdfium / perfetto / swiftshader / electron_node 612 MB / nan …）。

顺带确认：`--no_bootstrap` 这个开关是关键，它让 gclient 在缓存无效时**直接报错**而不是偷偷下 14.4 GiB。

### 4.4 还有哪些下载是真需要的

| 内容 | 大小 | 来源 |
| --- | --- | --- |
| Rust 工具链（rustc + LLVM 22） | 1,393 MB（解压后） | `chromium-browser-clang/Win/rust-toolchain-...llvmorg-22...tar.xz` |
| Clang/LLVM 22 | 327 MB | 同上（`clang-cl.exe` 92.4 MB、`clang-tidy` 58.3 MB、`lld-link` 67.0 MB） |
| `meet-gpu-tests` 测试数据 | 422 MB | `chromium-telemetry` 桶 |

网络实际流量合计约 **2.15 GB**，全部走 `storage.googleapis.com`（该域名一直可通）。

### 4.5 顺手做的工具：全图缺失输入扫描

ninja 只会报**第一个**「missing and no known rule」，一轮一轮试错太慢。写了个脚本遍历 `build.ninja` + 全部 **10,639 个 subninja**（310,422 个 input / 259,882 个 output），一次性列出全部缺失输入：

- 修复前 **59** 个 → 修复后 **43** 个；
- 剩下的 43 个经核对**全部不在 `electron` 依赖链上**：`win_clang_x64_for_rust_host_build_tools/*`（26 个，只在编译 Rust 目标时用）、`chrome/updater` + `enterprise_companion` + `third_party/updater` 的 cipd 文件（11 个）、`symupload`/`dump_syms`/`google_converter`（3 个）、`phony/*` 伪产物（4 个）、`inspector_protocol/crdtp/json_platform.cc`（1 个，**140 树同样没有且 140 编译通过**）。

脚本：`D:\electron-build-142\find_missing_inputs.py`。

---

## 五、142 相对 140 的上游差异（本轮实测）

| 项 | 140 | 142 |
| --- | --- | --- |
| Chromium | `140.0.7339.41` | `142.0.7444.52` |
| Electron | `v38.0.0` | `v39.0.0` |
| node | `v22.18.0` | `v22.20.0` |
| Rust / LLVM | LLVM **21**（`llvmorg-21-init-16348`） | LLVM **22**（`llvmorg-22-init-8940`） |
| `dbghelp.dll` | optional | **required**（见 §3.5） |
| `exec_script` allowlist | 允许 `//build/config/clang/BUILD.gn` | 移出；`third_party/electron_node/node.gni` 需 electron 补丁加入 |
| PPAPI | **零** | **零**（与 140 同构：只剩一个空的 `enable_plugins` 开关） |

### 关于 Rust：不是 142 新增

`build/config/gclient_args.gni` 里 `build_with_chromium = true`，而 `build/config/rust.gni:34` 是 `enable_rust = build_with_chromium` → Windows 上默认 **true**。140 基线就已经在编 Rust：`out/Testing` 里有 **162 个 `.rlib` / 442 MB**。真实使用者：

- `third_party/boringssl/BUILD.gn:13` `if (enable_rust)`（BoringSSL 的 Rust 部分）
- `components/qr_code_generator/BUILD.gn:50` `rust_static_library("qr_code_generator_ffi_glue")`
- `testing/rust_gtest_interop/`
- `third_party/rust/` 下 **145 个 vendored crate**

所以每次升版都要重下一份预编译 Rust 工具链（~1.4 GB），这是固定成本。

### electron 补丁必须自己打

`apply_all_patches.py` **必须在 `cr` 目录执行，不能在 `cr/src`**（脚本里的 repo 名是 `src`、`src/v8`、`src/third_party/...`）：

```powershell
cd D:\electron-build-142\cr
python3 src\electron\script\apply_all_patches.py src\electron\patches\config.json
```

78 秒、80 个补丁全部 `Applying:` 成功。**不打补丁 `gn gen` 会直接失败**（`//.gn` 的 `exec_script` 白名单不含 `third_party/electron_node/node.gni`）。

---

## 六、方法论教训（第四次交学费）

### 6.1 「下载慢」永远先怀疑「在下载不必要的东西」

14.4 GiB 的真相不是网慢，是 gclient 要重建整个 git 缓存快照。真正的解法是把本地已有的东西**接回去**（硬链接重建缓存 + insteadOf 重定向），而不是优化下载速度。最终零流量完成同步。

### 6.2 「卡住不动」先查后台进程

那个「5 分钟没输出」不是网络问题，是 `git repack` 在打 14.9 GB 的包。看 `Get-CimInstance Win32_Process` 的 CPU/内存占用一眼就能分辨「等网络」和「烧 CPU」。

### 6.3 用扫描代替试错

ninja 一次只报一个缺失输入。写 40 行脚本遍历全图（10,639 个文件、310k input），5 分钟拿到完整清单，比跑 6 轮 15 分钟的构建划算得多。

### 6.4 「从旧树拷文件」这条捷径有边界

拷 `node_modules` 能立刻满足**静态输入**（CSS、图片、JS 资源），但 electron 的 `pre-flight` 会校验**版本范围**，一旦跨大版本（v38→v39）就会暴露。正确做法：拷是为了先跑起来，跑起来后立刻按 `package.json` 补齐版本。

---

## 七、当前树状态

| 项 | 值 |
| --- | --- |
| 路径 | `D:\electron-build-142\cr\src` |
| 分支 | `bao/142-linux`（从 tag `142.0.7444.52` 拉出） |
| HEAD | `02eb0e0d`（electron 补丁已按 commit 落库） |
| 未提交 | `build/vs_toolchain.py`（§3.5 补丁）、`buildtools/win/`（拷来的 gn） |
| 构建产物 | `out/Testing` 16.2 GB / 116,368 文件 |

**建议**：提交上面两处后打 tag `bao-v142-noppapi`，作为「142 空载可编译」基线。

## 八、下一步

142 的 PPAPI 仍是零。接线路径（方案 C，非 `git merge`）：

1. 从 `bao/140-linux` 拷 `ppapi/`(1,470) + `content/renderer/pepper/`(147) + `content/browser/renderer_host/pepper/`(61) + `content/ppapi_plugin/`(9)；
2. 拷 12 个 vendored infra 文件（`ipc/ipc_channel_handle.h`、`ipc/param_traits_log_macros.h` 等）；
3. 对 **293 个重叠文件**做接线（`content/BUILD.gn`、`render_frame_impl`、`blink` 接口等）；
4. 编译 → 跑 140 的回归集（2D / Stage3D / 输入 / URLLoader / Socket / 视频 / LSO / 全屏 / 剪贴板 / JS↔Flash / 4399 登录）。

### 待清理的技术债（本轮临时措施）

- `~/.gitconfig` 里的 **277 条 `url.*.insteadOf`** 与 `gc.auto=0`、`maintenance.auto=false`（已备份 `~/.gitconfig.bak-142`）——网络恢复后必须回滚，否则对 chromium/electron 相关地址的 git 操作会走本地路径；
- 142 树的 `port` 远端被临时改成 `D:/git_cache/...`（原值已存 `D:\electron-build-142\port-url.txt`）——**push 前必须恢复**。
