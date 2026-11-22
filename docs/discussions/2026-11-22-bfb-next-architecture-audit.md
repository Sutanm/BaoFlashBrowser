# BaoFlashBrowser Next 架构审计

2026-11-22 · 审计对象为 [2026-11-21 架构讨论稿](2026-11-21-bfb-next-architecture.md) 的 A–F 全部议题。交叉核对了技术栈讨论、ADR、142 运行报告、截图探针记录及上游资料。原审计完成后，已补入 39.8.10 构建验收和 #52844 探针的后续结论。

## 审计判定

**讨论记录有保存价值，工程基线不通过。** 原稿最有价值的内容是用户裁决、Flash 真机结果和旧版故障记录。最严重的问题是把用户期望、旧版机制、上游 API 存在与 Next 已验收混写为「已定」。一批相互依赖的设计因此被提前锁定，具体实现甚至依赖不存在的 API。建议以[新版架构设计](2026-11-22-bfb-next-architecture.md)作为后续评审入口。

优先级用来决定何时解决。P0 阻止相应能力合入或发布，P1 在实现该模块前处理，P2 是文档和选型质量问题。

## 当前开工判定

**可启动 Win x64 外壳与原生 Flash 标签集成。** 当前 39.8.10 构建可用于应用开发，正式发布仍需独立复建和依赖校验。#52844 在 6 轮本地 HTML 对照中有 5 轮全部通过，只有 1 轮同时影响默认节流和关闭节流组，当前暂缓回移。真实 Flash 标签中的后台恢复仍待验收。沿[新版架构的交付顺序](2026-11-22-bfb-next-architecture.md#6-交付顺序和验收)开工。密码、扩展和 Agent 的 P0 各自约束对应能力。

## P0 核心纠正

| 原稿位置 | 问题与依据 | 审计处置 |
| --- | --- | --- |
| C7、F7、ADR 0002 | 初始记录验证了 Win x64 的 E39.0.0/M142.0.7444.52。后续已在 E39.8.10/M142.0.7444.265 重放项目补丁，并通过 JS 桥、Stage3D AUTO/SOFTWARE 和火线精英启动验收。官方 E39 已于 2026-05-05 停止支持。 | 使用新产物作为工程基线。对公开发布仍需明确补丁维护、更新与退场条件。 [项目发布配置验收 §10.16](../reports/2026-11-21-142-flash-runtime.md) · [Electron 时间表](https://releases.electronjs.org/schedule) · [39.8.10 发布说明](https://releases.electronjs.org/release/v39.8.10) |
| C4-D1–D3 | **E39 没有异步 safeStorage。** 39.8.10 的文档和原生绑定只导出同步加解密。E42 预发布记录才列出新增异步功能。直接照稿实现会在目标版本上失败。同步存储的 Linux `basic_text` 也达不到强密钥存储要求，账号级 DPAPI 与查看时的人机验证有不同职责。 | 重新打开载体裁决。评估 E39 同步 API 的延迟和后端状态，或暂缓密码功能。密钥读取失败保留原始数据，Linux 无可信后端时默认停用保存。参见 [E39 原生绑定](https://github.com/electron/electron/blob/v39.8.10/shell/browser/api/electron_api_safe_storage.cc#L118-L130)、[E39 safeStorage](https://github.com/electron/electron/blob/v39.8.10/docs/api/safe-storage.md)、[E42 预发布记录](https://releases.electronjs.org/release/v42.0.0-alpha.2)。 |
| B1/B2、C1、F7 | 每个 WCV 有独立 WebContents，这不能证明每标签固定独占一个 OS renderer。禁用后台节流会影响同一窗口的出帧与交换行为。隐藏、持续出帧、冻结、销毁是不同状态。#52844、#54311 和 #54090 针对不同触发条件，现有证据无法把三条升为 E39 必装组合。 | 在实际 WCV 宿主复现，分别评估前台恢复、节流切回和隐藏跨导航。各场景独立测帧、CPU/GPU、资源释放和前台干扰。[E39 WebPreferences](https://github.com/electron/electron/blob/v39.8.10/docs/api/structures/web-preferences.md)、[Chromium 进程模型](https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)、[52844](https://releases.electronjs.org/pr/52844)、[54311](https://releases.electronjs.org/pr/54311)、[54090](https://releases.electronjs.org/pr/54090)。 |
| C8、D4-S1–S5 | D4-S3 套用了原 port bridge 的线协议。Electron `debugger.sendCommand` 返回 Promise，`message` 是解析后的协议事件，应用层无需解析 JSON 或自行按响应 ID 配对。flatten 子协议会话、业务消费者和文档代际是三种身份。DevTools 触发 detach 是 E39 明示行为，退避重挂无法持有被 DevTools 占用的附着。无界队列与 microtask 持续排空会把慢消费者风险传到主进程。 | 重写 D4-S3。使用 E39 API，先验证实际附着与 OOPIF、导航和 DevTools；每类流设预算及可见的溢出语义，凭据事件异常停用捕获并报告，禁止主进程无界缓存。见 [E39 Debugger](https://github.com/electron/electron/blob/v39.8.10/docs/api/debugger.md)、[CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/)、[CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)。 |
| C6、D1 | 将 Violentmonkey 列为候选符合用户方向。将移植成本判成「平台工作量归零」缺依据。E39 官方扩展面是子集，文档明示 `storage.sync/managed` 未支持，未承诺 `userScripts` 或完整 MV3。社区垫片的存在只证明有可参考代码，不能证明目标版本、权限模型或 WCV 宿主可用。 | 固定候选 commit 与许可，先做能力矩阵和最小扩展验证，再决定是否 fork。扩展/用户脚本 IPC 需要独立 sender、frame、origin、权限检查，禁止借壳获得主进程通用权限。[E39 扩展支持](https://github.com/electron/electron/blob/v39.8.10/docs/api/extensions.md)、[Chrome userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts)、[社区垫片](https://github.com/samuelmaddock/electron-browser-shell)。 |
| D1/D2、F3/F4 | 单 `persist:` 与 Agent isolated 同列为「已定」。共享登录、页面读取、模型请求、普通表单/导航及截图都可能跨信任边界。移除 cookie API 和专用请求工具不足以得出「偷不走数据」。来源标签没有权限强制力。同一主帧 navigationId 也无法保证子帧与像素观察一致。 | 将 Agent 留作后续评审。第一轮只研究隔离测试源中本地只读观测。共享登录态、外部模型数据和动作权限分别审查。独立验证采集来源、数据去向、同文档变化及撤销。参见 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)、[E39 session 权限合同](https://github.com/electron/electron/blob/v39.8.10/docs/api/session.md)、[CaMeL 论文](https://arxiv.org/abs/2503.18813)。 |

## A 与 B · 外壳、工程及标签页

| 位置 | 审计结果 |
| --- | --- |
| A1/A2 | 保留 Vue 3、Pinia 和主进程命令/投影。删掉 Vue 响应式微基准到浏览器端到端性能的推论，以及 3.6 兼容性、Vue 4 迁移成本的保证。官方 changelog 在 11 月 5 日已有 3.5.45，原稿的事实截点与文档日期混用。锁仓版本选自实际构建验证。[Vue 官方 changelog](https://github.com/vuejs/core/blob/main/CHANGELOG.md) |
| A2/B3 | 序号只能发现已知缺口，最后一条丢失、先订阅后快照的竞态、窗口重建及跨窗口移交都需要合同。先用带版本的每窗口快照，遇到实测瓶颈再加 patch；必要时使用流代际、订阅确认、快照水位及再同步。UI 的瞬态交互留在本地。 |
| A3/A5 | Fluent 2 是视觉语言，Chrome/Edge 是交互参照。token 不自动满足 AA，`:focus-visible` 由浏览器启发式决定，Portal 只在所属 DOM 树内工作。Reka/Ark 保持双候选，以焦点、IME、键盘、读屏、强制色和减弱动效行为选型。WCV 浮层需验证可靠的遮挡、焦点恢复、窗口拖动和关闭清理。页面对话框的 Chrome 行为待核。安全提示和 OS 凭据入口须由受信任宿主拥有。[WCAG 2.2](https://www.w3.org/TR/WCAG22/)、[Electron View](https://github.com/electron/electron/blob/v39.8.10/docs/api/view.md) |
| A4/E | TypeScript 和 electron-vite 是合理起点。构建机 Node、Electron 内置 Node 与 Electron ABI 各自锁定。以锁文件及真实自编译产物验证构建、沙箱 preload、E2E 与打包；Rolldown、V8 bytecode、模块裁剪及 WDIO 都可独立评估。原稿同时有 «全收官»、本地探针挂账和 E 区空白，工程闭环缺失。发布至少要有可重复的真实产物门禁，普通 CI 绿色只能证明它实际运行的层。 |
| B1/B2/B4/B5 | 保留 WCV 和已定的 Chrome 式交互目标。把 active/inactive、加载状态、进程资源状态、后台持续出帧资格分开建模。撤销关闭与恢复用实际 E39 `getAllEntries()/restore()`，该 API 已存在且按文档尽力恢复页面状态。应用自存 URL 列表只能当显式降级，不能等价重建完整会话。跨窗口移交按同一 Tab 身份处理，验证失焦、全屏、音频和 Flash 内存态。[E39 NavigationHistory](https://github.com/electron/electron/blob/v39.8.10/docs/api/navigation-history.md) |

## C · 模块逐项处置

| 位置 | 审计结果 |
| --- | --- |
| C1、C1.1–C1.5 | C1 明确重设计包/IR，C1.7 又称合同不变。统一为新合同，87 脚本和素材只作行为需求与回归样本。自证帧表格确实是 E11、150% DPI、单 H5 fixture 的四组结果，应保留为对照。E39 WCV、Flash 内容缩放、跨屏 DPI、GPU 空帧和捕获至点击之间的变化仍需验证。优先记录坐标空间、裁剪原点、目标身份与尺寸代际。颜色在缩放重采样后可能变化，金字塔也是离散搜索，N1–N5 与旋转定位优先级按 Next 样本失效率安排。[已有探针结果](../evidence/self-describing-frame-results.json)、[E39 capturePage](https://github.com/electron/electron/blob/v39.8.10/docs/api/web-contents.md#contentscapturepagerect-opts) |
| C1.6 | 两候选同场比较合理，禁止把 87 的 15% 门槛当 Next 结论。同模型同代适用于控制变量实验，实际产品评估也要比较各运行时最优受支持模型。记录识别成功率、冷/热 p95、内存、并发、体积和授权。 |
| C1.7 | utilityProcess 能隔离失败和支持终止，宿主有 Node 权限。QuickJS/Wasm 候选需测试宿主桥、进程资源限制、挂起宿主调用取消、限流和杀进程后外部动作是否仍在运行。引擎内存上限与 transferable 不覆盖完整 RSS 或 QuickJS 内存到宿主的复制。不要提前承诺毫秒级总开销。[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[QuickJS Emscripten](https://github.com/justjake/quickjs-emscripten) |
| C2 | 先立 Chromium 下载基准，保留用户选定的 aria2 与 IDM 方向。固定 split=16、默认接管和 500ms 都需重新测量。维持原分区，认证/POST/blob/特殊代理优先原生处理。交接须定义去重、失败、用户控制、凭据流和恢复。IDM 官方有 CLI，CLI 不能证明原生宿主协议、可直连性或管理器对暂停/进度的可观测性。[IDM 命令行文档](https://www.internetdownloadmanager.com/support/command_line.html)、[E39 DownloadItem](https://github.com/electron/electron/blob/v39.8.10/docs/api/download-item.md) |
| C3 | 保留 locale 单权威、共享词典、key 与插值参数校验。主进程用可独立运行的翻译入口。Vue I18n 的消息语法需按官方定义，不能等同 ICU MessageFormat。C3 的一律拒绝 prerelease 和 A4 同仓渠道语义冲突，统一按产品线、显式内测开关及版本元数据选资产。[Vue I18n 消息语法](https://vue-i18n.intlify.dev/guide/essentials/syntax.html) |
| C4 | 除 API 硬错误外，旧版密钥层设计应按 Next 备份、恢复、重授权实际需求选。门禁在取明文前，读取失败不改密文或包裹密钥。迁移和 OOPIF 凭据捕获单独验收。外部凭据存储、验证码和浏览器配置目录都不能用「查看门禁保留」一句代替数据边界。 |
| C5 | SQLite 是合理候选，「Chrome 全线 SQLite」为错误理由。Chromium 偏好用 JSON，历史存在 URL 和 visit 实体且有 90 天清理政策，这些只支持特定比较。保留用户选的业务库方向，表结构按查询与迁移定。明确 90 天与旧 5000 条的冲突、书签树状态冲突、删除范围、跨文件备份一致性及阻塞预算。同步 DatabaseSync 在主线程会阻塞，单写者可位于独立存储执行环境。[Chromium Prefs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/prefs/)、[Chromium 历史实现](https://chromium.googlesource.com/chromium/src/+/f0909821f41ff79e3a7a650cabd94e7d9db24257/components/history/core/browser/history_backend.cc)、[Node SQLite](https://nodejs.org/download/release/v22.22.1/docs/api/sqlite.html)、[SQLite Online Backup](https://sqlite.org/backup.html) |
| C6 | 除核心扩展缺口外，分别验证 worker 重启、权限撤销、脚本匹配与运行时机、frame 隔离、GM 值持久化、卸载、离线更新。CRX 解包和 Web Store 兼容推后；未验证原生消息协议前保留独立 IDM 评估。CSS Fixer 仅在 Next 重现可复用站点问题时重新立项。 |
| C7 | 保留双引擎、显式手动切换、站点规则确认和本地 Ruffle。Chromium 87 的 UA、插件版本通告、mms.cfg、SWFObject、CORS 和私有资源路径都由 142 站点对照决定。PPAPI 兼容率不能推出 Ruffle 对所有失败无用。Modern 已暂缓，以 A4 的后期裁决为准。 |
| C8 | 自建 chii 退役是合理方向，保留原生 DevTools。去掉远程调试端口只能消除该监听面，CDP 调用面仍需最小化。捕获常驻附着、重放和域仲裁应等第二个真实消费者出现后扩展，先交付确定的暂停与恢复行为。 |

## D、E、F · 横切风险和排期

Firefox 的官方 profile 资料也给出了一个有用的对照。历史、书签和下载列表共享 `places.sqlite`，保存的登录信息及密钥分布在 `logins.json`、`key4.db`。这个例子支持按恢复和访问边界划分数据。Firefox 的实现不足以证明 Next 应采用同一套密钥策略，分文件本身也不提供访问隔离。 [Mozilla 的 profile 文件说明](https://support.mozilla.org/en-US/kb/about-your-important-data-and-their-files)

- **D1** 异步 IPC 和 schema 校验保留。每个 handler 增加 sender、frame、窗口、角色、资源归属验证。进程错误映射稳定代码和经裁剪的详情，任意 `cause` 可能带出路径、URL 或敏感数据。主进程持有业务权威，磁盘、OCR、Wasm 与视频工作按测量隔离。
- **D2/D3** 区分 Next 个人浏览分区、内部 UI 会话和未来临时自动化分区。同仓发布应使用独立 profile 与自定义备份。按角色定义浏览数据清理项目，不能只调用 `clearStorageData` 就声称清除所有类别。日志和本地转储处理访问控制、保留期和导出，转储可能含进程内存。关闭或崩溃恢复不能依赖一次未确认的异步 flush。
- **D4** 保留唯一附着所有者、目标显式绑定、失效即报告、禁止跨代重放副作用。事件消费放在有界调度中，协议响应和生命周期控制要有独立的低延迟路径。把 Tab ID、WebContents 绑定、附着代际、frame/document 代际分别命名。按命令具体副作用治理，共享一个 CDP 域名不足以证明可并发。
- **E** 建议先用一个应用包和明确进程入口，内核补丁及产物由可追溯的清单消费。是否同仓独立分支遵循仓库决策记录，不为暂缓的 Modern 设多产品工程。
- **F0–F1** 审计接受用户希望 Agent 参与 Flash 视觉与工作流的产品方向。「执行面 90% 就绪」混用了 E11 资产、Next 待开发合同和市场类比，应撤掉。采用局部可验证的接口，Agent 安全设计单独评审。
- **F2/F2′** 事件驱动、UI 停止入口与限额是可取思路。撤销要覆盖待审批、待执行、进行中和已提交的区分，watchdog 停滞不能同时是可恢复和永久终态。帧缓冲成本包含截图、编码、传输及峰值内存，录制应默认关闭且留存有上限。保留事件时间与实际采样时间，假设的 8–15fps、60 秒、JPEG 体积和会话数都是待测值。
- **F3–F6** 页源标签、站点名单和工具枚举只能作为纵深防线。同文档快照应标各采集时间及 frame/document 身份，不能承诺 DOM、无障碍树和像素原子一致。下游 Adapter 是否发送、保留或再利用结果是独立边界，HTTP 兼容也不等于工具语义一致。上线前应能在本地 fixture 以确定性方式测试权限失效、敏感数据裁剪、停止与负载异常。
- **F7** 三条渲染 PR 分别评估。B 级候选中的透明无边框窗口、offscreen DPI 和 macOS 遮挡场景只在使用相应拓扑或平台时有意义。新补丁进入版本清单须记录失效条件、依赖及回归。Adobe 已结束 Flash 支持，原生播放器的分发权与内核构建成功需分别确认。[Adobe EOL](https://www.adobe.com/products/players/flash-player-distribution.html)

## 文档治理

顶部状态仍说下一议题是 A，而 A4/D/F 已写收官。A3 的候选与结案摘要散落，C7 有后续更正，C3 与 A4 更新规则冲突，C2 同时写待裁决和结案。C4 引用的 C9 在本文不存在。ADR 0002 的更新声明推翻了正文 E37 推荐，其构建、隔离、排期仍保有旧结论。后续应由一份短架构文档提供可执行基线，既有历史留作证据，决策变更以明确的取代关系记录。技术依赖标 tag 或 commit，实测标二进制和配置，只有对应范围通过才标记为实测。为避免将本次审计建议冒充用户批复，ADR 与原稿保留原样。
