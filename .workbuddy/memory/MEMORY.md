# BaoFlashBrowserNext 项目长期记忆

## 架构决策（不可翻案清单）

- **`webContents.clone()` 方案已否定（2026-11-25）**：clone 复用源渲染进程，与 Flash（PPAPI）单实例、Ruffle 按页面会话注入（bindRuffleProtocol）正面冲突，是语义破坏不是优化项。不再作为 duplicateTab / tearoff / 内存优化的实现路径。已记录于 docs/discussions/2026-11-25-electron-patch-backport-audit.md。
- 进程模型实测（11-25 探针 probe-site-processes.js）：每个 WebContentsView 独占渲染进程、同站不合并；空页面 renderer 69–72 MB working set；`webContents.clone()` 同站复用进程（但被上述决策否定使用）。
- 内存优化路径：`--process-per-site` / `--renderer-process-limit=N` 开关对照实验优先（0 风险）；飞窗优化走 预热前移 + overlay-ready 就绪判定 + 隐藏期节流/冻结。

## 关键事实

- Electron 39.8.10；飞窗/浮层共用单一 WebContentsView（panel/quick/toast 共用，见 app/src/main/shell-overlays.ts）；预热三档 auto/always/never（默认 auto）。
- 打开耗时基线：预热后 20–25ms，冷启动 ≈260ms；dev 态走 Vite dev server 明显更慢，度量须在打包态做。
- Ruffle 资源协议按页面会话绑定（browser-window.ts bindRuffleProtocol）——任何共享渲染进程/会话的方案都要先过这道约束。
