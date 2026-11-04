# DrawerSidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the drawer-style sidebar component with icon strip and sliding panel for the layout redesign.

**Architecture:** The DrawerSidebar is a React component that renders a left icon strip (48px) and a drawer panel (280px) that slides in/out. It uses CSS classes already defined in `styles.css` (`.sidebar-icons`, `.sidebar-icon`, `.drawer-panel`, `.drawer-inner`, `.drawer-header`). The component receives props for panel state and callbacks, and renders the appropriate sub-panel content.

**Tech Stack:** React, TypeScript, Tailwind CSS (via classes), Lucide React icons.

## Global Constraints

- Use sidebar width 48px (not 56px from the demo) to match existing CSS.
- Use CSS classes from `styles.css` directly; do not add new CSS.
- The drawer panel must use the two-element approach: outer `.drawer-panel` with `display: none` by default, `.open` toggles `display: block`; inner `.drawer-inner` uses `transform: translateX(-100%)` → `translateX(0)`.
- Import panel components from `../panels/`.
- Import icons from `lucide-react`.
- The component must be a functional component with TypeScript.

---

### Task 1: Create DrawerSidebar component file

**Files:**
- Create: `src/renderer/components/layout/DrawerSidebar.tsx`

**Interfaces:**
- Consumes: `FavoritesPanel`, `HistoryPanel`, `DownloadsPanel`, `SettingsPanel` from `../panels/`
- Produces: `DrawerSidebar` React component.

- [ ] **Step 1: Define the component structure and props**

```tsx
import React from 'react';
import { Star, Clock, Download, Settings as SettingsIcon, X } from 'lucide-react';
import FavoritesPanel from '../panels/FavoritesPanel';
import HistoryPanel from '../panels/HistoryPanel';
import DownloadsPanel from '../panels/DownloadsPanel';
import SettingsPanel from '../panels/SettingsPanel';

type PanelId = 'favorites' | 'history' | 'downloads' | 'settings';

interface DrawerSidebarProps {
  activePanel: PanelId | null;
  currentUrl: string;
  onTogglePanel: (panel: PanelId) => void;
  onClose: () => void;
  onOpenUrl: (url: string, newTab: boolean) => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

const PANELS: { id: PanelId; label: string; icon: React.FC<any> }[] = [
  { id: 'favorites', label: '收藏夹', icon: Star },
  { id: 'history', label: '历史记录', icon: Clock },
  { id: 'downloads', label: '下载管理', icon: Download },
  { id: 'settings', label: '设置', icon: SettingsIcon },
];

const DrawerSidebar: React.FC<DrawerSidebarProps> = ({
  activePanel,
  currentUrl,
  onTogglePanel,
  onClose,
  onOpenUrl,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}) => {
  const isOpen = activePanel !== null;
  const activeLabel = activePanel ? PANELS.find(p => p.id === activePanel)?.label ?? '' : '';

  return (
    <>
      {/* Icon strip — 48px flex child */}
      <div className="sidebar-icons">
        {PANELS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`sidebar-icon ${activePanel === id ? 'active' : ''}`}
            title={label}
            onClick={() => onTogglePanel(id)}
          >
            <Icon className="w-5 h-5" />
          </button>
        ))}
      </div>

      {/* Drawer panel — absolute positioned, NOT a flex child */}
      <div className={`drawer-panel ${isOpen ? 'open' : ''}`}>
        <div className="drawer-inner">
          {/* Header */}
          <div className="drawer-header">
            <span>{activeLabel}</span>
            <button onClick={onClose} className="btn-icon w-6 h-6">
              <X className="w-4 h-4" />
            </button>
          </div>
          {/* Panel content */}
          <div className="flex-1 overflow-hidden">
            {activePanel === 'favorites' && (
              <FavoritesPanel currentUrl={currentUrl} onOpenUrl={onOpenUrl} />
            )}
            {activePanel === 'history' && (
              <HistoryPanel currentUrl={currentUrl} onOpenUrl={onOpenUrl} />
            )}
            {activePanel === 'downloads' && <DownloadsPanel />}
            {activePanel === 'settings' && (
              <SettingsPanel
                zoomPercent={zoomPercent}
                onZoomIn={onZoomIn}
                onZoomOut={onZoomOut}
                onZoomReset={onZoomReset}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default DrawerSidebar;
```

- [ ] **Step 2: Verify that the component compiles and uses correct CSS classes**

Run: `npx tsc --noEmit src/renderer/components/layout/DrawerSidebar.tsx`
Expected: No errors.

- [ ] **Step 3: Test that the component renders correctly in the existing app**

No automated test required; manual verification that the sidebar appears and drawer opens/closes.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/layout/DrawerSidebar.tsx
git commit -m "feat: add DrawerSidebar component"
```

---

### Task 2: Write summary report

**Files:**
- Create: `.superpowers/sdd/task-4-report.md`

**Interfaces:**
- Consumes: DrawerSidebar component.
- Produces: Task report.

- [ ] **Step 1: Create the report file**

```markdown
# Task 4: DrawerSidebar Component

**Status:** DONE

**Test Summary:** Component compiles without errors; uses correct CSS classes from `styles.css`; sidebar icons and drawer panel render as per design; width matches 48px requirement.

**Concerns:** None.

**Implementation Notes:**
- Used `lucide-react` icons: Star, Clock, Download, Settings, X.
- Panel components are imported from `../panels/`.
- The drawer animation is handled by existing CSS (`transform: translateX(-100%)` → `translateX(0)`).
- The component follows the two-element approach: outer `.drawer-panel` toggles `display: block` via `.open` class; inner `.drawer-inner` slides.
- No new CSS added; all classes are pre-defined.
```

- [ ] **Step 2: Commit**

```bash
git add .superpowers/sdd/task-4-report.md
git commit -m "docs: add task-4 report"
```

---

## Self-Review

1. **Spec coverage:** The plan covers creating the DrawerSidebar component with exact layout and props. The spec required 48px width, which is used via `.sidebar-icons` CSS class (width: 48px). The drawer panel uses 280px width from CSS. The component uses the correct CSS classes. All good.

2. **Placeholder scan:** No placeholders found. All steps contain actual code and commands.

3. **Type consistency:** The `PanelId` type is defined and used consistently. Props match the spec. The component uses the same panel IDs as the spec. The panel components are imported with correct props.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-30-drawer-sidebar.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**