# BaoFlashBrowser 分批修复与改进计划

> 执行状态（2026-08-02）：工程、IPC、Ruffle、密码、下载、测试发布、会话恢复、本地 SWF、诊断中心和 Toast 批次均已落地。后续稳定性批次又增加 BrowserView 代际防护、动态密码框填充、密码捕获专用 CDP binding、敏感 URL 最小化、串行数据持久化、可选标签休眠、aria2 定位/RPC 拆分与动态端口。Windows x64/ia32、Linux x64 CI 检查和真实打包均通过；4399 奥拉星已由用户确认可正常游玩。

## 目标

在不升级 Electron 11.5.0、不破坏既有 Flash 兼容行为的前提下，将项目收口到可类型检查、可构建、可测试、可诊断和可发布的状态，再逐步改善数据一致性、安全边界和用户体验。

## 不可破坏的架构约束

1. Electron 固定为 11.5.0 / Chromium 87，继续使用 BrowserView 承载网页标签。
2. PPAPI 标签保持 `contextIsolation: true, plugins: true`；Ruffle 标签保持 `contextIsolation: false, plugins: false`。
3. Ruffle 保留 `sendSync` 获取脚本并在页面上下文执行的已验证链路；不以理论上的异步加载方案替换。
4. Ruffle 同时保留 bundled 与 CDN `latest`，后者作为项目无人维护时的逃生通道；只增加诊断、提示和回退操作。
5. 密码库无论锁定与否都可以检测登录提交；新增的自动捕获设置默认开启，关闭时才真正停止 CDP attach 和脚本注入。
6. 不引入 keytar、Argon2 等需要额外原生构建或依赖桌面密钥服务的模块。
7. 非活动 BrowserView 和 React 新标签页共存时，继续通过屏外 bounds 隐藏 BrowserView，防止原生内容层遮挡 React UI。
8. 导航前必须 teardown CDP 捕获；`did-stop-loading` 后允许重新 attach；`did-fail-load` 不得调用 `stop()`。
9. `defaultSession` 与 `persist:` session 都必须安装站点兼容和下载处理器。

## 批次 1：工程基线

### 改动

- 统一 typesafe-i18n 输出到 `src/renderer/i18n`，移除错误生成链路并修复字典键漂移。
- 拆分 main、renderer、main preload、BrowserView preload 的 TypeScript 检查环境。
- 统一 DownloadEngine、标签操作、密码 IPC 等共享类型。
- 修复当前主进程与 renderer 类型错误，减少不必要的 `any`。
- 修复 esbuild 构建失败仍返回成功的问题，整理重复的 i18n 脚本。
- 增加 `typecheck` 和 `check` 命令。

### 验收

- `npm run i18n` 输出位置稳定，连续运行不制造额外目录。
- `npm run typecheck` 通过。
- `npm run lint` 零错误。
- `npm run build` 通过，主进程构建失败时命令返回非零状态。

## 批次 2：IPC、配置与数据一致性

### 改动

- 使用现有 Zod 依赖为 IPC 输入增加运行时校验，统一成功/失败返回结构。
- 将通用字符串 IPC 逐步收口为领域 API，并对敏感日志脱敏。
- 合并 themeMode 等重复配置来源，落实或移除无效设置项。
- Dexie 写入从 `clear + bulkPut` 改为增量写入或事务替换，避免并发覆盖与中途清空。
- 为数据库版本升级、迁移失败和备份恢复建立明确流程。

### 验收

- 非法 IPC 参数被拒绝且不会触发主进程操作。
- 收藏、历史、下载和设置在并发更新与重启后保持一致。
- UI 中不存在保存后不生效的设置。

## 批次 3：Flash、Ruffle、密码捕获与标签生命周期

### 改动

- 将 BrowserView 创建、布局、导航、事件和销毁职责拆分，但不改变实际运行顺序。
- 集中定义屏外隐藏 bounds，并防止旧 WebContents 的晚到事件覆盖新视图状态。
- 为 Ruffle 现有加载链路增加版本、来源、哈希、初始化阶段和失败原因诊断。
- CDN `latest` 失败时提供“切回 bundled 并重试”，不静默替换用户选择。
- 新增密码自动捕获开关和排除网站设置，默认保持自动捕获。
- 修复 CDP iframe 补扫计时器，PBKDF2 改为非阻塞实现。
- 收窄 crossdomain.xml、SWF CORS 和站点补丁到可配置兼容规则。

### 验收

- PPAPI/Ruffle 切换、刷新、前进后退和 JSONP 登录不冻结。
- 打开网页后新建 React 新标签页，全部区域可交互；切回网页 bounds 正确恢复。
- 密码库锁定时仍可捕获；关闭自动捕获后不 attach debugger。
- Ruffle 失败时能区分脚本、组件、WASM 和资源加载阶段。

### 已完成（2026-08-02）

- `ruffle-resource://` 同时注册到 `defaultSession` 与 BrowserView 使用的 `persist:` session，并在创建窗口和标签前完成注册；修复脚本执行后核心 JS/WASM 因 session 中无协议处理器而显示“组件无法加载”的根因。
- bundled Ruffle 记录版本、字节数和 SHA-256；页面侧上报脚本、CDN、运行时与组件失败阶段。
- CDN 失败时在地址栏错误提示中提供“切回内置版并重试”。
- 新增 Electron 11 + `persist:` BrowserView Ruffle 测试，已验证核心 chunk 与 WASM 均成功加载。
- 密码捕获支持域名排除列表，覆盖目标域名及子域名，修改后立即卸载或恢复已打开标签的捕获器；重置密码数据时保留捕获偏好。

## 批次 4：下载系统

### 改动

- 拆分 aria2 二进制发现、进程、RPC、下载适配器和协调器。
- 主进程成为下载状态唯一来源；高频进度节流持久化。
- 支持中断状态恢复、同名文件处理、临时文件与完成后原子改名。
- 强化真实路径、符号链接、Windows 保留名和主动内容文件检查。
- 同步文件操作改为异步；退出时完整释放 aria2 与轮询任务。

### 验收

- bundled aria2、系统 aria2、Chromium fallback 三条路径均通过测试。
- 暂停、恢复、取消、删除和重启后的状态一致。
- 无法通过路径穿越或链接绕过下载目录边界。

### 已完成（2026-08-02）

- 新增主进程下载任务账本，所有进度先合并并持久化，再向 renderer 广播；活动任务按 1 秒节流写入，终态立即写入。
- 启动时将遗留的下载中/暂停任务规范化为已中断，并与原有 Dexie 历史记录做一次迁移合并。
- 已中断 aria2 任务可使用原 URL、目录和文件名重新提交，依靠 aria2 control file 续传；Chromium 任务以原记录 ID 安全重试，存在完整目标文件时自动换名，避免覆盖。
- 删除记录和清理已完成记录同步更新主进程账本；暂停任务不会被“清理已完成”误删。
- renderer 的 Dexie 下载进度持久化改为 1 秒节流，完成、取消、中断和删除仍立即写入。
- 已增加重启状态规范化和增量进度合并单元测试。

## 批次 5：测试、CI 与发布

### 改动

- 建立 Vitest 单元测试与本地兼容站点 fixture。
- 建立 Electron 11 + BrowserView 冒烟测试，不用 BrowserWindow 或现代 Electron 替代。
- 覆盖导航前 teardown、跨域 iframe、JSONP、Ruffle 重建、崩溃隔离和新标签遮挡。
- 添加 Windows/Linux CI；按目标平台裁剪 PPAPI、aria2 和 mouse hook 资源。
- 生成构建清单、校验二进制架构与关键资源完整性。

### 验收

- `npm run check` 在本地和 CI 通过。
- Windows x64、Windows ia32、Linux x64 产物只包含对应平台资源。
- 安装包内 PPAPI、Ruffle、aria2 与 preload 文件均可被启动自检发现。

### 已完成（2026-08-02）

- 构建前清空 `dist`，修复 Ruffle 被错误复制到 `dist/dist/lib/ruffle`、旧文件掩盖全新构建失败的问题。
- electron-builder 改用独立配置和精确文件集，不再遍历或打包整个工作区；Ruffle 改为构建期依赖，避免 npm 模块重复进入成品。
- Windows x64、Windows ia32、Linux x64 按目标裁剪 PPAPI、aria2 和 mouse hook；ia32 因无兼容 aria2 明确使用 Chromium 后备下载。
- 修复打包后 mouse hook 仍从 `app.asar` 所在应用目录查找的问题，改为从 `process.resourcesPath` 加载。
- 新增 PE/ELF 架构、Ruffle JS/WASM/字体、preload、运行时依赖、外来平台资源和安装包 SHA-256 校验，清单写入 `release/manifests/`。
- Windows x64 与 ia32 NSIS 已在本机真实生成并通过解包校验；Linux 解包目录通过校验，AppImage 因 Windows 缺少符号链接权限留给 Ubuntu CI 原生构建。
- CI 在 Windows/Linux 执行累计检查与 BrowserView 冒烟测试，并增加 Windows x64、Windows ia32、Linux x64 的真实打包作业。

## 批次 6：产品增强与最终回归

### 候选功能

- 站点兼容规则管理与导入导出。
- 本地 SWF 启动器和游戏库。
- 会话恢复、标签内存释放和错误恢复页。
- 兼容性诊断中心与脱敏诊断包。
- 收藏、设置和加密密码库备份。

### 验收

- 在 61.com、4399、7k7k 和本地 SWF fixture 上完成真实回归。
- 明确记录 Windows、Linux、WSLg 的已验证功能与限制。
- 发布说明包含 Chromium 87 / Flash 的安全边界。

### 已完成（2026-08-02）

- 新增默认开启的异常退出恢复：运行期间持续保存最多 20 个经过校验的 HTTP、HTTPS、本地 SWF 或新标签页；正常点击 X、Alt+F4 或系统关闭后下次启动为空白会话，仅在崩溃、断电或强制结束后通过 Toast 询问是否恢复，并保留引擎、缩放、静音和活动标签状态。
- 新增本地 SWF 文件选择入口，文件路径通过主进程转换为安全的 `file:` URL 后在新标签打开。
- 新增一键导出的 JSON 诊断报告，包含 Electron/Chromium/Node 版本、组件存在性、大小、SHA-256 和最近日志；用户目录、URL 参数、账号口令与令牌会被脱敏。
- 新增 Electron 11 本地双源兼容性 fixture；由此发现并修复两个 `onBeforeRequest` 监听器互相覆盖、`crossdomain.xml` 补丁失效的问题，同时验证 SWF CORS 与淘米 SWFObject 重定向。
- 增加标签快照损坏/超量/危险 URL 和诊断脱敏测试，CI 同步执行兼容性 fixture。
- 外部 61.com、4399、7k7k 访问被本轮浏览器安全策略拒绝，未绕过；手工回归步骤和 Chromium 87 / Flash 安全边界记录在 `docs/FINAL_REGRESSION.md`。

## Toast 专项修复（2026-08-02）

### 已完成

- 将 Toast 队列策略和显示组件从 `TopBar` 中拆出，统一默认时长、持久通知、关闭原因、错误优先级、同键去重和最多 20 条的积压上限。
- 有时限的通知显示底部消失倒计时；鼠标停留时倒计时和实际关闭定时器同步暂停，移开后按剩余时间继续。
- 支持点击通知主体和独立 X 按钮关闭，不增加全局键盘快捷键。
- 退出动画改为单向收起，操作按钮被点击后立即开始关闭；异步保存不再阻塞原通知消失，失败时另发错误通知。
- 密码提示被手动关闭时会明确忽略本次捕获，保存和忽略不会遗留待处理记录；重复站点提示会替换而不是持续堆积。
- 下载、Ruffle、页面加载和崩溃通知使用稳定键去重；下载开始通知移出状态更新函数，避免嵌套状态写入。
- 修复页面错误码出现双负号，并防止旧通知的定时器或退出回调误删下一条通知。

### 验收结果

- Toast 队列与交互共 8 个专项测试通过，覆盖时长、持久显示、去重、优先级、队列上限、两种关闭方式、悬停暂停、异步操作和定时器竞态。
- 全量 `npm run check` 通过；23 个单元/组件测试全部通过。
- Electron 11 BrowserView、Ruffle session 和站点兼容性三组冒烟测试通过。

## 执行纪律

- 每批开始前记录 Git 状态，不覆盖无法确认归属的本地改动。
- 每批完成后先运行该批检查，再运行累计回归。
- 高风险兼容行为先在与生产一致的 BrowserView Demo 中验证，再移入主项目。
- 不为消除警告改变已经验证过的 Flash、Ruffle 或 CDP 行为。
- 每批使用独立提交边界，便于回滚和定位兼容回归。
