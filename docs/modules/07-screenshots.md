# 07 · 截图系统

## 1 范围与目标

提供安全、可审计的页面截图能力：
- **内部截图**：UI/快捷键/自动化请求 → `capturePage` 取标签内容 → 目标目录写入（路径门禁）；
- **调试 HTTP 口**：唯一可对“正在运行的实例”发截图的入口，loopback + header 令牌 + POST-only；
- **自动化视觉**：在 03 的截屏流程复用（同一 capture 管线）。

**边界**：绝不截整窗（宿主 UI 泄漏）；跨项目避免域外的 `files://` 读取。

## 2 静态结构

| 文件 | 职责 |
|---|---|
| `src/main/modules/screenshot.ts` | 截图核心：`captureTabPng/captureTabJpeg`、`sanitizePath`、`assertPathWithinRoot`、保存/清理逻辑 |
| `src/main/modules/screenshot-http.ts` | 调试 HTTP 服务：绑定 127.0.0.1:44123，`X-BAO-Token` header 校验，`POST /screenshot {save}` |
| `src/main/ipc/screenshot.ipc.ts` | 渲染层截图 IPC（save/full/selection） |
| `src/renderer/.../screenshot` hooks | 快捷键 + 十字瞄准框（selection 区域） |

## 3 核心流程

### 3.1 内部截图

```
shortcut 或 自动化 → screenshot.ipc → captureTab(savePath?)
  ├─ 当前活动的 BrowserView wc.capturePage()
  ├─ sanitizePath(用户填路径) + assertPathWithinRoot 绝对路径守卫
  ├─ toPNG 写盘（默认用户图片目录/截图子目录，日期命名）
  └─ download 或 toast 通知
```

- full-page: 页宽 + scrollHeight 计算，多段拼接（浏览器内部锯齿限制）；selection：renderer 十字框坐标 → 裁剪原图。
- 失败路径（无焦点/页面崩溃/路径被拒）→ error IPC + toast。

### 3.2 调试 HTTP 口

```
curl.exe -X POST http://127.0.0.1:44123/screenshot -H "X-BAO-Token: <hex>" -d '{"save":true}'
  ├─ BAO_SCREENSHOT_HTTP=1 才监听（dev 专用；packaged 永不 listen）
  ├─ token 生成写 %APPDATA%\bao-flash-browser\logs\main.log
  ├─ 校验 header 令牌 + POST + loopback
  └─ 无 BrowserView（newtab/userscripts/automation 页）→ NO_TAB 错误
```

设计细节见 `docs/superpowers/specs/2026-08-07-screenshot-design.md` §调试 HTTP 口子。

### 3.3 自动化复用

自动化 driver 的 `capture`/`waitOutput` 走 `screenshot` 模块裁剪/比对，保证同一门禁与路径语义（见 03 §3.1）。

## 4 数据模型与接口

- `SaveScreenshotOptions：{ path?: 绝对路径, type: 'png'|'jpeg', quality?: number }`。
- IPC：`screenshot:save / screenshot:full / screenshot:selection`（zod 校验路径 + 白名单）。
- HTTP 响应：`{ ok, savedTo?, error?, tabId }`。

## 5 安全边界与不变量

- **路径两重守卫**：`sanitizePath` + `assertPathWithinRoot`（root = userData 配置的截图根），越权拒。
- 只截活动标签内容，**不混宿主 UI**（复用 01 的 bounds）。
- HTTP 口：loopback + token header + POST-only + dev-only 环境变量；无 token 统一 401/403。
- 调试口返回的 token 位置以文档为准，不写进版本库。

## 6 兼容性

- Ruffle 页可截图（composite 正常）；PPAPI inset 页面可能有插件 overlay 差异，以 capturePage 准。
- DPI 缩放差异：截图尺寸基于 devicePixelRatio，selection 坐标须按 ratio 换算。

## 7 测试策略

- Electron smoke：`tests/electron/screenshot-smoke.cjs`（PPAPI 页面 + selection/htt 口冒烟）。
- HTTP 口（dev 构建 + BAO_SCREENSHOT_HTTP=1）连跑 `curl` 返回合法 PNG；无 token 拒绝断言。
- 单测：`sanitizePath/assertPathWithinRoot` 用例（绝对路径、`..`、外越权）。
- 探针：`05-games`（可截图且控制台无泄漏）可选。

## 8 雷区与注意事项

1. 只 `capturePage`，**不截整窗**。
2. debugger 附着时截图可能冻结渲染——截图前释放租约（03/05 的 CDP 互斥）。
3. 多显示器/负坐标：cropping 前归一 coord。
4. 无 BrowserView 的内部页返回 NO_TAB 而非静默空图。

## 9 演进建议

- HTTP 口当前写盘明文 PNG；可加 `base64` 响应模式方便 AI 自动化（不落盘）。