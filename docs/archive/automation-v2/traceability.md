# Automation 2.0 追踪矩阵

> 状态：Complete  
> 最后更新：2026-08-30  
> 规则：Requirement → Audit Evidence → ADR/Design → Phase Task → Test/Verification

## Phase 0 / Phase 1 入口矩阵

| ID | Requirement | Audit Evidence | Design/ADR | Planned Phase | Verification |
|---|---|---|---|---|---|
| REQ-001 | Automation Core独立于Blockly/JS/Recorder | Audit §3、§12、§24、§50 | Core §1-4/19 | P1/P5/P6/P7/P8 | frontend contract tests |
| REQ-002 | Action不按Coordinate/Image/Text复制 | Audit §23-25、§31 | ADR-005/006；Core §11-12/24 | P1/P3 | 新增Locator不新增Action case |
| REQ-003 | Point/Region必须绑定Space | Audit §26、§29 | ADR-002；Core §6-7；`core/geometry.ts`、`coordinate-resolver.ts` | P1/P2 | 15+ property/edge resolver tests |
| REQ-004 | Surface可表达Flash/Ruffle/Canvas/iframe/container/用户区域 | Audit §15.5、§26、§36.3 | ADR-003；Core §8；`core/surface.ts` | P1/P2 | 6 surface composition/cycle/stale tests |
| REQ-005 | Match绑定Frame/Transform，禁止`lastFrame`隐式合同 | Audit §29.3/29.4、§35.1 | ADR-004；Core §16；`core/frame-geometry.ts` | P1/P2/P3 | 5 Frame ROI/roundtrip/stale tests；legacy bridge待P4删除 |
| REQ-006 | TextLocator与ReadText/ReadNumber分离 | Audit §24、§28、§41 | Core §11.4/13 | P1/P3/P4/P5 | locate/read/parse test matrix |
| REQ-007 | Vision/OCR/Input/Capture/Browser边界解耦 | Audit §27-28、§35 | ADR-004/007/009；Core §16-17 | P1/P4 | service contract + frame reuse tests |
| REQ-008 | OCR默认方案必须benchmark后选择 | Audit §6.2、§35.3 | ADR-009；Core §17.4 | P4 | accuracy/latency/size/recovery benchmark |
| REQ-009 | Runtime支持受限Workflow而非完整语言 | Audit §25、§37 | ADR-006；Core §18 | P1/P5 | control-flow/scope tests |
| REQ-010 | Blockly成为受限frontend并减少blocks | Audit §13、§23.2、§24.3 | Core §19.1 | P6 | codec/UX/smoke tests |
| REQ-011 | JavaScript只获得受限`bao.*` API | Audit §38 | ADR-008；Core §19.2/20 | P1/P7 | escape/permission/resource tests |
| REQ-012 | `.baoauto`支持workflow/scripts/assets/profiles | Audit §6.1、§16、§36.2 | ADR-001；Core §21 | P1/P8 | archive/security/entrypoint tests |
| REQ-013 | Recorder输出Core可理解数据 | Audit §3、§50 | Core §19.3 | P1/P8 | record/replay tests |
| REQ-014 | Phase 8不保留永久Legacy Layer | Audit §8.2、§48 | ADR-001；Core §21/28 | P1/P8 | full-repo zero-match checks |
| REQ-015 | Pixel OCR排除在核心重构外 | Audit §6.2 | ADR-009；Core §17.3 | Post-P8 | no Pixel OCR implementation in P1-P8 |
| REQ-016 | cancel/shutdown形成明确资源屏障 | Audit §33.4、§37、RISK-P0-04 | ADR-010；Core §18.4 | P1/P2/P4/P5 | zero-live-resource tests |
| REQ-017 | CDP租约与导航兼容合同必须保留 | Audit §34 | Core §4/12.4/28 | P1/P2/P4 | lease/navigation Electron smokes |
| REQ-018 | capability、批准、enforcement分别建模 | Audit §38、RISK-P0-07 | ADR-008；Core §20 | P1/P7 | grant/enforcement tests |

## 当前追踪状态

- Phase 0 Audit Evidence：Approved。
- ADR/Design：Phase 1 Approved；10项ADR Accepted。
- Product code/Test implementation：Phase 2～8 Complete；Automation 1.x 已断代删除。
- Verification：最终Vitest 94 files / 535 tests、生产构建及Electron沙箱/Ruffle smoke通过；Ruffle smoke覆盖v3悬浮助手注入、三卡片交互、拖拽、识图、OCR、取材保存、坐标与Surface，详见`verification-log.md`。
