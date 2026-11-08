import type { TargetRef, ValueExpression, WorkflowNode } from '../../../shared/automation/core';

function shortAutomationText(value: string, maxLength = 28): string {
  const clean = value.trim().replace(/\s+/gu, ' ');
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

function literalExpression(value: ValueExpression): null | boolean | number | string | undefined {
  return value.kind === 'literal' ? value.value : undefined;
}

function describeTarget(target: TargetRef): string {
  const locator = target.locator;
  if (locator.kind === 'coordinate') {
    const x = locator.point.unit === 'ratio' ? Math.round(locator.point.x * 10_000) : Math.round(locator.point.x);
    const y = locator.point.unit === 'ratio' ? Math.round(locator.point.y * 10_000) : Math.round(locator.point.y);
    return `坐标 ${x},${y}`;
  }
  if (locator.kind === 'image') {
    const names = [locator.asset, ...(locator.alternatives ?? [])];
    if (names.length > 1) return `图片组（${names.length} 张）`;
    return `图片「${shortAutomationText(locator.asset.replace(/^assets\//u, ''))}」`;
  }
  if (locator.kind === 'text') return `文字「${shortAutomationText(locator.text)}」`;
  return `多个目标（${locator.locators.length} 项）`;
}

export function describeWorkflowNode(node: WorkflowNode): string {
  if (node.kind === 'with') {
    if (node.surface?.kind === 'visual') return '进入指定游戏画面';
    if (node.surface?.kind === 'region' || node.region) return '进入指定坐标范围';
    if (node.surface?.kind === 'viewport') return '使用整个页面范围';
    return '切换执行范围';
  }
  if (node.kind === 'action') {
    const action = node.action;
    if (action.kind === 'click') return `点击${describeTarget(action.target)}`;
    if (action.kind === 'move') return `移动到${describeTarget(action.target)}`;
    if (action.kind === 'drag') return `拖拽：${describeTarget(action.from)} → ${describeTarget(action.to)}`;
    if (action.kind === 'keyPress') return `按键「${action.key}」`;
    if (action.kind === 'typeText') return `输入文字「${shortAutomationText(action.text)}」`;
    if (action.kind === 'scroll') return '滚动页面';
    if (action.kind === 'navigate') return `打开网址「${shortAutomationText(action.url)}」`;
    if (action.kind === 'reload') return '刷新页面';
    if (action.kind === 'log') return `记录日志「${shortAutomationText(action.message)}」`;
    return `发送通知「${shortAutomationText(action.title)}」`;
  }
  if (node.kind === 'wait') {
    if ('durationMs' in node) {
      const duration = literalExpression(node.durationMs);
      return typeof duration === 'number' ? `等待 ${duration} 毫秒` : '等待指定时间';
    }
    return '等待识别条件满足';
  }
  if (node.kind === 'loop') {
    const count = node.mode === 'repeat' ? literalExpression(node.count) : undefined;
    return typeof count === 'number' ? `重复执行 ${count} 次` : node.mode === 'while' ? '按条件重复执行' : '一直循环';
  }
  if (node.kind === 'if') return '判断条件';
  if (node.kind === 'query') {
    if (node.query.kind === 'readText') return `读取文字 → ${node.assignTo}`;
    if (node.query.kind === 'readNumber') return `读取数字 → ${node.assignTo}`;
    if (node.query.kind === 'find') return `查找目标 → ${node.assignTo}`;
    return `判断目标是否存在 → ${node.assignTo}`;
  }
  if (node.kind === 'let') return `设置变量「${node.name}」`;
  if (node.kind === 'set') return `更新变量「${node.name}」`;
  if (node.kind === 'callScript') return `运行脚本「${node.scriptId}」`;
  if (node.kind === 'break') return '跳出循环';
  if (node.kind === 'continue') return '继续下一次循环';
  return '执行流程';
}

export function indexWorkflowNodes(root: WorkflowNode): ReadonlyMap<string, WorkflowNode> {
  const nodes = new Map<string, WorkflowNode>();
  const visit = (node: WorkflowNode): void => {
    nodes.set(node.id, node);
    if (node.kind === 'sequence') node.nodes.forEach(visit);
    else if (node.kind === 'with' || node.kind === 'loop') visit(node.body);
    else if (node.kind === 'if') { visit(node.then); if (node.else) visit(node.else); }
  };
  visit(root);
  return nodes;
}

export function workflowReferencesScript(root: WorkflowNode, scriptId: string): boolean {
  if (root.kind === 'callScript' && root.scriptId === scriptId) return true;
  if (root.kind === 'sequence') return root.nodes.some((node) => workflowReferencesScript(node, scriptId));
  if (root.kind === 'with' || root.kind === 'loop') return workflowReferencesScript(root.body, scriptId);
  if (root.kind === 'if') return workflowReferencesScript(root.then, scriptId) || Boolean(root.else && workflowReferencesScript(root.else, scriptId));
  return false;
}

export function shouldReportWorkflowNode(node: WorkflowNode): boolean {
  return node.kind !== 'sequence';
}
