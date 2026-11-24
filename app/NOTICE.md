# 第三方组件与许可（内部验证包）

本包是**内部 Win x64 验证包**，不是对外发布版本。对外分发前必须逐项确认下列许可与合规事项。

## 随包组件

| 组件 | 版本 | 用途 | 许可 | 状态 |
| --- | --- | --- | --- | --- |
| Electron | 39.8.10（自编译） | 应用外壳与运行时 | MIT | ✅ `licenses/LICENSE.electron` 随包 |
| Chromium | 142.0.7444.265（自编译，含 PPAPI 恢复补丁） | 浏览器内核 | BSD-style + 大量第三方许可 | ⚠️ `licenses/LICENSES.chromium.html` 随包，但取自**官方 Electron 39.8.10 发行包**（同版本近似），不是本内核构建产物；来源见 `licenses/README.md` |
| Ruffle | 0.8.0 | Flash 模拟引擎（`vendor/ruffle/`） | MIT OR Apache-2.0 | ✅ 许可文本随包（`vendor/ruffle/LICENSE_MIT`、`LICENSE_APACHE`） |
| Adobe Flash Player（PPAPI 插件） | 29.0.0.171 | 原生 Flash 引擎 | **Adobe 最终用户许可协议** | **BYOP**：本项目**不随包分发**。用户自行把 `pepflashplayer64.dll` 放到 `<exe目录>\flash\`；用户没放时应用会**自动发现本机已安装的那一份**（系统 Macromed、Chrome/Chromium 的 PepperFlash 等，只读不复制），我们只负责加载本机已有文件，不提供来源与下载方式 |

## 已知缺口（对外发布门禁）

1. **代码签名**：默认构建不签名。提供 `WIN_CSC_LINK`（或 `CSC_LINK`）+ `CSC_KEY_PASSWORD`
   时 `pack:win` 会走 electron-builder 的签名流程，并在产物清单里记录签名状态；未签名时
   `manifest.json` 会明确标记 `signed: false`。对外分发前必须签名并验证签名链。
2. **Chromium 许可为同版本近似**：需要由内核构建阶段生成自己的 `LICENSES.chromium.html`
   （Chromium 的 credits 产物）再替换 `licenses/` 下的文件。
3. **内部包携带 Flash 插件**：`pack:win` 的 internal profile 会带 Adobe 二进制，仅供内部验证、**不得对外分发**；对外用 `pack:win:public`（BYOP，产物不含 Adobe 二进制）。
4. **独立复建**：内核依赖仓库外的补丁与本机环境（`docs/kernel/README.md`），独立复建与
   依赖校验尚未完成。

## 校验方式

`npm run pack:win` 会：

1. 用 `scripts/runtime-manifest.json` 校验内核 EXE、PPAPI 插件与 Ruffle 运行时的 SHA-256；
2. 检查包内 Flash 插件有且只有一份、许可文件齐全；
3. 读取代码签名状态；
4. 在产物根目录写 `manifest.json`，记录组件哈希、许可与签名状态、内核 tag 以及上面的门禁清单。

若确认是有意的内核更新，需同步更新清单并在提交信息里写明新内核的来源与 tag。
