# BaoFlashBrowser 1.1.2 回归基线

> 记录日期：**2026-11-04**。取代 `docs/archive/releases/1.1.1-regression-baseline.md`。
> 本文只记录**本轮真实执行过**的结果；未执行的项明确标注，不沿用旧版数字。
>
> 环境：Windows 10.0.26300（win32 x64）、Node v22.22.2、Electron 11.5.0（项目固定）。
> 工作树包含本次文档重写改动；产品代码与 1.1.2 发行提交 `4078b54` 一致。

## 1 自动化结果

| 命令 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `npm run check`（i18n + typecheck×3 + lint + unit + build） | **通过** | 1m56s | 整体退出码 0 |
| `npm test -- --run`（unit，check 内） | **128 文件 / 812 用例全通过** | 15.36s | Vitest 报告；无 skip/fail |
| `npm run test:smokes`（Electron smoke） | **10 个套件全部 ALL PASS** | 37s | values-persistence ×2、gm-capacity、userscripts-update、menu-command-dedupe、userscripts-cookie、userscripts-web-request、background-script ×2、renderer-csp |
| `npm run test:integration` | **4 文件 / 20 用例全通过** | 4.07s | 含 Paddle 侧车 1 例、Tesseract 侧车 1 例、BAO1 协议 4 例、OpenCV vision-worker 14 例 |
| `npm run test:e2e`（Playwright） | **8/8 通过** | 1m18s | app-shell×4、download-settings、first-run-language、proxy-settings、settings-persistence |

补充说明：

- Paddle 与 Tesseract 侧车是**真实子进程**运行：Paddle 用 BGRA 内存帧识别（1505ms），
  Tesseract 识别中文与数字并处理空帧（1584ms），不是 mock。
- e2e 每条用例都会启动真实 Electron 11；`first-run-language`、`proxy-settings`、
  `settings-persistence` 走重启流程。
- `npm run build` 在 check 内成功：main 模块集合
  `core,userscripts,automation,passwords,screenshot,download,diagnostics,memory-monitor,js-patch`，
  renderer 1983 modules，`bundle.js` 496.12 kB（gzip 154.55 kB）。

## 2 制品与校验

以下制品的 SHA-256 取自仓库内 `release/SHA256SUMS-1.1.2.txt`，**本轮没有重新执行
electron-builder 打包**，因此大小与哈希代表 2026-11-02 的既有产物。

| 平台 | 文件 | 字节数 | SHA-256（前 16 位） |
| --- | --- | --- | --- |
| Windows x64 | `BaoFlashBrowser-OCR-1.1.2-x64.exe` | 157,931,247 | `9257a09da20780eb…` |
| Windows ia32 | `BaoFlashBrowser-OCR-1.1.2-ia32.exe` | 94,914,353 | `40658563dfe128c3…` |
| Linux x64 | `BaoFlashBrowser-1.1.2-x86_64.AppImage` | 246,678,838 | `6616eee0a7319d08…` |

完整哈希与 unpacked 清单在同目录 `SHA256SUMS-1.1.2.txt`。macOS 仍是独立实验通道，
不包含在本次正式制品中。

## 3 相对 1.1.1 基线的变化

- 正式包由"标准版 / OCR 版"二选一，变为**三个平台默认都内置 OCR**：Win64/Linux 用
  Paddle PP-OCRv3，Win32 用 Tesseract 5.3.0 x86。
- 新增全局代理与连接诊断、aria2 代理路由、统一下载目录、手动稳定版更新检查、
  原生自动化助手、首次启动语言选择、主题同步。
- e2e 从 4 条扩到 8 条，新增下载设置、首次启动语言、代理设置、设置持久化/重启。
- unit 层规模从 1.1.1 时的"未固定记录"到本轮 **812** 用例；旧版刻意不写数量，
  本文按实际报告记录，后续版本应重新跑并覆盖本表。

## 4 未自动覆盖 / 人工门

以下项目**本轮未验证**，不能据本文声称通过：

| 项目 | 原因 | 建议 |
| --- | --- | --- |
| 真实 PPAPI 游戏渲染、识图、可信点击 | 需要人工打开真实游戏 | 按 03 的发布前人工门执行 |
| 4399 登录表单、7k7k JSONP 换账号捕获 | 依赖真实站点与账号 | 按 05 的真机回归清单执行 |
| 真实网络下的系统代理 / PAC / 绕过 | e2e 用隔离 session，不触外网策略 | 用真实代理环境手工验证 |
| 代理不可达时 aria2 → Chromium 回退 | 需要构造失败网络 | `probe:deep --only 26-aria2-proxy` + 手工断网 |
| macOS 实验包 | 需要 macOS 硬件 | 独立手动工作流 |
| Linux 实机图形/FUSE | 本轮只在 Windows 执行 | CI 或 WSL/Linux 复跑 |
| 真实 32 位 Windows | 无该环境 | 已知限制，见发行说明 |

## 5 已知瑕疵与噪声（不影响本轮判定）

1. `renderer-csp` smoke 曾报
   `Error occurred in handler for 'theme:set-source': No handler registered`（fixture 只
   加载渲染层文档却没注册主题 IPC）。**已修**：fixture 补上 `theme:set-source`、
   `ui:set-language`、`app:version` 桩，并新增断言「渲染层启动期调用的每个通道都有桩」，
   现为 9 项检查全 PASS。将来新增启动通道时该断言会直接失败，而不是只在日志里刷一行。
2. unit 日志里的 `[password-store] wrap key unavailable … decrypt-failed` 来自使用
   假后端的单测，按 05 的说明属于**测试噪声**，不是真机密钥故障。
3. 构建有 Vite 的 "chunks larger than 500 kB" 警告（Blockly 编辑器 768 kB），
   属于已知体积提示，不影响构建成功。

## 6 复跑方式

```bash
npm run check            # i18n + typecheck + lint + unit + production build
npm run test:smokes      # Electron smoke（会先 ensure:smoke-bundles）
npm run test:integration # 重型：OpenCV worker + Paddle/Tesseract 侧车
npm run test:e2e         # Playwright（需先构建）
```

要更新本文时，以新一轮实际输出为准，覆盖第 1 节的数字，并在页首更新记录日期；
不要保留过期数字"以示连续"。
