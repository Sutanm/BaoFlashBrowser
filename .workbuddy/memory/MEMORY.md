# BaoFlashBrowserNext 项目长期记忆

## 架构决策（不可翻案清单）

- **`webContents.clone()` 方案已否定（2026-11-25）**：clone 复用源渲染进程，与 Flash（PPAPI）单实例、Ruffle 按页面会话注入（bindRuffleProtocol）正面冲突，是语义破坏不是优化项。不再作为 duplicateTab / tearoff / 内存优化的实现路径。已记录于 docs/discussions/2026-11-25-electron-patch-backport-audit.md。
- 进程模型实测（11-25 探针 probe-site-processes.js）：每个 WebContentsView 独占渲染进程、同站不合并；空页面 renderer 69–72 MB working set；`webContents.clone()` 同站复用进程（但被上述决策否定使用）。
- 内存优化路径：`--process-per-site` / `--renderer-process-limit=N` 开关对照实验优先（0 风险）；飞窗优化走 预热前移 + overlay-ready 就绪判定 + 隐藏期节流/冻结。
- **飞窗寄居外壳渲染进程（2026-11-25 新方向，评估通过）**：clone 否决只针对页面进程；外壳进程无 Flash/Ruffle，浮层寄居不在否决范围。API 已核实：`setWindowOpenHandler.createWindow => WebContents`（代替 new BrowserWindow）+ WCV 构造器 webContents adopt + `incrementCapturerCount` 隐藏保活。待 demo 验证：file:// 下进程复用（PID）、主线程争用、sender() 校验适配。详见 docs/discussions/2026-11-25-overlay-experience-question.md 与当日讨论。

## 关键事实

- Electron 39.8.10；飞窗/浮层共用单一 WebContentsView（panel/quick/toast 共用，见 app/src/main/shell-overlays.ts）；预热三档 auto/always/never，**默认 always**（2026-11-25 晚切，共享进程下每窗口 +5–6 MB、不多渲染进程）。
- **飞窗预热三档已全部生效（2026-11-25 晚）**：`can-prewarm` + `prewarm`/`overlay-prewarm` 的"主进程决定、外壳执行"契约，判定点唯一在 `canPrewarmNow()`；`BAO_OVERLAY_PREWARM` 可强制档位。默认常驻档实测前台套件 70/70、162 s。
- **"共享浮层抢焦点/吞键"是误判**：`window.open`+createWindow 不改变 OS 激活与 WebContents 焦点；真凶是外壳启动首份状态广播把地址栏草稿清空（已用 `addressDirty` 修掉）。常驻预热因此挪到 `window.show()` 之前。
- 打开耗时基线：预热后 20–25ms，冷启动 ≈260ms；dev 态走 Vite dev server 明显更慢，度量须在打包态做。
- **测试提速靠"少跑"，不靠并发**：8 并发比 4 并发更慢（每用例冷启动一个 Electron 是瓶颈，实测 4→84 s vs 4 并发 79–88 s）。日常用 `npm run smoke:file -- --only=a,b`（8–25 s）或 `npm run smoke:changed`（映射表 `app/scripts/test-map.cjs`；`browser-window.ts`/`package.json`/`preload/index.ts` 等全局文件自动退回全量），提交前再跑 `npm run smoke`，换内核才跑前台。
- Ruffle 资源协议按页面会话绑定（browser-window.ts bindRuffleProtocol）——任何共享渲染进程/会话的方案都要先过这道约束。
