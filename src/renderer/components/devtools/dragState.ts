/**
 * 抽屉拖拽中的全局标记。
 *
 * 拖拽时 `setDevToolsBounds` 要换成同步 IPC：异步 IPC 会让原生视图的更新落到
 * 下一帧，快速拖拽时每帧位移几十像素，视觉上就是"内容慢半拍再突然跳一下"。
 * 只有拖拽期间需要这个代价（同步 IPC 会阻塞渲染线程），其它场景（窗口缩放、
 * 停靠切换）继续走异步。
 */
let dragging = false;

export function setDevtoolsDragActive(active: boolean): void {
  dragging = active;
}

export function isDevtoolsDragging(): boolean {
  return dragging;
}
