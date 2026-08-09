// Sidebar command merge + invoke routing, pure logic (no Electron).
// Tab commands pass through unchanged (they may carry a slim shape from
// tabManager); @background commands are marked with background: true so the
// panel can render the「后台」badge.

import type { ScriptCommand } from '../../../shared/userscript-types';

export function mergeSidebarCommands<C extends { commandId: string }>(
  tabCommands: C[],
  bgCommands: ScriptCommand[],
): Array<C | (ScriptCommand & { background: true })> {
  return [
    ...tabCommands,
    ...bgCommands.map((command) => ({ ...command, background: true }) as ScriptCommand & { background: true }),
  ];
}

export function resolveCommandRoute(
  tabInvoked: boolean,
  hasBackgroundTarget: boolean,
): 'tab' | 'background' | 'none' {
  if (tabInvoked) return 'tab';
  if (hasBackgroundTarget) return 'background';
  return 'none';
}
