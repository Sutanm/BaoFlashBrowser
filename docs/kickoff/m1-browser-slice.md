# M1 验收：浏览器薄切片（BaoFlashBrowser Next）

**判定：M1 通过，作为「受控的 Win x64 内部验证版」结项。**

这是 M1 的验收口径来源。凡与本文冲突的历史说法，以本文为准；本文未覆盖的行为一律视为**未验收**。

- 验收对象：`next` 分支 `70edb64`（M1 期间共 29 个提交，`6420049..70edb64`）
- 验收时间：2026-11-23
- 审计材料：立项至 M1 的代码审计（P1 4 项、P2 8 组），其中 P1 全项与 P2 全部已处理，剩余项见 §8

---

## 1. 基线与产物

| 项 | 值 |
| --- | --- |
| 应用运行时 | 自编译 Electron **39.8.10** / Chromium **142.0.7444.265** |
| 内核 tag / commit | `bao-v142-265-ppapi-sandbox` / `9de35f61aea60`（回退 tag `bao-v142-265-verified`） |
| 内核补丁 | [`docs/kernel/0001-ppapi-renderer-plugin-path-check.patch`](../kernel/0001-ppapi-renderer-plugin-path-check.patch)：修复沙箱渲染进程里 PPAPI 插件的路径检查 |
| Ruffle | **0.8.0**（vendored，`app/vendor/ruffle/`，`PROVENANCE.md`） |
| PPAPI Flash | 29.0.0.171（**BYOP**：不随公开包分发，见 §9.4） |
| 来源校验清单 | [`app/scripts/runtime-manifest.json`](../../app/scripts/runtime-manifest.json)（5 个文件的 SHA-256） |

打包产物校验（`npm run pack:win` 实测输出）：

```
来源校验通过（内核 tag bao-v142-265-ppapi-sandbox）：5 个文件
内核校验：运行时 232040448 字节 / 产物 232040960 字节
签名状态：not-signed（发布门禁）
```

---

## 2. 交付范围（对照架构 §6 M1 退出标准）

| M1 退出标准 | 实现 | 证据 |
| --- | --- | --- |
| 一个应用包与真实自编译运行时集成 | `electron-builder` 用 `ELECTRON_EXEC_PATH` 指向自编译 dist；产物大小与内核一致性断言 | §4 成品冒烟；`manifest.json` |
| 导航 | 地址栏解析 http(s)、错误提示、失败重试、`will-frame-navigate`/`will-redirect` 拦截非 http(s) | `startup`、`engine` 用例 |
| 标签切换 / 新增 / 关闭 / 撤销关闭 | 主进程权威标签表、全局稳定 ID、`binding` 代际、关闭保留导航栈 | `tabs`、`tab-ops` 用例 |
| 引擎切换 | 新 WebContents + 导航栈恢复；失败在新引擎重开最后地址并提示 | `engine`、`engine-broker` 用例 |
| 输入 | 页面键盘、地址栏/页面焦点互不串台、IME 组合（页面侧）、F11 | `input`、`plugin-input` 用例 |
| 焦点 | 窗口/视图/地址栏焦点交接；Ruffle 播放器需点击取得键盘焦点（已实测） | `input`、`ruffle-input` 用例 |
| 崩溃恢复 | 崩溃态提示 + 「重新加载」重建视图；旧事件按 `binding` 作废 | `isolation` 用例 |
| 沙箱 | 外壳与页面视图均 `sandbox: true`；PPAPI 可用依赖内核补丁 0001 | `flash` 用例（插件进程内 JS 桥通） |
| IPC | 异步命令 + 投影事件；公共合同校验发送者身份与输入；页面拿不到外壳 IPC 桥 | `engine-broker`（页面无特权入口）、`ruffle-cors` |
| Session 权限 | 白名单仅 `fullscreen`/`pointerLock`，按**请求帧 + 嵌入源**判定；下载默认拒绝；弹窗/新窗口/外部协议显式策略 | `permissions`、`popup` 用例 |
| 窗口关闭 | 关闭窗口时主动关闭其拥有的 WebContents；最后一个窗口关闭即退出 | `tearoff`、`isolation` 用例 |
| 真实产物 smoke 自动执行 | `smoke:packaged` 不允许默认跳过，按产物 `manifest.json` 判定 profile | §4 |

M1 迭代中补齐的相关项：标签右键菜单 / 固定 / 复制 / 静音迁移、DevTools 入口、暗色模式跟随系统、BYOP 拆包、打包来源门禁与许可清单。

---

## 3. 引擎与网络模型（M1 最重要的设计取舍）

双引擎的网络语义天然不同：PPAPI 是独立插件进程、不受页面 CORS 约束；Ruffle 是页面里的 WASM 播放器、受页面 origin 约束。老站点跨域提供 SWF/数据且不返回 `Access-Control-Allow-Origin`。

**当前实现**（`app/src/main/net-broker.ts` + `app/src/preload/page.ts` + `app/src/main/crossdomain.ts`）：

| 决策 | 内容 |
| --- | --- |
| 特权出口位置 | **不替换页面 `window.fetch`**。注入前重写 wasm-bindgen 的 `__wbg_fetch_*` import，把 Ruffle 自己的 fetch 指向闭包内的私有传输；临时全局立即删除；模式匹配失败即 fail-closed |
| 授权依据 | 目标站 `crossdomain.xml`（按目标**完整 origin** 抓取与缓存，不跨协议回退）；同源按 scheme+host+port 比较 |
| 来源可信度 | 用 `event.senderFrame.url` 的 origin；非 http(s)（含 opaque origin）一律拒绝 |
| 重定向 | `redirect: 'manual'`，逐跳重新授权，最多 5 跳 |
| Cookie | 不用手工拼 header，交给 `net.request` 的 `useSessionCookies` |
| Referer | `X-Bao-Referer: <每启动随机令牌>\|<编码 URL>`，页面会话只还原令牌匹配的标记，其余只剥离不改写 |
| 页面 JS | 保持浏览器原生语义（方法/请求头/取消信号不被吞，跨源读取仍受 CORS） |

真实站点普查（34 站，见 [`docs/evidence/2026-11-22-crossdomain-survey.json`](../evidence/2026-11-22-crossdomain-survey.json)）：15 站提供 `crossdomain.xml`；两个实测站点均被策略放行。

---

## 4. 自动化验收

### 4.1 应用冒烟（`npm run smoke`，22/22 通过）

| # | 用例 | 覆盖 |
| --- | --- | --- |
| 1 | 自编译运行时启动无边框外壳并保持单标签、导航与焦点 | 启动、Shell、地址栏 |
| 2 | 标签排序、关闭按钮可见性与鼠标手势 | 标签条 |
| 3 | 快捷键与撤销关闭恢复导航栈 | 快捷键、`undo-close` |
| 4 | 标签操作：复制、固定排序、静音迁移与拖出判定 | 标签操作 |
| 5 | DevTools：Ctrl+Shift+I 开关页面视图的开发者工具 | DevTools |
| 6 | 拖出标签在新窗口保留业务 ID、页面运行时状态与历史 | 跨窗口移交 |
| 7 | 指针拖出标签触发跨窗口移交 | 移交 + 快捷键归属 |
| 8 | 快捷切换保留导航栈，Ruffle 接管 SWF | 引擎切换 |
| 9 | 引擎面板分别切换引擎与记住站点规则，起始页不可记住 | 引擎面板 / 站点规则 |
| 10 | 引擎来源跨站后不残留上一个站点的规则 | 来源派生 |
| 11 | 地址错误提示不挤动工具栏或页面，加载失败后可以重试 | 错误处理 |
| 12 | 本地 PPAPI 样本在独立测试 profile 中注册插件并保留 JS 桥 | PPAPI 基线 |
| 13 | 键盘事件进入 PPAPI 插件进程（插件内部输入回环） | 插件内输入 |
| 14 | 输入回环：页面键盘、IME 组合、焦点交接与 F11 全屏 | 输入 / 焦点 |
| 15 | Ruffle 画布焦点：点击播放器后键盘事件进入 SWF | Ruffle 输入 |
| 16 | Ruffle 跨源加载：SWF、数据请求与跨源 iframe 子帧 | Ruffle 网络 |
| 17 | 引擎网络 broker：只有 Ruffle 能跨域读，页面脚本的同源策略不受影响 | 网络边界（P1-1 回归守卫） |
| 18 | 受控弹窗：同站开真实窗口、策略递归到子窗口、跨站与非 http(s) 拒绝 | 弹窗策略 |
| 19 | 权限白名单：只放行 fullscreen / pointerLock，其余拒绝 | 权限 |
| 20 | 窗口销毁与重建后旧事件和旧标签身份保持隔离 | 隔离 / 崩溃重建 |
| 21 | 暗色模式：跟随原生主题切换外壳与叠加层 | 主题 |
| 22 | 弹窗使用自绘 chrome：无原生边框，控制簇可用 | 弹窗 chrome（A5） |

### 4.2 成品冒烟（`npm run smoke:packaged`）

按产物自带 `manifest.json` 的 `profile` 分支：

| profile | 断言 | 实测 |
| --- | --- | --- |
| internal（带插件） | 启动 39.8.10/142.0.7444.265、起 Pepper Plugin 进程、本地 Flash JS 桥通、Ruffle 运行时已注入 | ✅ 通过 |
| public（BYOP） | 无 Pepper Plugin 进程、页面回落 Ruffle、Ruffle 注入正常 | ✅ 通过 |
| BYOP 落地（仅 public） | 把插件复制到 `<exe目录>\flash\` 后必须起 Pepper Plugin 进程且 `flash:loaded bridge` | ✅ 通过，跑完清理投放目录 |

缺产物时 `smoke:packaged` **直接失败**（只有 `BAO_SKIP_PACKAGED=1` 才跳过）；`BAO_PACKAGED_ROOT` 可指向 CI 的本次产物。

---

## 5. 真实站点对照（人工 + 脚本）

| 站点 | 引擎 | 结果 | 证据 |
| --- | --- | --- | --- |
| `https://www.4399.com/flash/254626_3.htm` | PPAPI | 游戏正常渲染 | [截图](../evidence/2026-11-22-4399-254626-ppapi.png) |
| 同上 | Ruffle | 游戏正常渲染（broker 放行 + Referer 还原生效，正版 SWF 2.7 MB） | [截图](../evidence/2026-11-22-4399-254626-ruffle.png) |
| `http://mole.61.com/` | PPAPI / Ruffle | 首页渲染；Ruffle 推进到游戏「开始」界面 | [ppapi](../evidence/2026-11-22-mole-61-ppapi.jpg)、[ruffle](../evidence/2026-11-22-mole-61-ruffle-after.jpg) |

两站均**不做**版本门/UA 门；`Shockwave Flash 29.0 r0` 可正常加载。策略收紧后复测：4399（https→https，依赖 Referer）与淘米（http→http，wildcard 策略）在 Ruffle 下零 CORS/broker 拒绝，页面世界无 `__bao_*` 残留、`window.fetch` 为 native。

---

## 6. 已知取舍

| 取舍 | 原因 | 影响 |
| --- | --- | --- |
| 只有目标站提供 `crossdomain.xml` 才放行跨源读 | 与 Flash 语义一致（审计要求） | 未提供策略的站点跨域加载会失败，行为与 Flash 当年相同 |
| `crossdomain.xml` 只能按目标 origin 取，不回退协议 | 避免绕过 `secure`（只禁止 http 来源 → https 目标） | 极少数 http 站点策略取不到即视为无策略 |
| Ruffle 的 `__wbg_fetch_*` import 靠字符串替换 | Ruffle 0.8 无请求钩子，且不能动页面 `window.fetch` | Ruffle 升级可能改模式；失配时 fail-closed（只失去跨域兼容） |
| Ruffle 需要用户先点一次播放器才有键盘焦点 | Ruffle 靠 `pointerdown` 拿焦点 | 首次交互需点击；已写进 README 并有用例守护 |
| `engineSource` 为派生值 | 避免跨站导航残留上个站点的来源 | 站点规则与当前引擎不一致时，界面显示"已被覆盖" |
| 引擎切换失败**不**回滚引擎 | 回滚需要保留旧视图到恢复成功（两阶段），未实现 | 语义是"在新引擎重开最后地址并提示"，不是"保留原引擎" |
| 关闭最后一个标签会补一个新标签 | 窗口不留空 | 与 Chrome「关窗」语义不同 |
| 弹窗窗口固定 1024×768 | 未解析 `window.open` 的 features | 依赖指定尺寸的老站弹窗会不符合预期 |
| 弹窗窗口不参与标签列表与撤销关闭 | 简化 | 关掉 opener 后子窗口独立存活 |
| 快捷键仅 `Ctrl+T/W/Tab/Shift+T/Shift+I` | 避免与页面自身快捷键冲突 | `Ctrl+1..9`、`Ctrl+L` 等未实现 |
| 标签分组、标签搜索、未加载占位未实现 | M1 后续增量 | — |
| i18n 暂缓 | 165 处中文字面量；locale 需持久化，设置存储属 M2；UI 仍在变动 | 界面仅中文 |
| 暗色模式无手动开关 | 依赖设置存储 | 仅跟随系统 |
| 下载默认拒绝 | M1 无下载策略与 UI | 站点触发下载会被拦截并记日志 |

---

## 7. 加固记录（审计 P1/P2）

| 审计项 | 处理 |
| --- | --- |
| P1-1 普通页面脚本获得 broker 跨源读能力 | 移除页面 `__baoNet` 与 `window.fetch` 替换，改为改写 wasm-bindgen fetch import；用例断言页面跨源仍被 CORS 拦截、无 `__bao_*` 残留、`fetch` 为 native |
| P1-2 授权主体/重定向 | 来源取完整 origin、同源比 scheme+host+port、策略按 origin 抓取与缓存（上限 200 条、64 KiB 流式读取）、逐跳授权、Cookie 交给 Chromium、Referer 令牌化 |
| P1-3 弹窗未继承策略 | `guardContents` 递归装到每一级子窗口；站点边界改为「精简公共后缀表的可注册域 + 协议一致」；负向断言改为原生窗口计数 |
| P1-4 跨窗移交 | 快捷键按 `tab.host.shortcut(tab, input)` 分发；`adoptTab` 改为两阶段（外壳加载成功后再接管），失败回滚加存活性守卫 |
| P2 权限 | 请求侧用 `details.requestingUrl`，检查侧看 `requestingOrigin` + `details.embeddingOrigin`，非 http(s) 一律拒绝 |
| P2 标签一致性 | 静音记在 `Tab.muted` 并在重建后迁移；`moveTab` 夹取固定前缀；`dropIndex` 同时校验横纵；`pointercancel` 丢弃拖动；方向键切标签后焦点留在标签栏 |
| P2 打包 | 来源 SHA-256 门禁、插件唯一、许可文件齐全、PE 证书表签名状态、产物 `manifest.json` |

---

## 8. 未验收（明确不承诺）

**输入**
- 真实游戏 SWF 内的方向键/组合键（用例只证明 keydown 进入 AVM2）
- IME 组合输入进入 Ruffle 或 PPAPI 插件内部
- 切换引擎后的 Flash 内输入焦点

**站点**
- 登录/防沉迷完整流程、真实游戏本体（需账号，本增量不做真站登录回归）
- 4399 之外的站点批量回归；淘米只到「开始」界面（Ruffle 的 `URLStream` 仍是 stub）
- Ruffle 的 Stage3D、音频、后台持续出帧（#52844 相关回移仍暂缓）

**窗口/进程**
- 跨窗口移交后的失焦、全屏退出、音频继续播放
- Windows 原生 IME 验收；Pepper 插件进程的隔离强度（页面 renderer 沙箱不等于插件进程沙箱）
- 权限 frame 分支的自动化覆盖（沙箱 opaque origin 的 iframe 无法在上层驱动，只做代码评审）

**其他**
- `restore()` 失败的真实用例（POST 体等无法还原的状态）
- `npm run dev`（Vite 开发入口）未在本次冒烟范围

---

## 9. 发布门禁（对外分发前必须完成）

1. **代码签名**：产物未签名（PE 证书表为空）。接入点已就绪：提供 `WIN_CSC_LINK`/`CSC_LINK` 时走 electron-builder 签名，产物清单记录状态；签名链需发布时用 signtool 验证。注意 2023-06 起私钥须存于 FIPS 140-2 L2 硬件/HSM，pfx 路径对**新证书**基本不适用，需改用厂商云签名 CLI。
2. **Chromium 许可为同版本近似**：`licenses/LICENSES.chromium.html` 取自官方 Electron 39.8.10 发行包（本内核同为 142.0.7444.265），最终应由内核构建阶段生成替换，见 [`app/licenses/README.md`](../../app/licenses/README.md)。
3. **独立复建与依赖校验未做**：内核依赖仓库外补丁与本机环境，见 [`docs/kernel/README.md`](../kernel/README.md)。
4. **Flash 采用 BYOP**：公开包（`pack:win:public`）**不含** Adobe 二进制，用户把 `pepflashplayer64.dll` 放到 `<exe目录>\flash\`；内部包（`pack:win`）带插件且**默认拒绝签名**（`BAO_ALLOW_SIGN_INTERNAL=1` 才放行），仅供内部验证、不得对外分发。我们只加载用户提供的文件，不提供来源与下载方式。
5. **CI 未接**：仓库无 CI 工作流；`smoke:packaged` 已具备「不可默认跳过」与 `BAO_PACKED_ROOT` 定向能力，接线即可用。

---

## 10. 移交 M2

- 设置存储（locale、主题开关、引擎默认值）、SQLite 迁移（当前站点规则是 `userData/engine-rules.json`）
- 会话恢复、书签、历史、下载（当前默认拒绝，需要策略与 UI）
- 标签分组、标签搜索、未加载占位（discard）
- i18n（在设置库落地后一起做）
- 两阶段引擎切换（保留原引擎直到恢复成功）
- 签名/分发/独立复建/CI（见 §9）

---

## 11. 复现步骤

```powershell
# 准备自编译运行时（一次性）
npm run runtime:prepare -- 'D:\electron-build-142\dist'

# 应用冒烟（21 个用例，用临时 profile）
npm run smoke

# 打包 + 成品冒烟
npm run pack:win            # internal：带插件，仅供内部验证
npm run smoke:packaged
npm run pack:win:public     # public：BYOP，不含 Adobe 二进制
npm run smoke:packaged      # 会自动识别 profile，并跑 BYOP 落地用例

# 栅栏命令
npm run typecheck
```

BYOP 手工验证：把 `pepflashplayer64.dll` 放到 `<exe目录>\flash\`，重启应用，引擎面板里的「Flash」档应从置灰变为可用。

---

## 12. 证据索引

| 内容 | 位置 |
| --- | --- |
| M1 增量记录（实现细节、命令输出、发现） | [`docs/reports/2026-11-22-m1-shell-increment.md`](../reports/2026-11-22-m1-shell-increment.md) |
| 架构与审计（含 P1/P2 来源） | [`docs/discussions/2026-11-22-bfb-next-architecture.md`](../discussions/2026-11-22-bfb-next-architecture.md)、[`-audit.md`](../discussions/2026-11-22-bfb-next-architecture-audit.md) |
| 内核补丁与重建说明 | [`docs/kernel/README.md`](../kernel/README.md) |
| 第三方许可与发布门禁 | [`app/NOTICE.md`](../../app/NOTICE.md) |
| 跨域策略普查数据 | [`docs/evidence/2026-11-22-crossdomain-survey.json`](../evidence/2026-11-22-crossdomain-survey.json) |
| 真站截图（双引擎） | [`docs/evidence/`](../evidence/) |
| M1 期间提交 | `6420049..70edb64`（29 个，其中审计后 7 个：`a317595`、`65a04a0`、`b303ec4`、`98b1a01`、`d84a79b`、`8cab7a2`、`70edb64`） |
