const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
const ROOT = path.join(__dirname, '..', '..');
const timeout = setTimeout(() => { console.error('[automation-m4-workbench] FAIL: timed out'); app.exit(1); }, 60000);

async function waitFor(wc, expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await wc.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition timed out: ${expression}`);
}

async function clickToolboxCategory(wc, text) {
  const point = await wc.executeJavaScript(`(() => {
    const label = [...document.querySelectorAll('.blocklyTreeLabel')].find(node => node.textContent === ${JSON.stringify(text)});
    if (!label) throw new Error('toolbox category not found: ' + ${JSON.stringify(text)});
    const rect = label.closest('.blocklyTreeRow').getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2); const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit && { tag: hit.tagName, className: hit.getAttribute('class'), text: hit.textContent?.trim().slice(0, 40) } };
  })()`);
  if (!String(point.hit?.className).includes('blocklyTree')) throw new Error(`toolbox category is covered: ${JSON.stringify(point)}`);
  wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function clickButton(wc, selector, text) {
  const point = await wc.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.includes(${JSON.stringify(text)}));
    if (!button) throw new Error('button not found: ' + ${JSON.stringify(text)});
    const rect = button.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function clickBlocklyField(wc, blockText, fieldText) {
  const point = await wc.executeJavaScript(`(() => {
    const block = [...document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyDraggable')].find(node => [...node.querySelectorAll('.blocklyText')].some(text => text.closest('.blocklyDraggable') === node && text.textContent.includes(${JSON.stringify(blockText)})));
    const text = [...block.querySelectorAll('.blocklyText')].find(node => node.closest('.blocklyDraggable') === block && node.textContent.includes(${JSON.stringify(fieldText)}) && node.getBoundingClientRect().width > 0);
    const rect = text.closest('.blocklyEditableText').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function selectBlocklyMenuItem(wc, text) {
  await waitFor(wc, `[...document.querySelectorAll('.blocklyMenuItem')].some(node => node.textContent.includes(${JSON.stringify(text)}))`);
  const point = await wc.executeJavaScript(`(() => { const item = [...document.querySelectorAll('.blocklyMenuItem')].find(node => node.textContent.includes(${JSON.stringify(text)})); const rect = item.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1360, height: 820,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'automation-m4-preload.cjs') },
  });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 3) console.error('[automation-m4-renderer]', message, `${sourceId}:${line}`);
  });
  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'));
  await waitFor(win.webContents, `document.querySelector('.address-input')`);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.address-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'about:automation');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  })()`);
  await waitFor(win.webContents, `document.querySelector('.automation-blockly-host .blocklySvg')`);
  const result = await win.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.automation-page h1')?.textContent,
    scripts: document.querySelectorAll('.automation-library > button').length,
    categories: [...document.querySelectorAll('.automation-page .blocklyTreeLabel')].map(node => node.textContent),
    blocks: document.querySelectorAll('.automation-page .blocklyDraggable').length,
    blockTransforms: [...document.querySelectorAll('.automation-page .blocklyDraggable')].map(node => node.getAttribute('transform')),
    blockRects: [...document.querySelectorAll('.automation-page .blocklyDraggable')].map(node => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: getComputedStyle(node).display }; }),
    hostRect: (() => { const rect = document.querySelector('.automation-blockly-host')?.getBoundingClientRect(); return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(),
    svgRect: (() => { const node = document.querySelector('.automation-blockly-host .blocklySvg'); const rect = node?.getBoundingClientRect(); return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: getComputedStyle(node).top, left: getComputedStyle(node).left, position: getComputedStyle(node).position }; })(),
    jsonMode: [...document.querySelectorAll('.automation-editor-tabs button')].some(node => node.textContent.includes('JSON')),
    libraryActions: document.querySelectorAll('.automation-library-actions button').length,
    assetRows: document.querySelectorAll('.automation-assets-list li').length,
    assetPreview: Boolean(document.querySelector('.automation-asset-preview img')),
    assetSearch: Boolean(document.querySelector('.automation-asset-search input')),
    folderLink: [...document.querySelectorAll('.automation-folder-link button')].some(node => node.textContent.includes('关联目录')),
    imageGroups: [...document.querySelectorAll('.automation-image-groups span')].map(node => node.textContent),
    diagnosticButton: [...document.querySelectorAll('.automation-diagnostic-button')].some(node => node.textContent.includes('检查脚本包')),
    canCreate: [...document.querySelectorAll('.automation-page-header-actions button')].some(node => node.textContent.includes('新建脚本')),
    createDisabled: [...document.querySelectorAll('.automation-page-header-actions button')].find(node => node.textContent.includes('新建脚本'))?.disabled,
    newBlockTypes: ['bao_start_unconditional', 'bao_start_region', 'bao_start_condition', 'bao_random_click_region', 'bao_vision_region', 'bao_drag_image', 'bao_key_combo', 'bao_hold_key_until_image', 'bao_if_condition', 'bao_wait_condition', 'bao_wait_condition_branch', 'bao_end', 'bao_repeat_until_condition', 'bao_condition_image', 'bao_condition_and', 'bao_condition_or', 'bao_condition_not'].map(type => ({ type, registered: document.querySelector('.automation-blockly-host')?.dataset.blockTypes?.split(' ').includes(type) })),
  }))()`);
  if (result.title !== '自动化工作台') throw new Error(`unexpected title: ${result.title}`);
  if (result.scripts !== 2 || result.blocks < 3) throw new Error(`workbench content missing: ${JSON.stringify(result)}`);
  if (!result.categories.includes('鼠标操作') || !result.categories.includes('识别与等待') || !result.categories.includes('流程') || !result.jsonMode) throw new Error(`workbench controls missing: ${JSON.stringify(result)}`);
  if (!result.canCreate || result.createDisabled || result.libraryActions !== 2 || result.assetRows !== 3 || !result.assetPreview || !result.assetSearch || !result.folderLink || result.imageGroups.length !== 1 || !result.diagnosticButton) throw new Error(`library management missing: ${JSON.stringify(result)}`);
  if (result.newBlockTypes.some((block) => !block.registered)) throw new Error(`new automation blocks missing: ${JSON.stringify(result.newBlockTypes)}`);
  const targetBlocks = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyDraggable')].map(block => { const ownText = [...block.querySelectorAll('.blocklyText')].filter(node => node.closest('.blocklyDraggable') === block && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0).map(node => node.textContent).join('').replace(/\\s+/g, ' ').trim(); const ownPath = [...block.children].find(node => node.classList?.contains('blocklyPath')); return { text: ownText, width: ownPath?.getBoundingClientRect().width ?? 0 }; })`);
  const shortestMatch = (predicate) => targetBlocks.filter(({ text }) => predicate(text)).sort((a, b) => a.text.length - b.text.length)[0];
  const coordinateClick = shortestMatch((text) => text.includes('6250,3750'));
  const coordinateMove = shortestMatch((text) => text.includes('6000,3500'));
  const mixedDrag = shortestMatch((text) => text.includes('2500,5000') && text.includes('pages/home.png'));
  if (!coordinateClick || coordinateClick.text.includes('相似度') || coordinateClick.text.includes('匹配') || coordinateClick.width > 500) throw new Error(`coordinate click layout is invalid: ${JSON.stringify(coordinateClick)}`);
  if (!coordinateMove || coordinateMove.text.includes('相似度') || coordinateMove.text.includes('匹配') || coordinateMove.width > 380) throw new Error(`coordinate move layout is invalid: ${JSON.stringify(coordinateMove)}`);
  if (!mixedDrag || !mixedDrag.text.includes('相似度') || !mixedDrag.text.includes('0.91') || mixedDrag.text.includes('匹配') || mixedDrag.width > 500) throw new Error(`mixed drag layout is invalid: ${JSON.stringify(mixedDrag)}`);

  const visibleImageClick = `[...document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyDraggable')].some(block => { const texts = [...block.querySelectorAll('.blocklyText')].filter(node => node.closest('.blocklyDraggable') === block && node.getBoundingClientRect().width > 0).map(node => node.textContent); return texts.some(text => text.includes('点击')) && texts.some(text => text.includes('使用')) && texts.some(text => text.includes('buttons/start.png')); })`;
  if (!await win.webContents.executeJavaScript(visibleImageClick)) throw new Error('selected image dropdown disappeared from click block');
  await clickBlocklyField(win.webContents, '使用', 'buttons/start.png');
  await selectBlocklyMenuItem(win.webContents, 'pages/home.png');
  await waitFor(win.webContents, `[...document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyDraggable')].some(block => { const texts = [...block.querySelectorAll('.blocklyText')].filter(node => node.closest('.blocklyDraggable') === block && node.getBoundingClientRect().width > 0).map(node => node.textContent); return texts.some(text => text.includes('点击')) && texts.some(text => text.includes('使用')) && texts.some(text => text.includes('pages/home.png')); })`);
  await clickBlocklyField(win.webContents, '使用', 'pages/home.png');
  await selectBlocklyMenuItem(win.webContents, 'buttons/start.png');
  await waitFor(win.webContents, visibleImageClick);

  const collapsedWaitHeight = await win.webContents.executeJavaScript(`(() => { const block = [...document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyDraggable')].find(node => [...node.querySelectorAll('.blocklyText')].some(text => text.closest('.blocklyDraggable') === node && text.textContent.includes('等待图片'))); return [...block.children].find(node => node.classList?.contains('blocklyPath')).getBoundingClientRect().height; })()`);
  await clickBlocklyField(win.webContents, '等待图片', '更多设置');
  await selectBlocklyMenuItem(win.webContents, '收起设置');
  await waitFor(win.webContents, `[...document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyText')].some(node => node.getBoundingClientRect().width > 0 && node.textContent.includes('375'))`);
  const expandedWait = await win.webContents.executeJavaScript(`(() => { const block = [...document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyDraggable')].find(node => [...node.querySelectorAll('.blocklyText')].some(text => text.closest('.blocklyDraggable') === node && text.textContent.includes('等待图片'))); const path = [...block.children].find(node => node.classList?.contains('blocklyPath')).getBoundingClientRect(); const text = [...block.querySelectorAll('.blocklyText')].filter(node => node.closest('.blocklyDraggable') === block && node.getBoundingClientRect().width > 0).map(node => node.textContent).join(''); return { height: path.height, text }; })()`);
  if (expandedWait.height <= collapsedWaitHeight || !expandedWait.text.includes('最短检测周期') || !expandedWait.text.includes('375') || !expandedWait.text.includes('透明遮罩')) throw new Error(`more settings did not expand correctly: ${JSON.stringify({ collapsedWaitHeight, expandedWait })}`);

  await clickToolboxCategory(win.webContents, '鼠标操作');
  await waitFor(win.webContents, `[...document.querySelectorAll('.blocklyFlyout')].some(node => getComputedStyle(node).display !== 'none' && node.querySelectorAll('.blocklyDraggable').length === 5)`);
  const mouseDefaults = await win.webContents.executeJavaScript(`(() => { const flyout = [...document.querySelectorAll('.blocklyFlyout')].find(node => getComputedStyle(node).display !== 'none' && node.querySelectorAll('.blocklyDraggable').length === 5); return [...flyout.querySelectorAll('.blocklyDraggable')].map(block => [...block.querySelectorAll('.blocklyText')].filter(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0).map(node => node.textContent).join('').replace(/\\s+/g, ' ').trim()); })()`);
  if (!mouseDefaults.some((text) => text.includes('点击坐标(点此可选图片)') && text.includes('5000,5000')) || !mouseDefaults.some((text) => text.includes('移动鼠标到坐标(点此可选图片)') && text.includes('5000,5000')) || !mouseDefaults.some((text) => text.includes('拖拽起点坐标(点此可选图片)') && text.includes('终点坐标(点此可选图片)') && text.includes('3000,5000') && text.includes('7000,5000')) || mouseDefaults.some((text) => text.includes('相似度'))) throw new Error(`mouse blocks do not default to coordinates: ${JSON.stringify(mouseDefaults)}`);

  await clickToolboxCategory(win.webContents, '识别与等待');
  await waitFor(win.webContents, `[...document.querySelectorAll('.blocklyFlyout')].some(node => getComputedStyle(node).display !== 'none' && node.querySelectorAll('.blocklyDraggable').length === 4)`);
  const recognitionDefaults = await win.webContents.executeJavaScript(`(() => { const flyout = [...document.querySelectorAll('.blocklyFlyout')].find(node => getComputedStyle(node).display !== 'none' && node.querySelectorAll('.blocklyDraggable').length === 4); return [...flyout.querySelectorAll('.blocklyDraggable')].map(block => [...block.querySelectorAll('.blocklyText')].filter(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0).map(node => node.textContent).join('').replace(/\\s+/g, ' ').trim()); })()`);
  if (recognitionDefaults.filter((text) => text.includes('请选择图片素材')).length !== 2 || recognitionDefaults.some((text) => /button\.png|ready\.png|done\.png|A\.png|B\.png/.test(text))) throw new Error(`required image placeholders are inconsistent: ${JSON.stringify(recognitionDefaults)}`);

  await clickToolboxCategory(win.webContents, '流程');
  await waitFor(win.webContents, `document.querySelector('.blocklyTreeSelected .blocklyTreeLabel')?.textContent === '流程' && [...document.querySelectorAll('.blocklyFlyout')].some(node => getComputedStyle(node).display !== 'none' && node.querySelectorAll('.blocklyDraggable').length >= 13)`);
  const flyoutMetrics = await win.webContents.executeJavaScript(`(() => { const metric = node => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, cssWidth: style.width, cssHeight: style.height, display: style.display, visibility: style.visibility, opacity: style.opacity, zIndex: style.zIndex }; }; const flyout = [...document.querySelectorAll('.blocklyFlyout')].find(node => getComputedStyle(node).display !== 'none' && node.querySelectorAll('.blocklyDraggable').length >= 13); const svg = document.querySelector('.automation-editor-content:not([hidden]) .blocklySvg'); return { flyout: metric(flyout), background: metric(flyout.querySelector('.blocklyFlyoutBackground')), blocks: [...flyout.querySelectorAll('.blocklyDraggable')].map(metric), toolbox: metric(document.querySelector('.automation-editor-content:not([hidden]) .blocklyToolboxDiv')), svg: metric(svg) }; })()`);
  if (!(Number(flyoutMetrics.toolbox.zIndex) > Number(flyoutMetrics.flyout.zIndex) && Number(flyoutMetrics.flyout.zIndex) > Number(flyoutMetrics.svg.zIndex))) throw new Error(`Blockly layer order is invalid: ${JSON.stringify(flyoutMetrics)}`);
  if (flyoutMetrics.flyout.cssWidth === '17px' || flyoutMetrics.flyout.cssHeight === '17px' || flyoutMetrics.blocks.length < 13) throw new Error(`flow flyout is invalid: ${JSON.stringify(flyoutMetrics)}`);
  const sortedFlowBlocks = [...flyoutMetrics.blocks].sort((a, b) => a.y - b.y);
  if (sortedFlowBlocks.some((block, index) => index > 0 && block.y < sortedFlowBlocks[index - 1].y + sortedFlowBlocks[index - 1].height - 1)) throw new Error(`flow flyout blocks overlap: ${JSON.stringify(sortedFlowBlocks)}`);
  const flowDefaults = await win.webContents.executeJavaScript(`(() => { const flyout = [...document.querySelectorAll('.blocklyFlyout')].find(node => getComputedStyle(node).display !== 'none' && node.querySelectorAll('.blocklyDraggable').length >= 13); return [...flyout.querySelectorAll('.blocklyDraggable')].map(block => [...block.querySelectorAll('.blocklyText')].filter(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0).map(node => node.textContent).join('').replace(/\\s+/g, ' ').trim()); })()`);
  const positionDefaults = flowDefaults.filter((text) => text.includes('目标A'));
  if (positionDefaults.length !== 2 || positionDefaults.some((text) => !text.includes('5000,5000') || text.includes('请选择图片素材'))) throw new Error(`position blocks do not default to coordinates: ${JSON.stringify(positionDefaults)}`);
  const dragProbe = await win.webContents.executeJavaScript(`(() => { const flyout = [...document.querySelectorAll('.blocklyFlyout')].find(node => getComputedStyle(node).display !== 'none' && node.querySelectorAll('.blocklyDraggable').length >= 13); const source = flyout.querySelector('.blocklyDraggable').getBoundingClientRect(); const host = document.querySelector('.automation-editor-content:not([hidden]) .automation-blockly-host').getBoundingClientRect(); return { before: document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyDraggable').length, source: { x: Math.round(source.left + source.width / 2), y: Math.round(source.top + source.height / 2) }, target: { x: Math.round(host.right - 45), y: Math.round(host.top + 90) } }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: dragProbe.source.x, y: dragProbe.source.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: dragProbe.source.x, y: dragProbe.source.y, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    const ratio = step / 8;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(dragProbe.source.x + (dragProbe.target.x - dragProbe.source.x) * ratio), y: Math.round(dragProbe.source.y + (dragProbe.target.y - dragProbe.source.y) * ratio), movementX: 10, movementY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: dragProbe.target.x, y: dragProbe.target.y, button: 'left', clickCount: 1 });
  await waitFor(win.webContents, `document.querySelectorAll('.automation-editor-content:not([hidden]) .blocklyBlockCanvas .blocklyDraggable').length > ${dragProbe.before}`);
  await clickButton(win.webContents, '.automation-editor-tabs button', 'JSON');
  await waitFor(win.webContents, `!document.querySelector('.automation-json-editor').hidden`);
  await clickButton(win.webContents, '.automation-editor-tabs button', '积木');
  await waitFor(win.webContents, `!document.querySelector('.automation-editor-content').hidden`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-page-header-actions button')].find(node => node.textContent.includes('新建脚本'))).click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-dialog[role="dialog"]')`);
  const createDialog = await win.webContents.executeJavaScript(`(() => ({ title: document.querySelector('.automation-dialog h2')?.textContent, inputs: document.querySelectorAll('.automation-dialog input').length }))()`);
  if (createDialog.title !== '新建自动化脚本' || createDialog.inputs !== 2) throw new Error(`create dialog missing: ${JSON.stringify(createDialog)}`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-dialog button')].find(node => node.textContent.includes('取消'))).click()`);
  await waitFor(win.webContents, `!document.querySelector('.automation-dialog')`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-page-header-actions button')].find(node => node.textContent.includes('保存修改'))).click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-editor-tabs span')?.textContent.includes('保存')`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('JSON'))).click()`);
  await waitFor(win.webContents, `!document.querySelector('.automation-json-editor').hidden`);
  const editorRoundTrip = await win.webContents.executeJavaScript(`(() => { const workflow = JSON.parse(document.querySelector('.automation-json-editor textarea').value); return { ready: workflow.readyWhen, condition: workflow.root.steps.find(item => item.type === 'if-condition')?.condition, wait: workflow.root.steps.find(item => item.type === 'wait-image'), click: workflow.root.steps.find(item => item.type === 'click-image'), coordinateClick: workflow.root.steps.find(item => item.type === 'click-coordinate'), randomClick: workflow.root.steps.find(item => item.type === 'random-click-region'), visionRegion: workflow.root.steps.find(item => item.type === 'vision-region'), moveCoordinate: workflow.root.steps.find(item => item.type === 'move-to-coordinate'), generalDrag: workflow.root.steps.find(item => item.type === 'drag'), waitBranch: workflow.root.steps.find(item => item.type === 'wait-condition-branch'), drag: workflow.root.steps.find(item => item.type === 'drag-image') }; })()`);
  if (editorRoundTrip.ready?.type !== 'all' || editorRoundTrip.ready.conditions?.[1]?.type !== 'not') throw new Error(`combined ready condition round trip failed: ${JSON.stringify(editorRoundTrip.ready)}`);
  if (editorRoundTrip.condition?.type !== 'any' || editorRoundTrip.condition.conditions?.[1]?.type !== 'not') throw new Error(`combined condition round trip failed: ${JSON.stringify(editorRoundTrip.condition)}`);
  if (editorRoundTrip.wait?.minCycleMs !== 375 || editorRoundTrip.wait?.region?.width !== 640 || editorRoundTrip.wait?.scales?.length !== 3 || editorRoundTrip.wait?.mask !== 'alpha' || [...new Set([editorRoundTrip.wait?.asset, ...(editorRoundTrip.wait?.alternatives ?? [])])].sort().join(',') !== 'buttons/start-hover.png,buttons/start.png') throw new Error(`advanced image fields were lost: ${JSON.stringify(editorRoundTrip.wait)}`);
  if (editorRoundTrip.click?.offset?.x !== 7 || editorRoundTrip.click?.offset?.y !== -4 || editorRoundTrip.click?.minCycleMs !== 250) throw new Error(`advanced click fields were lost: ${JSON.stringify(editorRoundTrip.click)}`);
  if (editorRoundTrip.coordinateClick?.coordinate?.x !== 6250 || editorRoundTrip.coordinateClick?.coordinate?.y !== 3750 || editorRoundTrip.coordinateClick?.button !== 'right' || editorRoundTrip.coordinateClick?.clickCount !== 2) throw new Error(`coordinate click fields were lost: ${JSON.stringify(editorRoundTrip.coordinateClick)}`);
  if (editorRoundTrip.randomClick?.region?.left !== 2000 || editorRoundTrip.randomClick?.region?.bottom !== 7500 || editorRoundTrip.randomClick?.clickCount !== 2 || editorRoundTrip.randomClick?.padding !== 250) throw new Error(`random region click fields were lost: ${JSON.stringify(editorRoundTrip.randomClick)}`);
  if (editorRoundTrip.visionRegion?.region?.left !== 6000 || editorRoundTrip.visionRegion?.region?.bottom !== 4000 || editorRoundTrip.visionRegion?.body?.steps?.[0]?.asset !== 'buttons/start.png') throw new Error(`fast recognition region round trip failed: ${JSON.stringify(editorRoundTrip.visionRegion)}`);
  if (editorRoundTrip.moveCoordinate?.coordinate?.x !== 6000 || editorRoundTrip.moveCoordinate?.coordinate?.y !== 3500) throw new Error(`coordinate move fields were lost: ${JSON.stringify(editorRoundTrip.moveCoordinate)}`);
  if (editorRoundTrip.generalDrag?.source?.coordinate?.x !== 2500 || editorRoundTrip.generalDrag?.target?.condition?.asset !== 'pages/home.png' || editorRoundTrip.generalDrag?.target?.condition?.mask !== 'alpha' || editorRoundTrip.generalDrag?.durationMs !== 700) throw new Error(`general drag fields were lost: ${JSON.stringify(editorRoundTrip.generalDrag)}`);
  if (editorRoundTrip.waitBranch?.timeoutMs !== 5000 || editorRoundTrip.waitBranch?.success?.steps?.[0]?.message !== 'ready' || editorRoundTrip.waitBranch?.timeout?.steps?.[0]?.result !== 'failure') throw new Error(`wait branch fields were lost: ${JSON.stringify(editorRoundTrip.waitBranch)}`);
  if (editorRoundTrip.drag?.source?.threshold !== 0.88 || editorRoundTrip.drag?.source?.alternatives?.length !== 1 || editorRoundTrip.drag?.target?.threshold !== 0.93 || editorRoundTrip.drag?.target?.mask !== 'none' || editorRoundTrip.drag?.durationMs !== 1200 || editorRoundTrip.drag?.minCycleMs !== 300) throw new Error(`drag image fields were lost: ${JSON.stringify(editorRoundTrip.drag)}`);
  await win.webContents.executeJavaScript(`window.confirm = () => true; ([...document.querySelectorAll('.automation-library > button')].find(node => node.textContent.includes('M4 第二脚本'))).click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-editor-meta input')?.value === 'M4 第二脚本'`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('积木'))).click()`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('JSON'))).click()`);
  await waitFor(win.webContents, `JSON.parse(document.querySelector('.automation-json-editor textarea').value).root.steps[0]?.durationMs === 2222 && JSON.parse(document.querySelector('.automation-json-editor textarea').value).searchRegion?.right === 8800`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-library > button')].find(node => node.textContent.includes('M4 工作台验证'))).click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-editor-meta input')?.value === 'M4 工作台验证'`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('积木'))).click()`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('JSON'))).click()`);
  await waitFor(win.webContents, `JSON.parse(document.querySelector('.automation-json-editor textarea').value).root.steps[0]?.type === 'wait-image'`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('积木'))).click()`);
  const testBenchTab = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('素材测试台'))?.textContent`);
  if (!testBenchTab) throw new Error('asset test bench tab missing');
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('素材测试台'))).click()`);
  await waitFor(win.webContents, `!document.querySelector('.automation-test-editor').hidden`);
  await win.webContents.executeJavaScript(`document.querySelector('.automation-test-scene-empty').click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-test-scene-image img')`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-test-bench-toolbar button')].find(node => node.textContent.includes('开始比对'))).click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-match-highlight.matched')`);
  const testBenchMetrics = await win.webContents.executeJavaScript(`(() => { const scene = document.querySelector('.automation-test-scene').getBoundingClientRect(); const strip = document.querySelector('.automation-test-assets-strip').getBoundingClientRect(); const highlight = document.querySelector('.automation-match-highlight').getBoundingClientRect(); return { scene: { width: scene.width, height: scene.height }, strip: { width: strip.width, height: strip.height }, highlight: { width: highlight.width, height: highlight.height }, score: document.querySelector('.automation-match-highlight span')?.textContent, mask: document.querySelector('.automation-mask-mode select')?.value }; })()`);
  if (testBenchMetrics.scene.height <= testBenchMetrics.strip.height || testBenchMetrics.highlight.width <= 0 || testBenchMetrics.score !== '93.4%' || testBenchMetrics.mask !== 'auto') throw new Error(`asset test bench layout invalid: ${JSON.stringify(testBenchMetrics)}`);
  fs.mkdirSync(path.join(ROOT, 'release', 'automation-probe'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'release', 'automation-probe', 'm5-asset-test-bench.png'), (await win.webContents.capturePage()).toPNG());
  const out = path.join(ROOT, 'release', 'automation-probe'); fs.mkdirSync(out, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 450));
  fs.writeFileSync(path.join(out, 'm4-flyout.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out, 'm4-workbench.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.address-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'https://example.com/game');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  })()`);
  await waitFor(win.webContents, `document.querySelector('.sidebar-toggle-button')`);
  await win.webContents.executeJavaScript(`document.querySelector('.sidebar-toggle-button').click()`);
  await waitFor(win.webContents, `document.querySelector('.library-sidebar-footer')`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.library-sidebar-footer button')].find(node => node.textContent.includes('自动化'))).click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-panel')`);
  const runnerButtons = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.automation-panel-actions button')].map(node => node.textContent.trim())`);
  if (!runnerButtons.includes('检查就绪') || !runnerButtons.includes('立即启动') || !runnerButtons.includes('停止')) throw new Error(`runner controls missing: ${runnerButtons.join(',')}`);
  const currentStep = await win.webContents.executeJavaScript(`document.querySelector('.automation-status-card small')?.textContent`);
  if (!currentStep.includes('第 2 步') || !currentStep.includes('点击图片')) throw new Error(`current step missing: ${currentStep}`);
  const assetTestButton = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.automation-asset-test button')].find(node => node.textContent.includes('在当前网页测试'))?.textContent`);
  if (!assetTestButton) throw new Error('asset test controls missing');
  const captureButton = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.automation-panel > button')].find(node => node.textContent.includes('从当前网页截取素材'))?.textContent`);
  if (!captureButton) throw new Error('asset capture control missing');
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-panel > button')].find(node => node.textContent.includes('从当前网页截取素材'))).click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-capture-editor img')`);
  const captureEditor = await win.webContents.executeJavaScript(`(() => ({ canvas: Boolean(document.querySelector('.automation-capture-canvas')), input: document.querySelector('.automation-capture-editor input')?.value }))()`);
  if (!captureEditor.canvas || !captureEditor.input?.endsWith('.png')) throw new Error(`asset capture editor missing: ${JSON.stringify(captureEditor)}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.writeFileSync(path.join(out, 'm5-capture-editor.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('.automation-capture-editor .automation-panel-heading button').click()`);
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-asset-test button')].find(node => node.textContent.includes('在当前网页测试'))).click()`);
  await waitFor(win.webContents, `document.querySelector('.automation-asset-test-result.matched')?.textContent.includes('97.0%')`);
  const debugControls = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.automation-debug-controls button')].map(node => node.textContent.trim())`);
  const logCount = await win.webContents.executeJavaScript(`document.querySelector('.automation-run-log summary strong')?.textContent`);
  if (!debugControls.includes('单步启动') || !debugControls.includes('下一步') || logCount !== '2') throw new Error(`debug controls missing: ${JSON.stringify({ debugControls, logCount })}`);
  const historyCount = await win.webContents.executeJavaScript(`document.querySelector('.automation-run-history summary strong')?.textContent`);
  if (historyCount !== '1') throw new Error(`run history missing: ${historyCount}`);
  const panelMetrics = await win.webContents.executeJavaScript(`(() => { const metric = selector => { const node = document.querySelector(selector); const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: getComputedStyle(node).display, opacity: getComputedStyle(node).opacity, visibility: getComputedStyle(node).visibility }; }; return { panel: metric('.automation-panel'), manage: metric('.automation-panel-manage'), status: metric('.automation-status-card') }; })()`);
  const footerLabels = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.library-sidebar-footer span')].map(node => ({ text: node.textContent, height: node.getBoundingClientRect().height, whiteSpace: getComputedStyle(node).whiteSpace }))`);
  if (footerLabels.some((label) => label.height > 20 || label.whiteSpace !== 'nowrap')) throw new Error(`sidebar footer label wrapped: ${JSON.stringify(footerLabels)}`);
  await new Promise((resolve) => setTimeout(resolve, 450));
  fs.writeFileSync(path.join(out, 'm4-runner-panel-v2.png'), (await win.webContents.capturePage()).toPNG());
  console.log('[automation-m4-workbench] PASS', JSON.stringify({ ...result, flyoutMetrics, panelMetrics, footerLabels }));
  clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[automation-m4-workbench] FAIL:', error?.stack || error); app.exit(1); });
