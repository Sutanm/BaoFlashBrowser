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

async function setToolboxSelection(wc, text, selected) {
  await wc.executeJavaScript(`(() => {
    document.querySelectorAll('.blocklyTreeSelected').forEach(node => node.classList.remove('blocklyTreeSelected'));
    const label = [...document.querySelectorAll('.blocklyTreeLabel')].find(node => node.textContent === ${JSON.stringify(text)});
    if (${JSON.stringify(selected)}) label.closest('.blocklyTreeRow').classList.add('blocklyTreeSelected');
    document.querySelector('.blocklyFlyout').style.display = ${JSON.stringify(selected ? 'block' : 'none')};
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1360, height: 820,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'automation-m4-preload.cjs') },
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
    newBlockTypes: ['bao_start_unconditional', 'bao_start_condition', 'bao_key_combo', 'bao_hold_key_until_image', 'bao_if_condition', 'bao_wait_condition', 'bao_repeat_until_condition', 'bao_condition_image', 'bao_condition_and', 'bao_condition_or', 'bao_condition_not'].map(type => ({ type, registered: document.querySelector('.automation-blockly-host')?.dataset.blockTypes?.split(' ').includes(type) })),
  }))()`);
  if (result.title !== '自动化工作台') throw new Error(`unexpected title: ${result.title}`);
  if (result.scripts !== 1 || result.blocks < 3) throw new Error(`workbench content missing: ${JSON.stringify(result)}`);
  if (!result.categories.includes('图像') || !result.categories.includes('流程') || !result.jsonMode) throw new Error(`workbench controls missing: ${JSON.stringify(result)}`);
  if (!result.canCreate || result.createDisabled || result.libraryActions !== 2 || result.assetRows !== 3 || !result.assetPreview || !result.assetSearch || !result.folderLink || result.imageGroups.length !== 1 || !result.diagnosticButton) throw new Error(`library management missing: ${JSON.stringify(result)}`);
  if (result.newBlockTypes.some((block) => !block.registered)) throw new Error(`new automation blocks missing: ${JSON.stringify(result.newBlockTypes)}`);
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
  const editorRoundTrip = await win.webContents.executeJavaScript(`(() => { const workflow = JSON.parse(document.querySelector('.automation-json-editor textarea').value); return { ready: workflow.readyWhen, condition: workflow.root.steps.find(item => item.type === 'if-condition')?.condition, wait: workflow.root.steps.find(item => item.type === 'wait-image'), click: workflow.root.steps.find(item => item.type === 'click-image') }; })()`);
  if (editorRoundTrip.ready?.type !== 'all' || editorRoundTrip.ready.conditions?.[1]?.type !== 'not') throw new Error(`combined ready condition round trip failed: ${JSON.stringify(editorRoundTrip.ready)}`);
  if (editorRoundTrip.condition?.type !== 'any' || editorRoundTrip.condition.conditions?.[1]?.type !== 'not') throw new Error(`combined condition round trip failed: ${JSON.stringify(editorRoundTrip.condition)}`);
  if (editorRoundTrip.wait?.pollMs !== 375 || editorRoundTrip.wait?.region?.width !== 640 || editorRoundTrip.wait?.scales?.length !== 3 || editorRoundTrip.wait?.mask !== 'alpha' || [...new Set([editorRoundTrip.wait?.asset, ...(editorRoundTrip.wait?.alternatives ?? [])])].sort().join(',') !== 'buttons/start-hover.png,buttons/start.png') throw new Error(`advanced image fields were lost: ${JSON.stringify(editorRoundTrip.wait)}`);
  if (editorRoundTrip.click?.offset?.x !== 7 || editorRoundTrip.click?.offset?.y !== -4 || editorRoundTrip.click?.pollMs !== 250) throw new Error(`advanced click fields were lost: ${JSON.stringify(editorRoundTrip.click)}`);
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
  await win.webContents.executeJavaScript(`([...document.querySelectorAll('.automation-editor-tabs button')].find(node => node.textContent.includes('积木'))).click()`);
  await setToolboxSelection(win.webContents, '流程', true);
  await waitFor(win.webContents, `document.querySelector('.blocklyTreeSelected') && getComputedStyle(document.querySelector('.blocklyFlyout')).display !== 'none'`);
  const flyoutMetrics = await win.webContents.executeJavaScript(`(() => { const metric = node => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, cssWidth: style.width, cssHeight: style.height, display: style.display, visibility: style.visibility, opacity: style.opacity, zIndex: style.zIndex }; }; const flyout = document.querySelector('.blocklyFlyout'); const svg = document.querySelector('.blocklySvg'); return { flyout: metric(flyout), background: metric(document.querySelector('.blocklyFlyoutBackground')), blocks: [...flyout.querySelectorAll('.blocklyDraggable')].map(metric), toolbox: metric(document.querySelector('.blocklyToolboxDiv')), svg: metric(svg) }; })()`);
  if (!(Number(flyoutMetrics.toolbox.zIndex) > Number(flyoutMetrics.flyout.zIndex) && Number(flyoutMetrics.flyout.zIndex) > Number(flyoutMetrics.svg.zIndex))) throw new Error(`Blockly layer order is invalid: ${JSON.stringify(flyoutMetrics)}`);
  if (flyoutMetrics.flyout.cssWidth === '17px' || flyoutMetrics.flyout.cssHeight === '17px') throw new Error(`Blockly flyout was resized as an icon: ${JSON.stringify(flyoutMetrics.flyout)}`);
  await setToolboxSelection(win.webContents, '流程', false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const collapsedFlyout = await win.webContents.executeJavaScript(`(() => { const metric = node => node && ({ className: node.getAttribute('class'), display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }); return { selected: document.querySelectorAll('.blocklyTreeSelected').length, flyout: metric(document.querySelector('.blocklyFlyout')), scrollbars: [...document.querySelectorAll('.blocklyFlyoutScrollbar')].map(metric) }; })()`);
  if (collapsedFlyout.selected !== 0 || collapsedFlyout.flyout.display !== 'none' || collapsedFlyout.scrollbars.some((bar) => bar.display !== 'none' && bar.width > 0 && bar.height > 0)) throw new Error(`collapsed Blockly flyout left visible residue: ${JSON.stringify(collapsedFlyout)}`);
  await setToolboxSelection(win.webContents, '流程', true);
  await waitFor(win.webContents, `document.querySelector('.blocklyTreeSelected') && getComputedStyle(document.querySelector('.blocklyFlyout')).display !== 'none'`);
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
