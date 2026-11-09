// Probe 41 · P7 可行性：拖拽落点判定所需的屏幕坐标能力
//
// tear-off 的落点判定完全在主进程完成，依赖：
//   - screen.getCursorScreenPoint() 返回全局坐标
//   - screen.getDisplayMatching(rect) 找到目标显示器
//   - 显示器 workArea 可用于夹取新窗口位置
//
// 说明：真实鼠标命中测试无法在无头环境模拟；BrowserView 遮挡页面鼠标事件
// 是项目已实测的既定事实（AGENTS.md：原生层始终在 DOM 之上），因此拖拽期间
// 必须隐藏视图这一策略属于设计约束，不在此重复验证。
'use strict';

module.exports = {
  id: '41-drag-geometry',
  name: 'P7 drag hit-testing prerequisites',
  needsElectron: true,
  timeoutMs: 20_000,

  async run() {
    // screen 只在 app ready 后可用，host 未把它放进 ctx.electron，这里直接取。
    const { screen } = require('electron');
    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    // 1. 指针坐标
    const point = screen.getCursorScreenPoint();
    check('getCursorScreenPoint returns finite ints',
      Number.isFinite(point.x) && Number.isFinite(point.y), point);

    // 2. 显示器匹配与工作区
    const displays = screen.getAllDisplays();
    const display = screen.getDisplayMatching({ x: point.x, y: point.y, width: 10, height: 10 });
    const workArea = display ? display.workArea : null;
    check('getDisplayMatching resolves a display', Boolean(display));
    check('workArea usable for clamping',
      Boolean(workArea) && workArea.width > 0 && workArea.height > 0 && Number.isFinite(workArea.x),
      { workArea, displayCount: displays.length });

    // 3. 夹取算法：把任意点夹进工作区，保证新窗口不会生成到屏幕外
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const winW = 900;
    const winH = 600;
    const clampRect = (px, py) => ({
      x: clamp(px - Math.round(winW / 2), workArea.x, workArea.x + workArea.width - winW),
      y: clamp(py - Math.round(winH / 2), workArea.y, workArea.y + workArea.height - winH),
      width: winW,
      height: winH,
    });
    const inside = clampRect(workArea.x + 500, workArea.y + 500);
    const outside = clampRect(-99999, -99999);
    const farBottomRight = clampRect(99999, 99999);

    check('in-workarea drop point produces expected top-left',
      inside.x === workArea.x + 500 - Math.round(winW / 2)
      && inside.y === workArea.y + 500 - Math.round(winH / 2),
      { inside, workArea });
    check('out-of-screen points are pulled back into workarea',
      outside.x >= workArea.x && outside.y >= workArea.y
      && farBottomRight.x + winW <= workArea.x + workArea.width
      && farBottomRight.y + winH <= workArea.y + workArea.height,
      { outside, farBottomRight, workArea });

    // 4. 跨窗口落点判定：用窗口 bounds 判断点是否落在某个窗口内
    const hits = (rect, p) => p.x >= rect.x && p.x < rect.x + rect.width
      && p.y >= rect.y && p.y < rect.y + rect.height;
    const fakeA = { x: 0, y: 0, width: 800, height: 600 };
    const fakeB = { x: 900, y: 0, width: 800, height: 600 };
    check('hit-test selects the correct window',
      hits(fakeA, { x: 400, y: 300 }) && !hits(fakeB, { x: 400, y: 300 })
      && hits(fakeB, { x: 1200, y: 100 }) && !hits(fakeA, { x: 1200, y: 100 }),
      { fakeA, fakeB });
    check('point outside all windows yields tear-off',
      [fakeA, fakeB].every((rect) => !hits(rect, { x: 1900, y: 700 })), { fakeA, fakeB });

    return {
      ok: failures.length === 0,
      summary: failures.length === 0
        ? 'geometry + clamping + hit-testing all sound'
        : `${failures.length} check(s) failed`,
      detail: {
        failures,
        pointer: point,
        workArea,
        displayCount: displays.length,
        inside,
        outside,
        farBottomRight,
        constraint: 'BrowserView 会遮挡页面区域鼠标事件（已实测），拖拽期间必须把活动视图移出可见区域',
      },
    };
  },
};
