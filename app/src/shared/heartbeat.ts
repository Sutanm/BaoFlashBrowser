/**
 * 外壳渲染线程心跳的通道名（主进程 ↔ 外壳 preload）。
 *
 * 方向固定：主进程 `send(ping, seq)` → 外壳 preload 在**渲染线程**上回 `send(pong, seq)`。
 * 回执走渲染线程这件事本身就是测量原理：线程被长任务占住时回执发不出去，主进程侧测到的
 * 往返时间就等于被阻塞的时长（2026-11-25 演示 §7.7-1 实测：空闲 2 ms / 阻塞 402 ms）。
 *
 * 只有外壳文档带这个 preload；页面视图与浮层 guest（共享进程模式下拿不到 preload）都不会回，
 * 所以主进程不需要额外校验发送者身份。
 */
export const heartbeatChannels = {
  ping: 'bao:heartbeat:ping',
  pong: 'bao:heartbeat:pong'
} as const
