import * as Blockly from 'blockly';
import { decodeGameSurfaceFeature, surfaceSpecFromGameSurfaceFeature } from '../../../shared/automation/core';
import type {
  ActionSpec,
  LocatorSpec,
  RuntimeValueType,
  TargetRef,
  ValueExpression,
  WorkflowDocumentV3,
  WorkflowNode,
} from '../../../shared/automation/core';
import { decodeAutomationImageGroup, encodeAutomationImageGroup } from '../../../shared/automation/image-groups';
import { DEFAULT_IMAGE_MATCH_MASK } from '../../../shared/automation/vision-policy';

export class AutomationBlocklyV2CodecError extends Error {
  constructor(message: string, readonly blockId?: string) {
    super(message);
    this.name = 'AutomationBlocklyV2CodecError';
  }
}

type Bindings = Map<string, RuntimeValueType>;

function numberField(block: Blockly.Block, name: string): number {
  const value = Number(block.getFieldValue(name));
  if (!Number.isFinite(value)) throw new AutomationBlocklyV2CodecError(`field ${name} must be finite`, block.id);
  return value;
}

function textField(block: Blockly.Block, name: string): string {
  return String(block.getFieldValue(name) ?? '').trim();
}

function coordinatePair(block: Blockly.Block, name: string): readonly [number, number] {
  const match = textField(block, name).match(/^\s*(\d+(?:\.\d+)?)\s*[,，、\s]\s*(\d+(?:\.\d+)?)\s*$/u);
  const label = name === 'TOP_LEFT' ? '左上角' : name === 'BOTTOM_RIGHT' ? '右下角' : '相对';
  if (!match) throw new AutomationBlocklyV2CodecError(`${label}坐标格式应为 x,y，例如 400,7061`, block.id);
  const pair = [Number(match[1]), Number(match[2])] as const;
  if (pair.some((value) => !Number.isFinite(value) || value < 0 || value > 10000)) {
    throw new AutomationBlocklyV2CodecError('范围坐标必须在 0–10000 之间', block.id);
  }
  return pair;
}

function featureSurface(block: Blockly.Block) {
  const value = textField(block, 'GAME_SURFACE');
  if (!value) throw new AutomationBlocklyV2CodecError('请先选择游戏画面、复制特征码，再点击入口积木导入', block.id);
  try { return surfaceSpecFromGameSurfaceFeature(value); }
  catch (error) { throw new AutomationBlocklyV2CodecError(error instanceof Error ? error.message : String(error), block.id); }
}

function requiredValue(block: Blockly.Block, name: string): Blockly.Block {
  const value = block.getInputTargetBlock(name);
  if (!value) throw new AutomationBlocklyV2CodecError(`required input is disconnected: ${name}`, block.id);
  return value;
}

function compileLocator(block: Blockly.Block): LocatorSpec {
  if (block.type === 'bao2_locator_coordinate') {
    const [x, y] = coordinatePair(block, 'COORDINATE');
    return { kind: 'coordinate', point: { unit: 'ratio', x: x / 10000, y: y / 10000 } };
  }
  if (block.type === 'bao2_locator_image') {
    const selected = textField(block, 'ASSET');
    const group = decodeAutomationImageGroup(selected);
    return { kind: 'image', asset: group?.[0] ?? selected, alternatives: group?.slice(1), threshold: numberField(block, 'THRESHOLD'), mask: DEFAULT_IMAGE_MATCH_MASK };
  }
  if (block.type === 'bao2_locator_text') return { kind: 'text', text: String(block.getFieldValue('TEXT') ?? ''), match: block.getFieldValue('MATCH') as 'exact' | 'contains' | 'normalized', minConfidence: numberField(block, 'CONFIDENCE') };
  throw new AutomationBlocklyV2CodecError(`block does not produce a Locator: ${block.type}`, block.id);
}

function compileExpression(block: Blockly.Block, bindings: Bindings): ValueExpression {
  if (block.type === 'bao2_literal_number') return { kind: 'literal', valueType: 'number', value: numberField(block, 'VALUE') };
  if (block.type === 'bao2_literal_text') return { kind: 'literal', valueType: 'string', value: String(block.getFieldValue('VALUE') ?? '') };
  if (block.type === 'bao2_literal_boolean') return { kind: 'literal', valueType: 'boolean', value: block.getFieldValue('VALUE') === 'TRUE' };
  if (block.type === 'bao2_variable') {
    const name = textField(block, 'NAME');
    const valueType = bindings.get(name);
    if (!valueType) throw new AutomationBlocklyV2CodecError(`variable is not declared: ${name}`, block.id);
    return { kind: 'variable', valueType, name };
  }
  if (block.type === 'bao2_binary') {
    const left = compileExpression(requiredValue(block, 'LEFT'), bindings);
    const right = compileExpression(requiredValue(block, 'RIGHT'), bindings);
    const operator = block.getFieldValue('OPERATOR') as Extract<ValueExpression, { kind: 'binary' }>['operator'];
    const valueType: RuntimeValueType = ['and', 'or', 'equal', 'notEqual', 'less', 'lessOrEqual', 'greater', 'greaterOrEqual'].includes(operator)
      ? 'boolean' : operator === 'concat' ? 'string' : 'number';
    return { kind: 'binary', valueType: valueType as 'boolean' | 'number' | 'string', operator, left, right };
  }
  throw new AutomationBlocklyV2CodecError(`block does not produce a Value: ${block.type}`, block.id);
}

function sequenceNode(first: Blockly.Block | null, bindings: Bindings, id: string): WorkflowNode {
  const nodes: WorkflowNode[] = [];
  let current = first;
  while (current) {
    const node = compileStatement(current, bindings);
    nodes.push(node);
    if (node.kind === 'let') bindings.set(node.name, node.valueType);
    if (node.kind === 'query') bindings.set(node.assignTo, node.valueType);
    if (node.kind === 'callScript' && node.assignTo && node.valueType) bindings.set(node.assignTo, node.valueType);
    current = current.getNextBlock();
  }
  return { id, kind: 'sequence', nodes };
}

function target(block: Blockly.Block, input: string): TargetRef {
  return { locator: compileLocator(requiredValue(block, input)) };
}

function compileAction(block: Blockly.Block): ActionSpec {
  if (block.type === 'bao2_action_click') return { kind: 'click', target: target(block, 'TARGET'), button: block.getFieldValue('BUTTON') as 'primary' | 'secondary' | 'middle', count: numberField(block, 'COUNT') };
  if (block.type === 'bao2_action_move') return { kind: 'move', target: target(block, 'TARGET') };
  if (block.type === 'bao2_action_drag') return { kind: 'drag', from: target(block, 'FROM'), to: target(block, 'TO'), durationMs: numberField(block, 'DURATION') };
  if (block.type === 'bao2_action_key_press') return { kind: 'keyPress', key: String(block.getFieldValue('KEY') ?? '') };
  if (block.type === 'bao2_action_type_text') return { kind: 'typeText', text: String(block.getFieldValue('TEXT') ?? ''), intervalMs: numberField(block, 'INTERVAL') };
  if (block.type === 'bao2_action_scroll') return { kind: 'scroll', deltaX: numberField(block, 'X'), deltaY: numberField(block, 'Y') };
  if (block.type === 'bao2_action_navigate') return { kind: 'navigate', url: String(block.getFieldValue('URL') ?? '') };
  if (block.type === 'bao2_action_reload') return { kind: 'reload' };
  if (block.type === 'bao2_action_log') return { kind: 'log', message: String(block.getFieldValue('MESSAGE') ?? '') };
  if (block.type === 'bao2_action_notify') return { kind: 'notify', title: String(block.getFieldValue('TITLE') ?? ''), body: String(block.getFieldValue('BODY') ?? '') };
  throw new AutomationBlocklyV2CodecError(`block does not produce an Action: ${block.type}`, block.id);
}

function compileStatement(block: Blockly.Block, bindings: Bindings): WorkflowNode {
  if (block.type.startsWith('bao2_action_')) return { id: block.id, kind: 'action', action: compileAction(block) };
  if (block.type === 'bao2_with_page_coordinates') return { id: block.id, kind: 'with', surface: { kind: 'viewport' }, body: sequenceNode(block.getInputTargetBlock('BODY'), new Map(bindings), `${block.id}:body`) };
  if (block.type === 'bao2_with_game_coordinates') return { id: block.id, kind: 'with', surface: featureSurface(block), body: sequenceNode(block.getInputTargetBlock('BODY'), new Map(bindings), `${block.id}:body`) };
  if (block.type === 'bao2_with_region') return { id: block.id, kind: 'with', region: { unit: 'ratio', x: numberField(block, 'X') / 10000, y: numberField(block, 'Y') / 10000, width: numberField(block, 'WIDTH') / 10000, height: numberField(block, 'HEIGHT') / 10000 }, body: sequenceNode(block.getInputTargetBlock('BODY'), new Map(bindings), `${block.id}:body`) };
  if (block.type === 'bao2_if') {
    const condition = compileExpression(requiredValue(block, 'CONDITION'), bindings);
    if (condition.valueType !== 'boolean') throw new AutomationBlocklyV2CodecError('if condition must be boolean', block.id);
    return { id: block.id, kind: 'if', condition: condition as ValueExpression<'boolean'>,
      then: sequenceNode(block.getInputTargetBlock('THEN'), new Map(bindings), `${block.id}:then`),
      else: sequenceNode(block.getInputTargetBlock('ELSE'), new Map(bindings), `${block.id}:else`) };
  }
  if (block.type === 'bao2_repeat') {
    const count = compileExpression(requiredValue(block, 'COUNT'), bindings);
    if (count.valueType !== 'number') throw new AutomationBlocklyV2CodecError('repeat count must be a number', block.id);
    return { id: block.id, kind: 'loop', mode: 'repeat', count: count as ValueExpression<'number'>, body: sequenceNode(block.getInputTargetBlock('BODY'), new Map(bindings), `${block.id}:body`) };
  }
  if (block.type === 'bao2_while') {
    const condition = compileExpression(requiredValue(block, 'CONDITION'), bindings);
    if (condition.valueType !== 'boolean') throw new AutomationBlocklyV2CodecError('while condition must be boolean', block.id);
    return { id: block.id, kind: 'loop', mode: 'while', condition: condition as ValueExpression<'boolean'>, body: sequenceNode(block.getInputTargetBlock('BODY'), new Map(bindings), `${block.id}:body`) };
  }
  if (block.type === 'bao2_break') return { id: block.id, kind: 'break' };
  if (block.type === 'bao2_continue') return { id: block.id, kind: 'continue' };
  if (block.type === 'bao2_wait') {
    const durationMs = compileExpression(requiredValue(block, 'DURATION'), bindings);
    if (durationMs.valueType !== 'number') throw new AutomationBlocklyV2CodecError('wait duration must be a number', block.id);
    return { id: block.id, kind: 'wait', durationMs: durationMs as ValueExpression<'number'> };
  }
  if (block.type === 'bao2_wait_target') return { id: block.id, kind: 'wait', query: { kind: 'exists', resultType: 'boolean', locator: compileLocator(requiredValue(block, 'TARGET')) }, until: block.getFieldValue('STATE') === 'hidden' ? 'falsy' : 'truthy', timeoutMs: numberField(block, 'TIMEOUT'), pollIntervalMs: 100, onTimeout: 'fail' };
  if (block.type === 'bao2_let') {
    const name = textField(block, 'NAME');
    const value = compileExpression(requiredValue(block, 'VALUE'), bindings);
    return { id: block.id, kind: 'let', name, valueType: value.valueType, value };
  }
  if (block.type === 'bao2_set') return { id: block.id, kind: 'set', name: textField(block, 'NAME'), value: compileExpression(requiredValue(block, 'VALUE'), bindings) };
  if (block.type === 'bao2_query_exists') return { id: block.id, kind: 'query', query: { kind: 'exists', resultType: 'boolean', locator: compileLocator(requiredValue(block, 'TARGET')) }, assignTo: textField(block, 'NAME'), valueType: 'boolean' };
  if (block.type === 'bao2_query_read_text') return { id: block.id, kind: 'query', query: { kind: 'readText', resultType: 'string' }, assignTo: textField(block, 'NAME'), valueType: 'string' };
  if (block.type === 'bao2_query_read_number') return { id: block.id, kind: 'query', query: { kind: 'readNumber', resultType: 'number' }, assignTo: textField(block, 'NAME'), valueType: 'number' };
  if (block.type === 'bao2_call_script') {
    const argument = block.getInputTargetBlock('ARG');
    return { id: block.id, kind: 'callScript', scriptId: textField(block, 'SCRIPT'), arguments: argument ? [compileExpression(argument, bindings)] : [], assignTo: textField(block, 'ASSIGN'), valueType: block.getFieldValue('RESULT_TYPE') as 'null' | 'boolean' | 'number' | 'string' };
  }
  throw new AutomationBlocklyV2CodecError(`block is not a Blockly 2.0 statement: ${block.type}`, block.id);
}

export function workspaceToWorkflowV3(workspace: Blockly.Workspace, metadata: { readonly id: string; readonly name: string }): WorkflowDocumentV3 {
  const tops = workspace.getTopBlocks(true).filter((block) => !block.outputConnection);
  const entryTypes = ['bao2_entry_unconditional', 'bao2_entry_region', 'bao2_entry_game'];
  if (tops.length !== 1 || !entryTypes.includes(tops[0].type)) throw new AutomationBlocklyV2CodecError('工作区必须且只能有一个启动入口积木');
  const entry = tops[0];
  const body = sequenceNode(entry.getInputTargetBlock('BODY'), new Map(), 'blockly-root');
  let root: WorkflowNode = body;
  if (entry.type === 'bao2_entry_game') root = { id: entry.id, kind: 'with', surface: featureSurface(entry), body };
  if (entry.type === 'bao2_entry_region') {
    const [left, top] = coordinatePair(entry, 'TOP_LEFT');
    const [right, bottom] = coordinatePair(entry, 'BOTTOM_RIGHT');
    if (right <= left || bottom <= top) throw new AutomationBlocklyV2CodecError('右下角坐标必须大于左上角坐标', entry.id);
    root = { id: entry.id, kind: 'with', region: { unit: 'ratio', x: left / 10000, y: top / 10000, width: (right - left) / 10000, height: (bottom - top) / 10000 }, body };
  }
  return { formatVersion: 3, id: metadata.id, name: metadata.name, root };
}

function initialize(block: Blockly.Block): Blockly.Block {
  if (block instanceof Blockly.BlockSvg) { block.initSvg(); block.render(); }
  return block;
}

function createEntry(workspace: Blockly.Workspace, type: 'bao2_entry_unconditional' | 'bao2_entry_region' | 'bao2_entry_game' = 'bao2_entry_unconditional'): Blockly.Block {
  return initialize(workspace.newBlock(type));
}

function setField(block: Blockly.Block, name: string, value: unknown): void {
  if (value !== undefined) block.setFieldValue(String(value), name);
}

function connectValue(parent: Blockly.Block, input: string, child: Blockly.Block): void {
  const connection = parent.getInput(input)?.connection;
  if (!connection || !child.outputConnection) throw new AutomationBlocklyV2CodecError(`cannot connect value input ${input}`, parent.id);
  connection.connect(child.outputConnection);
}

function createLocator(workspace: Blockly.Workspace, locator: LocatorSpec): Blockly.Block {
  if (locator.kind === 'firstOf') throw new AutomationBlocklyV2CodecError('Blockly 2.0 does not expose firstOf Locator yet');
  const type = locator.kind === 'coordinate' ? 'bao2_locator_coordinate' : locator.kind === 'image' ? 'bao2_locator_image' : 'bao2_locator_text';
  const block = initialize(workspace.newBlock(type));
  if (locator.kind === 'coordinate') {
    const factor = locator.point.unit === 'ratio' ? 10000 : 1;
    const display = (value: number): number => Number((value * factor).toFixed(6));
    setField(block, 'COORDINATE', `${display(locator.point.x)},${display(locator.point.y)}`);
  }
  if (locator.kind === 'image') {
    setField(block, 'ASSET', locator.alternatives?.length ? encodeAutomationImageGroup([locator.asset, ...locator.alternatives]) : locator.asset);
    setField(block, 'THRESHOLD', locator.threshold);
  }
  if (locator.kind === 'text') { setField(block, 'TEXT', locator.text); setField(block, 'MATCH', locator.match); setField(block, 'CONFIDENCE', locator.minConfidence); }
  return block;
}

function createExpression(workspace: Blockly.Workspace, expression: ValueExpression): Blockly.Block {
  if (expression.kind === 'literal') {
    const type = expression.valueType === 'number' ? 'bao2_literal_number' : expression.valueType === 'string' ? 'bao2_literal_text' : expression.valueType === 'boolean' ? 'bao2_literal_boolean' : '';
    if (!type) throw new AutomationBlocklyV2CodecError(`Blockly cannot render ${expression.valueType} literal`);
    const block = initialize(workspace.newBlock(type));
    setField(block, 'VALUE', expression.valueType === 'boolean' ? (expression.value ? 'TRUE' : 'FALSE') : expression.value);
    return block;
  }
  if (expression.kind === 'variable') { const block = initialize(workspace.newBlock('bao2_variable')); setField(block, 'NAME', expression.name); return block; }
  if (expression.kind === 'binary') {
    const block = initialize(workspace.newBlock('bao2_binary'));
    setField(block, 'OPERATOR', expression.operator);
    connectValue(block, 'LEFT', createExpression(workspace, expression.left));
    connectValue(block, 'RIGHT', createExpression(workspace, expression.right));
    return block;
  }
  throw new AutomationBlocklyV2CodecError(`Blockly cannot render expression kind: ${expression.kind}`);
}

function assertPlainTarget(target: TargetRef): LocatorSpec {
  if (target.anchor || target.offset || target.selection) throw new AutomationBlocklyV2CodecError('Blockly 2.0 cannot render shaped TargetRef yet');
  return target.locator;
}

function createStatement(workspace: Blockly.Workspace, node: WorkflowNode): Blockly.Block {
  let block: Blockly.Block;
  if (node.kind === 'action') {
    const actionTypes: Record<ActionSpec['kind'], string> = { click: 'bao2_action_click', move: 'bao2_action_move', drag: 'bao2_action_drag', keyPress: 'bao2_action_key_press', typeText: 'bao2_action_type_text', scroll: 'bao2_action_scroll', navigate: 'bao2_action_navigate', reload: 'bao2_action_reload', log: 'bao2_action_log', notify: 'bao2_action_notify' };
    const type = actionTypes[node.action.kind];
    block = initialize(workspace.newBlock(type));
    if (node.action.kind === 'click') { connectValue(block, 'TARGET', createLocator(workspace, assertPlainTarget(node.action.target))); setField(block, 'BUTTON', node.action.button ?? 'primary'); setField(block, 'COUNT', node.action.count ?? 1); }
    else if (node.action.kind === 'move') connectValue(block, 'TARGET', createLocator(workspace, assertPlainTarget(node.action.target)));
    else if (node.action.kind === 'drag') { connectValue(block, 'FROM', createLocator(workspace, assertPlainTarget(node.action.from))); connectValue(block, 'TO', createLocator(workspace, assertPlainTarget(node.action.to))); setField(block, 'DURATION', node.action.durationMs ?? 500); }
    else if (node.action.kind === 'keyPress') setField(block, 'KEY', node.action.key);
    else if (node.action.kind === 'typeText') { setField(block, 'TEXT', node.action.text); setField(block, 'INTERVAL', node.action.intervalMs ?? 0); }
    else if (node.action.kind === 'scroll') { setField(block, 'X', node.action.deltaX); setField(block, 'Y', node.action.deltaY); }
    else if (node.action.kind === 'navigate') setField(block, 'URL', node.action.url);
    else if (node.action.kind === 'log') setField(block, 'MESSAGE', node.action.message);
    else if (node.action.kind === 'notify') { setField(block, 'TITLE', node.action.title); setField(block, 'BODY', node.action.body ?? ''); }
  } else if (node.kind === 'with') {
    const type = node.region ? 'bao2_with_region'
      : node.surface?.kind === 'viewport' ? 'bao2_with_page_coordinates'
        : node.surface?.kind === 'visual' ? 'bao2_with_game_coordinates' : '';
    if (!type) throw new AutomationBlocklyV2CodecError('Blockly 2.0 只能显示页面坐标、特征码游戏区域或指定范围', node.id);
    block = initialize(workspace.newBlock(type));
    if (node.region) { const factor = node.region.unit === 'ratio' ? 10000 : 1; setField(block, 'X', node.region.x * factor); setField(block, 'Y', node.region.y * factor); setField(block, 'WIDTH', node.region.width * factor); setField(block, 'HEIGHT', node.region.height * factor); }
    else if (node.surface?.kind === 'visual' && node.surface.fingerprint) {
      decodeGameSurfaceFeature(node.surface.fingerprint);
      setField(block, 'GAME_SURFACE', node.surface.fingerprint);
    }
    connectStatements(block, 'BODY', workspace, node.body);
  } else if (node.kind === 'if') {
    block = initialize(workspace.newBlock('bao2_if')); connectValue(block, 'CONDITION', createExpression(workspace, node.condition));
    connectStatements(block, 'THEN', workspace, node.then); if (node.else) connectStatements(block, 'ELSE', workspace, node.else);
  } else if (node.kind === 'loop') {
    block = initialize(workspace.newBlock(node.mode === 'repeat' ? 'bao2_repeat' : 'bao2_while'));
    connectValue(block, node.mode === 'repeat' ? 'COUNT' : 'CONDITION', createExpression(workspace, node.mode === 'repeat' ? node.count : node.condition));
    connectStatements(block, 'BODY', workspace, node.body);
  } else if (node.kind === 'break' || node.kind === 'continue') block = initialize(workspace.newBlock(node.kind === 'break' ? 'bao2_break' : 'bao2_continue'));
  else if (node.kind === 'wait' && 'durationMs' in node) { block = initialize(workspace.newBlock('bao2_wait')); connectValue(block, 'DURATION', createExpression(workspace, node.durationMs)); }
  else if (node.kind === 'wait' && node.query.kind === 'exists') { block = initialize(workspace.newBlock('bao2_wait_target')); connectValue(block, 'TARGET', createLocator(workspace, node.query.locator)); setField(block, 'STATE', node.until === 'falsy' ? 'hidden' : 'visible'); setField(block, 'TIMEOUT', node.timeoutMs); }
  else if (node.kind === 'let' || node.kind === 'set') { block = initialize(workspace.newBlock(node.kind === 'let' ? 'bao2_let' : 'bao2_set')); setField(block, 'NAME', node.name); connectValue(block, 'VALUE', createExpression(workspace, node.value)); }
  else if (node.kind === 'query' && node.query.kind === 'exists') { block = initialize(workspace.newBlock('bao2_query_exists')); setField(block, 'NAME', node.assignTo); connectValue(block, 'TARGET', createLocator(workspace, node.query.locator)); }
  else if (node.kind === 'query' && node.query.kind === 'readText') { block = initialize(workspace.newBlock('bao2_query_read_text')); setField(block, 'NAME', node.assignTo); }
  else if (node.kind === 'query' && node.query.kind === 'readNumber') { block = initialize(workspace.newBlock('bao2_query_read_number')); setField(block, 'NAME', node.assignTo); }
  else if (node.kind === 'callScript') { block = initialize(workspace.newBlock('bao2_call_script')); setField(block, 'SCRIPT', node.scriptId); setField(block, 'ASSIGN', node.assignTo ?? 'result'); setField(block, 'RESULT_TYPE', node.valueType ?? 'null'); if (node.arguments[0]) connectValue(block, 'ARG', createExpression(workspace, node.arguments[0])); }
  else throw new AutomationBlocklyV2CodecError(`Blockly cannot render Workflow node: ${node.kind}`, node.id);
  return block;
}

function nodeList(node: WorkflowNode): readonly WorkflowNode[] { return node.kind === 'sequence' ? node.nodes : [node]; }

function connectStatements(parent: Blockly.Block, input: string, workspace: Blockly.Workspace, node: WorkflowNode): void {
  const first = createStatementChain(workspace, nodeList(node));
  if (!first) return;
  const connection = parent.getInput(input)?.connection;
  if (!connection || !first.previousConnection) throw new AutomationBlocklyV2CodecError(`cannot connect statement input ${input}`, parent.id);
  connection.connect(first.previousConnection);
}

function createStatementChain(workspace: Blockly.Workspace, nodes: readonly WorkflowNode[]): Blockly.Block | null {
  let first: Blockly.Block | null = null;
  let previous: Blockly.Block | null = null;
  for (const node of nodes) {
    const block = createStatement(workspace, node);
    if (!first) first = block;
    if (previous?.nextConnection && block.previousConnection) previous.nextConnection.connect(block.previousConnection);
    previous = block;
  }
  return first;
}

export function workflowV3ToWorkspace(workspace: Blockly.Workspace, document: WorkflowDocumentV3): void {
  workspace.clear();
  let entryType: 'bao2_entry_unconditional' | 'bao2_entry_region' | 'bao2_entry_game' = 'bao2_entry_unconditional';
  let body = document.root;
  if (document.root.kind === 'with' && document.root.region && !document.root.surface) {
    entryType = 'bao2_entry_region'; body = document.root.body;
  } else if (document.root.kind === 'with' && document.root.surface?.kind === 'visual' && document.root.surface.fingerprint?.startsWith('BFG1:')) {
    entryType = 'bao2_entry_game'; body = document.root.body;
  } else if (document.root.kind === 'with' && document.root.surface?.kind === 'named' && document.root.surface.name === 'game') {
    entryType = 'bao2_entry_game'; body = document.root.body;
  }
  const entry = createEntry(workspace, entryType);
  if (entryType === 'bao2_entry_region' && document.root.kind === 'with' && document.root.region) {
    const factor = document.root.region.unit === 'ratio' ? 10000 : 1;
    const left = document.root.region.x * factor; const top = document.root.region.y * factor;
    setField(entry, 'TOP_LEFT', `${left},${top}`);
    setField(entry, 'BOTTOM_RIGHT', `${left + document.root.region.width * factor},${top + document.root.region.height * factor}`);
  }
  if (entryType === 'bao2_entry_game' && document.root.kind === 'with' && document.root.surface?.kind === 'visual') setField(entry, 'GAME_SURFACE', document.root.surface.fingerprint);
  connectStatements(entry, 'BODY', workspace, body);
  if (entry instanceof Blockly.BlockSvg) entry.moveBy(32, 32);
}

/** Ensure a new or empty workspace always has one explicit Automation 2.0 entry. */
export function ensureAutomationV2Entry(workspace: Blockly.Workspace): void {
  const entryTypes = new Set(['bao2_entry_unconditional', 'bao2_entry_region', 'bao2_entry_game']);
  const existing = workspace.getAllBlocks(false).find((block) => entryTypes.has(block.type));
  if (existing) return;
  const tops = workspace.getTopBlocks(true).filter((block) => !block.outputConnection);
  const entry = createEntry(workspace);
  if (tops.length === 1 && tops[0].previousConnection) entry.getInput('BODY')?.connection?.connect(tops[0].previousConnection);
  if (entry instanceof Blockly.BlockSvg) entry.moveBy(32, 32);
}
