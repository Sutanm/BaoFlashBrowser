import * as Blockly from 'blockly';
import { GAME_SURFACE_FIELD } from './automation-game-surface-field';
import { collectAutomationImageGroups } from '../../../shared/automation/image-groups';
import { DEFAULT_IMAGE_MATCH_THRESHOLD } from '../../../shared/automation/vision-policy';

export const AUTOMATION_V2_BLOCK_TYPES = Object.freeze([
  'bao2_entry_unconditional', 'bao2_entry_region', 'bao2_entry_game',
  'bao2_locator_coordinate', 'bao2_locator_image', 'bao2_locator_text',
  'bao2_action_click', 'bao2_action_move', 'bao2_action_drag',
  'bao2_action_key_press', 'bao2_action_type_text', 'bao2_action_scroll',
  'bao2_action_navigate', 'bao2_action_reload', 'bao2_action_log', 'bao2_action_notify',
  'bao2_with_page_coordinates', 'bao2_with_game_coordinates', 'bao2_with_region',
  'bao2_call_script',
  'bao2_if', 'bao2_repeat', 'bao2_forever', 'bao2_while', 'bao2_break', 'bao2_continue', 'bao2_wait', 'bao2_wait_target',
  'bao2_let', 'bao2_set', 'bao2_literal_number', 'bao2_literal_text', 'bao2_literal_boolean',
  'bao2_variable', 'bao2_binary', 'bao2_query_exists', 'bao2_query_read_text', 'bao2_query_read_number',
] as const);

export const AUTOMATION_V2_BLOCK_COUNT = AUTOMATION_V2_BLOCK_TYPES.length;
export const BAO_LOCATOR_CHECK = 'BaoLocator';
export const BAO_VALUE_CHECK = 'BaoValue';

const labels = {
  'zh-CN': {
    entryUnconditional: '无条件启动', entryRegion: '限定游戏区域 左上 %1 右下 %2', entryGame: '指定游戏画面 %1 后启动', importFeature: '从剪贴板导入特征串', gameCoordinateHint: '以下积木使用游戏画面坐标（识图仅处理游戏画面）', execute: '执行 %1', assetMissing: '请先取材…',
    locatorCoordinate: '相对坐标 %1', locatorImage: '图片或图片组 %1 相似度 %2', locatorText: '文字 %1 匹配 %2 置信度 %3', imageGroup: '图片组',
    click: '点击 %1 按键 %2 次数 %3', move: '移动到 %1', drag: '拖动 从 %1 到 %2 时长(ms) %3',
    keyPress: '按键 %1', typeText: '输入文字 %1 间隔(ms) %2', scroll: '滚动 横向 %1 纵向 %2',
    navigate: '打开网页 %1', reload: '刷新当前页面', log: '记录日志 %1', notify: '通知 标题 %1 内容 %2',
    withPageCoordinates: '使用页面坐标 %1', withGameCoordinates: '使用游戏区域坐标 特征码 %1 %2', withRegion: '在区域 x %1 y %2 宽 %3 高 %4（0–10000）中 %5',
    if: '如果 %1 那么 %2 否则 %3', repeat: '重复 %1 次 %2', forever: '一直循环 %1', foreverTip: '持续执行内部积木，直到点击停止或执行“跳出循环”；建议在循环内加入等待，避免过于频繁地运行。', while: '当 %1 时循环 %2', break: '跳出循环', continue: '继续下一轮', wait: '等待(ms) %1', waitTarget: '等待 %1 %2 超时(ms) %3',
    let: '定义变量 %1 为 %2', set: '设置变量 %1 为 %2', number: '数字 %1', text: '文本 %1', boolean: '布尔 %1', variable: '变量 %1',
    binary: '%1 %2 %3', exists: '检查 %1 是否存在 保存到 %2', readText: 'OCR 读取区域文字 保存到 %1', readNumber: 'OCR 读取区域数字 保存到 %1',
    viewport: '页面视口', game: '游戏区域', exact: '完全', contains: '包含', normalized: '规范化',
    primary: '左键', secondary: '右键', middle: '中键', true: '真', false: '假',
    callScript: '运行脚本 %1 参数 %2 结果保存到 %3 类型 %4', noScripts: '请先新建脚本…', visible: '出现', hidden: '消失', catEntry: '启动方式', catMouse: '鼠标', catKeyboard: '键盘', catRecognition: '图片与文字识别', catContext: '坐标与区域', catControl: '流程控制', catValue: '变量与 OCR', catScript: '脚本与扩展', catPage: '页面与调试',
  },
  en: {
    entryUnconditional: 'start unconditionally', entryRegion: 'limit game area top-left %1 bottom-right %2', entryGame: 'start with specified game area %1', importFeature: 'import feature string from clipboard', gameCoordinateHint: 'blocks below use game-area coordinates (image recognition only scans the game area)', execute: 'run %1', assetMissing: 'capture an image first…',
    locatorCoordinate: 'coordinate %1', locatorImage: 'image or group %1 threshold %2', locatorText: 'text %1 match %2 confidence %3', imageGroup: 'image group',
    click: 'click %1 button %2 count %3', move: 'move to %1', drag: 'drag from %1 to %2 duration(ms) %3',
    keyPress: 'press key %1', typeText: 'type text %1 interval(ms) %2', scroll: 'scroll x %1 y %2', navigate: 'open URL %1', reload: 'reload page', log: 'log %1', notify: 'notify title %1 body %2',
    withPageCoordinates: 'use page coordinates %1', withGameCoordinates: 'use game-area coordinates feature %1 %2', withRegion: 'within region x %1 y %2 width %3 height %4 %5',
    if: 'if %1 then %2 else %3', repeat: 'repeat %1 times %2', forever: 'forever %1', foreverTip: 'Keep running until stopped or a break block executes. Add a wait inside to avoid running too frequently.', while: 'while %1 %2', break: 'break loop', continue: 'continue loop', wait: 'wait(ms) %1', waitTarget: 'wait until %1 is %2 timeout(ms) %3',
    let: 'let %1 be %2', set: 'set %1 to %2', number: 'number %1', text: 'text %1', boolean: 'boolean %1', variable: 'variable %1',
    binary: '%1 %2 %3', exists: 'check %1 exists, save to %2', readText: 'OCR read region text into %1', readNumber: 'OCR read region number into %1',
    viewport: 'viewport', game: 'game surface', exact: 'exact', contains: 'contains', normalized: 'normalized',
    primary: 'left', secondary: 'right', middle: 'middle', true: 'true', false: 'false',
    callScript: 'run script %1 argument %2 save result to %3 type %4', noScripts: 'create a script first…', visible: 'visible', hidden: 'hidden', catEntry: 'Start', catMouse: 'Mouse', catKeyboard: 'Keyboard', catRecognition: 'Image & text recognition', catContext: 'Coordinates & regions', catControl: 'Flow', catValue: 'Variables & OCR', catScript: 'Scripts', catPage: 'Page & debug',
  },
} as const;

type Locale = keyof typeof labels;

function imageAssetOptions(assets: readonly string[], groupLabel: string): string[][] {
  const unique = [...new Set(assets)].sort();
  const groupOptions = collectAutomationImageGroups(unique)
    .map((group) => [`${groupLabel}：${group.directory}（${group.assets.length}）`, group.value]);
  return [...groupOptions, ...unique.map((asset) => [asset, asset])];
}

export function registerAutomationV2Blocks(locale: Locale, assets: readonly string[] = [], scripts: readonly string[] = []): void {
  const l = labels[locale];
  const assetOptions = assets.length ? imageAssetOptions(assets, l.imageGroup) : [[l.assetMissing, '']];
  const scriptOptions = scripts.length ? scripts.map((script) => [script, script]) : [[l.noScripts, '']];
  Blockly.defineBlocksWithJsonArray([
    { type: 'bao2_entry_unconditional', message0: l.entryUnconditional, message1: l.execute, args1: [{ type: 'input_statement', name: 'BODY' }], colour: 265 },
    { type: 'bao2_entry_region', message0: l.entryRegion, args0: [{ type: 'field_input', name: 'TOP_LEFT', text: '0,0' }, { type: 'field_input', name: 'BOTTOM_RIGHT', text: '10000,10000' }], message1: l.execute, args1: [{ type: 'input_statement', name: 'BODY' }], colour: 265 },
    { type: 'bao2_entry_game', message0: l.entryGame, args0: [{ type: GAME_SURFACE_FIELD, name: 'GAME_SURFACE', value: '', importLabel: l.importFeature }], message1: l.gameCoordinateHint, message2: l.execute, args2: [{ type: 'input_statement', name: 'BODY' }], colour: 265 },
    { type: 'bao2_locator_coordinate', message0: l.locatorCoordinate, args0: [{ type: 'field_input', name: 'COORDINATE', text: '5000,5000' }], output: BAO_LOCATOR_CHECK, colour: 205 },
    { type: 'bao2_locator_image', message0: l.locatorImage, args0: [{ type: 'field_dropdown', name: 'ASSET', options: assetOptions }, { type: 'field_number', name: 'THRESHOLD', value: DEFAULT_IMAGE_MATCH_THRESHOLD, min: .1, max: 1, precision: .01 }], output: BAO_LOCATOR_CHECK, colour: 205 },
    { type: 'bao2_locator_text', message0: l.locatorText, args0: [{ type: 'field_input', name: 'TEXT', text: '' }, { type: 'field_dropdown', name: 'MATCH', options: [[l.contains, 'contains'], [l.exact, 'exact'], [l.normalized, 'normalized']] }, { type: 'field_number', name: 'CONFIDENCE', value: .5, min: 0, max: 1, precision: .01 }], output: BAO_LOCATOR_CHECK, colour: 205 },
    { type: 'bao2_action_click', message0: l.click, args0: [{ type: 'input_value', name: 'TARGET', check: BAO_LOCATOR_CHECK }, { type: 'field_dropdown', name: 'BUTTON', options: [[l.primary, 'primary'], [l.secondary, 'secondary'], [l.middle, 'middle']] }, { type: 'field_number', name: 'COUNT', value: 1, min: 1, max: 10, precision: 1 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao2_action_move', message0: l.move, args0: [{ type: 'input_value', name: 'TARGET', check: BAO_LOCATOR_CHECK }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao2_action_drag', message0: l.drag, args0: [{ type: 'input_value', name: 'FROM', check: BAO_LOCATOR_CHECK }, { type: 'input_value', name: 'TO', check: BAO_LOCATOR_CHECK }, { type: 'field_number', name: 'DURATION', value: 500, min: 0, max: 60000, precision: 1 }], previousStatement: null, nextStatement: null, colour: 120 },
    { type: 'bao2_action_key_press', message0: l.keyPress, args0: [{ type: 'field_input', name: 'KEY', text: 'Enter' }], previousStatement: null, nextStatement: null, colour: 105 },
    { type: 'bao2_action_type_text', message0: l.typeText, args0: [{ type: 'field_input', name: 'TEXT', text: '' }, { type: 'field_number', name: 'INTERVAL', value: 0, min: 0, max: 10000 }], previousStatement: null, nextStatement: null, colour: 105 },
    { type: 'bao2_action_scroll', message0: l.scroll, args0: [{ type: 'field_number', name: 'X', value: 0 }, { type: 'field_number', name: 'Y', value: 480 }], previousStatement: null, nextStatement: null, colour: 105 },
    { type: 'bao2_action_navigate', message0: l.navigate, args0: [{ type: 'field_input', name: 'URL', text: 'https://example.com/' }], previousStatement: null, nextStatement: null, colour: 170 },
    { type: 'bao2_action_reload', message0: l.reload, previousStatement: null, nextStatement: null, colour: 170 },
    { type: 'bao2_action_log', message0: l.log, args0: [{ type: 'field_input', name: 'MESSAGE', text: '' }], previousStatement: null, nextStatement: null, colour: 65 },
    { type: 'bao2_action_notify', message0: l.notify, args0: [{ type: 'field_input', name: 'TITLE', text: '' }, { type: 'field_input', name: 'BODY', text: '' }], previousStatement: null, nextStatement: null, colour: 65 },
    { type: 'bao2_with_page_coordinates', message0: l.withPageCoordinates, args0: [{ type: 'input_statement', name: 'BODY' }], previousStatement: null, nextStatement: null, colour: 260 },
    { type: 'bao2_with_game_coordinates', message0: l.withGameCoordinates, args0: [{ type: GAME_SURFACE_FIELD, name: 'GAME_SURFACE', value: '', importLabel: l.importFeature }, { type: 'input_statement', name: 'BODY' }], previousStatement: null, nextStatement: null, colour: 260 },
    { type: 'bao2_with_region', message0: l.withRegion, args0: [{ type: 'field_number', name: 'X', value: 0, min: 0, max: 9999, precision: 1 }, { type: 'field_number', name: 'Y', value: 0, min: 0, max: 9999, precision: 1 }, { type: 'field_number', name: 'WIDTH', value: 10000, min: 1, max: 10000, precision: 1 }, { type: 'field_number', name: 'HEIGHT', value: 10000, min: 1, max: 10000, precision: 1 }, { type: 'input_statement', name: 'BODY' }], previousStatement: null, nextStatement: null, colour: 260 },
    { type: 'bao2_call_script', message0: l.callScript, args0: [{ type: 'field_dropdown', name: 'SCRIPT', options: scriptOptions }, { type: 'input_value', name: 'ARG', check: BAO_VALUE_CHECK }, { type: 'field_input', name: 'ASSIGN', text: 'result' }, { type: 'field_dropdown', name: 'RESULT_TYPE', options: [['数字', 'number'], ['文字', 'string'], ['布尔', 'boolean'], ['空值', 'null']] }], previousStatement: null, nextStatement: null, colour: 28 },
    { type: 'bao2_if', message0: l.if, args0: [{ type: 'input_value', name: 'CONDITION', check: BAO_VALUE_CHECK }, { type: 'input_statement', name: 'THEN' }, { type: 'input_statement', name: 'ELSE' }], previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao2_repeat', message0: l.repeat, args0: [{ type: 'input_value', name: 'COUNT', check: BAO_VALUE_CHECK }, { type: 'input_statement', name: 'BODY' }], previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao2_forever', message0: l.forever, args0: [{ type: 'input_statement', name: 'BODY' }], previousStatement: null, nextStatement: null, colour: 45, tooltip: l.foreverTip },
    { type: 'bao2_while', message0: l.while, args0: [{ type: 'input_value', name: 'CONDITION', check: BAO_VALUE_CHECK }, { type: 'input_statement', name: 'BODY' }], previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao2_break', message0: l.break, previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao2_continue', message0: l.continue, previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao2_wait', message0: l.wait, args0: [{ type: 'input_value', name: 'DURATION', check: BAO_VALUE_CHECK }], previousStatement: null, nextStatement: null, colour: 45 },
    { type: 'bao2_wait_target', message0: l.waitTarget, args0: [{ type: 'input_value', name: 'TARGET', check: BAO_LOCATOR_CHECK }, { type: 'field_dropdown', name: 'STATE', options: [[l.visible, 'visible'], [l.hidden, 'hidden']] }, { type: 'field_number', name: 'TIMEOUT', value: 10000, min: 1, max: 3600000 }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao2_let', message0: l.let, args0: [{ type: 'field_input', name: 'NAME', text: 'value' }, { type: 'input_value', name: 'VALUE', check: BAO_VALUE_CHECK }], previousStatement: null, nextStatement: null, colour: 310 },
    { type: 'bao2_set', message0: l.set, args0: [{ type: 'field_input', name: 'NAME', text: 'value' }, { type: 'input_value', name: 'VALUE', check: BAO_VALUE_CHECK }], previousStatement: null, nextStatement: null, colour: 310 },
    { type: 'bao2_literal_number', message0: l.number, args0: [{ type: 'field_number', name: 'VALUE', value: 0 }], output: BAO_VALUE_CHECK, colour: 310 },
    { type: 'bao2_literal_text', message0: l.text, args0: [{ type: 'field_input', name: 'VALUE', text: '' }], output: BAO_VALUE_CHECK, colour: 310 },
    { type: 'bao2_literal_boolean', message0: l.boolean, args0: [{ type: 'field_dropdown', name: 'VALUE', options: [[l.true, 'TRUE'], [l.false, 'FALSE']] }], output: BAO_VALUE_CHECK, colour: 310 },
    { type: 'bao2_variable', message0: l.variable, args0: [{ type: 'field_input', name: 'NAME', text: 'value' }], output: BAO_VALUE_CHECK, colour: 310 },
    { type: 'bao2_binary', message0: l.binary, args0: [{ type: 'input_value', name: 'LEFT', check: BAO_VALUE_CHECK }, { type: 'field_dropdown', name: 'OPERATOR', options: [['+', 'add'], ['−', 'subtract'], ['×', 'multiply'], ['÷', 'divide'], ['=', 'equal'], ['≠', 'notEqual'], ['<', 'less'], ['≤', 'lessOrEqual'], ['>', 'greater'], ['≥', 'greaterOrEqual'], ['AND', 'and'], ['OR', 'or'], ['++', 'concat']] }, { type: 'input_value', name: 'RIGHT', check: BAO_VALUE_CHECK }], output: BAO_VALUE_CHECK, colour: 310 },
    { type: 'bao2_query_exists', message0: l.exists, args0: [{ type: 'input_value', name: 'TARGET', check: BAO_LOCATOR_CHECK }, { type: 'field_input', name: 'NAME', text: 'exists' }], previousStatement: null, nextStatement: null, colour: 310 },
    { type: 'bao2_query_read_text', message0: l.readText, args0: [{ type: 'field_input', name: 'NAME', text: 'text' }], previousStatement: null, nextStatement: null, colour: 205 },
    { type: 'bao2_query_read_number', message0: l.readNumber, args0: [{ type: 'field_input', name: 'NAME', text: 'number' }], previousStatement: null, nextStatement: null, colour: 205 },
  ]);
}

export function automationV2Toolbox(locale: Locale): Blockly.utils.toolbox.ToolboxDefinition {
  const l = labels[locale];
  const blocks = (types: readonly string[]) => types.map((type) => ({ kind: 'block', type }));
  const valuePreset = (type: string, input: string, valueType: string) => ({ kind: 'block', type, inputs: { [input]: { shadow: { type: valueType } } } });
  return { kind: 'categoryToolbox', contents: [
    { kind: 'category', name: l.catEntry, colour: '265', contents: blocks(['bao2_entry_unconditional', 'bao2_entry_region', 'bao2_entry_game']) },
    { kind: 'category', name: l.catMouse, colour: '120', contents: blocks(['bao2_action_click', 'bao2_action_move', 'bao2_action_drag']) },
    { kind: 'category', name: l.catKeyboard, colour: '105', contents: blocks(['bao2_action_key_press', 'bao2_action_type_text', 'bao2_action_scroll']) },
    { kind: 'category', name: l.catRecognition, colour: '205', contents: [
      ...blocks(['bao2_locator_image', 'bao2_locator_text', 'bao2_locator_coordinate']),
      ...blocks(['bao2_wait_target']),
    ] },
    { kind: 'category', name: l.catContext, colour: '260', contents: blocks(['bao2_with_page_coordinates', 'bao2_with_game_coordinates', 'bao2_with_region', 'bao2_locator_coordinate']) },
    { kind: 'category', name: l.catControl, colour: '45', contents: [valuePreset('bao2_repeat', 'COUNT', 'bao2_literal_number'), ...blocks(['bao2_forever']), valuePreset('bao2_wait', 'DURATION', 'bao2_literal_number'), ...blocks(['bao2_if', 'bao2_while', 'bao2_break', 'bao2_continue'])] },
    { kind: 'category', name: l.catValue, colour: '310', contents: blocks(['bao2_query_read_text', 'bao2_query_read_number', 'bao2_query_exists', 'bao2_let', 'bao2_set', 'bao2_literal_number', 'bao2_literal_text', 'bao2_literal_boolean', 'bao2_variable', 'bao2_binary']) },
    { kind: 'category', name: l.catScript, colour: '28', contents: blocks(['bao2_call_script']) },
    { kind: 'category', name: l.catPage, colour: '170', contents: blocks(['bao2_action_navigate', 'bao2_action_reload', 'bao2_action_log', 'bao2_action_notify']) },
  ] } as Blockly.utils.toolbox.ToolboxDefinition;
}
