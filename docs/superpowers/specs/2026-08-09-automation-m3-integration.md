# 自动化 M3：主程序接入边界

## 本阶段结果

M2 的截图、OpenCV 识别和 CDP 输入链已接入主程序生命周期。自动化现已作为正式功能默认启用；开发验证时使用：

```powershell
npm start
```

独立 Blockly 工作台现可直接导出 `.baoauto`，其中包含 `manifest.json`、`workflow.json` 和扫描到的 `assets/` 素材，导出结构与主程序加载器一致。

主窗口 preload 暴露以下受控能力：

- `automation.capabilities()`：读取功能开关和运行状态。
- `automation.validateWorkflow(workflow)`：仅校验 JSON 工作流，不执行。
- `automation.openPackage()`：通过系统文件选择器打开 `.baoauto`，renderer 不能传任意路径。
- `automation.checkReady(packageId, tabId)`：识别脚本的生效前提，成功后保持 ready。
- `automation.start(packageId, tabId, countdownMs)`：立即或倒计时执行。
- `automation.cancel()`：取消当前执行并释放资源。
- `automation:status-changed`：状态变化通知。

## 生命周期与安全约束

- 只允许操作当前活动且仍然存活的 BrowserView；切换标签或引擎重建后立即拒绝后续动作。
- 脚本运行期间暂停该页密码捕获，结束后按原配置恢复。
- `password-capture` 与 `automation` 共享显式 CDP 租约，不能互相抢占或误 detach。
- 页面导航期间仍遵守 TabManager 的 debugger teardown 规则；脚本占用期间 `did-stop-loading` 不会重新挂载密码捕获。
- `.baoauto` 压缩包选择限制为 32MB，解压后继续沿用 64MB、1200 文件、安全相对路径和引用完整性校验。
- OpenCV worker 在会话结束时关闭，模板和截图只保留在当前进程内存。

## 后续 UI 接入

正式工作台页面应先读取 `capabilities()`，再展示包导入、就绪灯、倒计时和停止按钮。M1 Blockly 工作台的 JSON 生成器可以直接对接 `validateWorkflow`；项目目录打包与素材热更新仍保持在独立工作台，避免给主窗口任意文件系统权限。
