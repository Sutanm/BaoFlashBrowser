/**
 * 页面视图登记表（架构 §3 IPC「校验发送者身份」）。
 *
 * Ruffle 运行时与网络 broker 都只服务**页面视图**，外壳（受信任 UI）一律不放行。
 * preload 在文档提交前执行，此时 `getURL()` 还是空的，所以按 WebContents id 判定，
 * 而不是按 URL。
 */
const pageViewIds = new Set<number>()

export function registerPageView(contentsId: number): void {
  pageViewIds.add(contentsId)
}

export function isPageView(contentsId: number): boolean {
  return pageViewIds.has(contentsId)
}
