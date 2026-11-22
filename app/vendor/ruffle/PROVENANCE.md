# Ruffle 运行时（vendored）

版本固定的本地运行时，随仓库入库（架构 §3 引擎：「Ruffle 使用版本固定的本地资源」）。

| 项 | 值 |
| --- | --- |
| 包 | `@ruffle-rs/ruffle` **0.8.0**（2026-11-19 发布） |
| 来源 | 上游 npm 包的本地副本（`npm pack @ruffle-rs/ruffle@0.8.0`），非运行时下载 |
| 许可 | MIT OR Apache-2.0（见 `LICENSE_MIT`、`LICENSE_APACHE`） |
| 加载方式 | 页面 preload 通过同步 IPC 取 `ruffle.js`，注入页面主世界；WASM 经 `ruffle-resource://` 由 Ruffle 自己 fetch |

## 文件与 SHA-256

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| `ruffle.js` | 683,062 | `3ABFDEEE9373E3AD654973D31CBB255D75DFDCBF44124D5D9882F026D99BC8B7` |
| `ruffle_web_bg.QDRSAAAZ.wasm` | 14,638,326 | `AB23C8D226603425F4F4B620AA035C64DF46DBA9E8149E7E33EF54E0A25547CB` |
| `ruffle_web-wasm_mvp_bg.UMWKJ7EM.wasm` | 14,513,591 | `070F9859D2EBE421388CC437CCF950FE98C344850BA91FAF340730A00E14DF44` |
| `LICENSE_MIT` | 1,097 | `4DE9338A7879C68E911742A7D691F0797FF1EF8D8A6FB978B0C711E258FE959C` |
| `LICENSE_APACHE` | 9,723 | `62C7A1E35F56406896D7AA7CA52D0CC0D272AC022B5D2796E7D6905DB8A3636A` |

## 升级方式

1. `npm pack @ruffle-rs/ruffle@<version>`，解包后替换本目录的 `ruffle.js`、两个 `.wasm`、两个 LICENSE、`package.json`（`.map` 不入库）；
2. 更新本文件的版本与哈希；
3. 跑 `npm run smoke` 的 `engine` 用例（断言 `RufflePlayer.newest` 与 `<embed>` 被替换为 `ruffle-embed`）。

## 已知限制与注意点

- **WASM 文件名带大写哈希**（0.8.0 起）。`ruffle-resource://` 是 `standard` scheme，`new URL()` 会把 hostname 归一成小写，因此主机进程做了不区分大小写的文件回退（`resolveResourcePath()`）。没有这段回退时 Windows 靠大小写不敏感碰巧能跑，Linux 上会 404。
- Ruffle 0.8.0 的元素名是 `ruffle-embed` / `ruffle-object`。冒烟断言同时匹配 `ruffle-player`，兼容旧版命名。
- `ExternalInterface` 只覆盖部分 API：本地 PPAPI 样本里的 `PercentLoaded`/`SetVariable` 往返在 Ruffle 引擎下**不保证**可用（那是原生插件的行为）。引擎切换的验收断言只看运行时注入与 polyfill 接管。
- 站点 CSP 若限制 `connect-src`，会影响 Ruffle 取 WASM；`ruffle.js` 本身走 IPC，不受 CSP 影响。
- 插件版本通告（`playerVersion`）保持 Ruffle 默认值；站点版本门伪装按审计 §C7 由 142 站点对照另行决定。
