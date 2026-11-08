/**
 * 内置开发者工具箱的主进程入口（门面）。
 *
 * 实现按职责拆到：
 *  - devtoolbox-collector：控制台 / 主进程日志采集与批处理推送
 *  - devtoolbox-frontend-server：DevTools 前端静态资源、file:// 白名单
 *  - devtoolbox-target-resolve：tab ↔ CDP target 绑定与前端 URL 解析
 *  - devtoolbox-host：内嵌 BrowserView / 独立窗口承载
 *  - devtoolbox-probe-page：页面 Flash 浅探 + CDP 深探
 *  - devtoolbox-snapshot：快照（日志、targets、Flash、CDP 占用者）
 *
 * 刻意**不 attach CDP**：互斥只发生在 embedded client 之间——Electron 的
 * `webContents.debugger` 一个 WebContents 只能挂一个，密码捕获长期持有、
 * 自动化按短租约排队、password-fill 会几十毫秒裸 attach，工具箱再挤进去
 * 就会撞出 "already attached by an unmanaged client"（2026-09-22 事故）。
 * 远程 ws 客户端（抽屉 DevTools 前端的 page-ws）与 embedded 实测共存。
 */

export { initDevToolbox, clearDevToolEntries } from './devtoolbox-collector';
export {
  DEVTOOLS_PARTITION,
  getDevToolsFrontendDir,
  installDevToolsFileGuard,
  shutdownDevToolsFrontendServer,
} from './devtoolbox-frontend-server';
export {
  getDevToolsTargetUrl,
  resolveActivePageTargetId,
  resolveTargetId,
} from './devtoolbox-target-resolve';
export {
  attachDevToolsView,
  closeDevToolsWindow,
  destroyDevToolsView,
  getDevToolsFrontendContents,
  openDevToolsWindow,
  setDevToolsViewBounds,
} from './devtoolbox-host';
export { probeActivePage } from './devtoolbox-probe-page';
export { getDevToolSnapshot, openNativeDevTools } from './devtoolbox-snapshot';

// 端点查询已抽到 devtoolbox-targets（打断与 devtoolbox-bridge 的循环依赖），
// 这里保留同名导出，外部引用（ipc / 探针风格调用）不用跟着改。
export { listDebugTargets, resolveDebugPort } from './devtoolbox-targets';
