# 第三方组件与许可（内部验证包）

本包是**内部 Win x64 验证包**，不是对外发布版本。对外分发前必须逐项确认下列许可与合规事项。

## 随包组件

| 组件 | 版本 | 用途 | 许可 | 状态 |
| --- | --- | --- | --- | --- |
| Electron | 39.8.10（自编译） | 应用外壳与运行时 | MIT（Electron）+ BSD-style 与 Chromium 的第三方许可 | ⚠️ 本包未携带 `LICENSES.chromium.html`（自编译产物未包含该文件），对外发布前必须补齐 |
| Chromium | 142.0.7444.265（自编译，含 PPAPI 恢复补丁） | 浏览器内核 | BSD-style + 大量第三方许可 | ⚠️ 同上；补丁来源见 `docs/kernel/README.md` |
| Ruffle | 0.8.0 | Flash 模拟引擎（`vendor/ruffle/`） | MIT OR Apache-2.0 | ✅ 许可文本随包（`vendor/ruffle/LICENSE_MIT`、`LICENSE_APACHE`） |
| Adobe Flash Player（PPAPI 插件） | 29.0.0.171 | 原生 Flash 引擎 | **Adobe 最终用户许可协议**，再分发受限制 | ⚠️ **未确认再分发授权**。仅限内部测试；对外分发前必须取得授权或移除插件 |

## 已知缺口（对外发布门禁）

1. **代码签名**：当前构建 `signAndEditExecutable: false`，产物未签名。对外分发前必须签名，并验证签名链。
2. **Chromium/Electron 许可文件缺失**：自编译内核没有生成 `LICENSES.chromium.html`，需要从同版本官方产物补齐，或由内核构建阶段生成。
3. **Flash 插件再分发授权**：未取得书面确认前，本包只能在内部测试范围使用。
4. **独立复建**：内核依赖仓库外的补丁与本机环境（`docs/kernel/README.md`），独立复建与依赖校验尚未完成。

## 校验方式

`npm run pack:win` 会用 `scripts/runtime-manifest.json` 校验内核与插件的 SHA-256；不匹配即失败。
若确认是有意的内核更新，需同步更新清单并在提交信息里写明新内核的来源与 tag。
