(function () {
  'use strict';

  const state = { assets: [], assetContents: new Map() };
  const $ = (id) => document.getElementById(id);
  const imageExtensions = /\.(png|jpe?g|webp)$/i;

  function assetOptions(allowEmpty) {
    const options = state.assets.map((asset) => [asset, asset]);
    if (allowEmpty) options.unshift(['（总是就绪）', '']);
    return options.length ? options : [['（请先扫描素材）', '']];
  }

  function imageFields(block, prefix, allowEmpty) {
    block.appendDummyInput()
      .appendField(prefix)
      .appendField(new Blockly.FieldDropdown(assetOptions(allowEmpty)), 'ASSET')
      .appendField('相似度')
      .appendField(new Blockly.FieldNumber(0.9, 0.1, 1, 0.01), 'THRESHOLD');
    block.appendDummyInput()
      .appendField('缩放')
      .appendField(new Blockly.FieldDropdown([['原尺寸', '1'], ['轻度 85%~115%', '0.85,1,1.15'], ['宽幅 50%~150%', '0.5,0.75,1,1.25,1.5']]), 'SCALES')
      .appendField('遮罩')
      .appendField(new Blockly.FieldDropdown([['关闭', 'none'], ['PNG 透明区域', 'alpha']]), 'MASK');
  }

  Blockly.Blocks.bao_start = { init: function () {
    imageFields(this, '识别到', true);
    this.appendDummyInput().appendField('时就绪');
    this.appendStatementInput('DO').appendField('执行');
    this.setColour(265);
    this.setTooltip('脚本入口和启动前提条件');
  } };
  Blockly.Blocks.bao_wait_image = { init: function () {
    imageFields(this, '等待图片', false);
    this.appendDummyInput().appendField('超时毫秒').appendField(new Blockly.FieldNumber(10000, 1, 3600000, 100), 'TIMEOUT');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(205);
  } };
  Blockly.Blocks.bao_wait_image_state = { init: function () {
    imageFields(this, '等待图片', false);
    this.appendDummyInput().appendField('变为').appendField(new Blockly.FieldDropdown([['出现', 'visible'], ['消失', 'hidden']]), 'STATE')
      .appendField('超时毫秒').appendField(new Blockly.FieldNumber(10000, 1, 3600000, 100), 'TIMEOUT');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(205);
  } };
  Blockly.Blocks.bao_click_image = { init: function () {
    imageFields(this, '点击图片', false);
    this.appendDummyInput().appendField('按钮').appendField(new Blockly.FieldDropdown([['左键', 'left'], ['右键', 'right'], ['中键', 'middle']]), 'BUTTON')
      .appendField('次数').appendField(new Blockly.FieldDropdown([['单击', '1'], ['双击', '2'], ['三击', '3']]), 'COUNT');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(205);
  } };
  Blockly.Blocks.bao_move_to_image = { init: function () {
    imageFields(this, '移动到图片', false);
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(205);
  } };
  Blockly.Blocks.bao_delay = { init: function () {
    this.appendDummyInput().appendField('等待').appendField(new Blockly.FieldNumber(500, 0, 3600000, 50), 'DURATION').appendField('毫秒');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(45);
  } };
  Blockly.Blocks.bao_key_press = { init: function () {
    this.appendDummyInput().appendField('按键').appendField(new Blockly.FieldTextInput('Enter'), 'KEY');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(120);
  } };
  Blockly.Blocks.bao_text_input = { init: function () {
    this.appendDummyInput().appendField('输入文本').appendField(new Blockly.FieldTextInput('你好'), 'TEXT')
      .appendField('间隔').appendField(new Blockly.FieldNumber(0, 0, 10000, 10), 'INTERVAL').appendField('毫秒');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(120);
  } };
  Blockly.Blocks.bao_scroll = { init: function () {
    this.appendDummyInput().appendField('滚轮 横向').appendField(new Blockly.FieldNumber(0, -100000, 100000, 10), 'X')
      .appendField('纵向').appendField(new Blockly.FieldNumber(480, -100000, 100000, 10), 'Y');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(120);
  } };
  Blockly.Blocks.bao_navigate = { init: function () {
    this.appendDummyInput().appendField('打开网址').appendField(new Blockly.FieldTextInput('https://example.com/'), 'URL');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(170);
  } };
  Blockly.Blocks.bao_reload = { init: function () {
    this.appendDummyInput().appendField('刷新当前页面');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(170);
  } };
  Blockly.Blocks.bao_log = { init: function () {
    this.appendDummyInput().appendField('记录日志').appendField(new Blockly.FieldTextInput('执行到这里'), 'MESSAGE');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(65);
  } };
  Blockly.Blocks.bao_if_image = { init: function () {
    this.appendDummyInput().appendField('如果').appendField(new Blockly.FieldDropdown([['识别到', 'found'], ['未识别到', 'missing']]), 'MODE');
    imageFields(this, '', false);
    this.appendStatementInput('THEN').appendField('那么');
    this.appendStatementInput('ELSE').appendField('否则');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(330);
  } };
  Blockly.Blocks.bao_repeat = { init: function () {
    this.appendDummyInput().appendField('重复').appendField(new Blockly.FieldNumber(2, 1, 1000, 1), 'TIMES').appendField('次');
    this.appendStatementInput('DO').appendField('执行');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(20);
  } };
  Blockly.Blocks.bao_repeat_until_image = { init: function () {
    this.appendDummyInput().appendField('重复直到图片').appendField(new Blockly.FieldDropdown(assetOptions(false)), 'ASSET')
      .appendField(new Blockly.FieldDropdown([['出现', 'visible'], ['消失', 'hidden']]), 'UNTIL');
    this.appendDummyInput().appendField('最多').appendField(new Blockly.FieldNumber(20, 1, 1000, 1), 'MAX')
      .appendField('次 间隔').appendField(new Blockly.FieldNumber(200, 0, 3600000, 50), 'DELAY').appendField('毫秒')
      .appendField('缩放').appendField(new Blockly.FieldDropdown([['原尺寸', '1'], ['轻度', '0.85,1,1.15'], ['宽幅', '0.5,0.75,1,1.25,1.5']]), 'SCALES')
      .appendField('遮罩').appendField(new Blockly.FieldDropdown([['关闭', 'none'], ['Alpha', 'alpha']]), 'MASK');
    this.appendStatementInput('DO').appendField('执行');
    this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(20);
  } };

  const toolbox = {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: '入口', colour: '265', contents: [{ kind: 'block', type: 'bao_start' }] },
      { kind: 'category', name: '图像', colour: '205', contents: [{ kind: 'block', type: 'bao_wait_image' }, { kind: 'block', type: 'bao_wait_image_state' }, { kind: 'block', type: 'bao_click_image' }, { kind: 'block', type: 'bao_move_to_image' }] },
      { kind: 'category', name: '输入', colour: '120', contents: [{ kind: 'block', type: 'bao_key_press' }, { kind: 'block', type: 'bao_text_input' }, { kind: 'block', type: 'bao_scroll' }] },
      { kind: 'category', name: '页面', colour: '170', contents: [{ kind: 'block', type: 'bao_navigate' }, { kind: 'block', type: 'bao_reload' }] },
      { kind: 'category', name: '流程', colour: '330', contents: [{ kind: 'block', type: 'bao_if_image' }, { kind: 'block', type: 'bao_repeat' }, { kind: 'block', type: 'bao_repeat_until_image' }, { kind: 'block', type: 'bao_delay' }] },
      { kind: 'category', name: '调试', colour: '65', contents: [{ kind: 'block', type: 'bao_log' }] },
    ],
  };

  const workspace = Blockly.inject('blockly-workspace', {
    media: '../../node_modules/blockly/media/', toolbox, trashcan: true,
    zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 1.5, minScale: 0.5 },
    grid: { spacing: 20, length: 3, colour: '#dce3ef', snap: true },
  });

  const categoryColours = ['#7b59ad', '#5688a8', '#58a966', '#58a99f', '#ad587b', '#9aaa52'];
  document.querySelectorAll('.blocklyToolboxCategory').forEach((category, index) => {
    category.querySelector('.blocklyTreeRow')?.style.setProperty('--bao-category-colour', categoryColours[index] || '#5677a8');
  });

  function number(block, field) { return Number(block.getFieldValue(field)); }
  function searchOptions(block) {
    return {
      threshold: number(block, 'THRESHOLD'),
      scales: String(block.getFieldValue('SCALES') || '1').split(',').map(Number),
      mask: block.getFieldValue('MASK') || 'none',
    };
  }
  function condition(block) {
    return { type: 'image-visible', asset: block.getFieldValue('ASSET'), ...searchOptions(block) };
  }
  function sequence(firstBlock) {
    const steps = [];
    let block = firstBlock;
    while (block) {
      steps.push(compileBlock(block));
      block = block.getNextBlock();
    }
    return { type: 'sequence', steps };
  }
  function compileBlock(block) {
    switch (block.type) {
      case 'bao_wait_image': return { type: 'wait-image', asset: block.getFieldValue('ASSET'), ...searchOptions(block), timeoutMs: number(block, 'TIMEOUT') };
      case 'bao_wait_image_state': return { type: 'wait-image-state', asset: block.getFieldValue('ASSET'), state: block.getFieldValue('STATE'), ...searchOptions(block), timeoutMs: number(block, 'TIMEOUT') };
      case 'bao_click_image': return { type: 'click-image', asset: block.getFieldValue('ASSET'), ...searchOptions(block), button: block.getFieldValue('BUTTON'), clickCount: number(block, 'COUNT') };
      case 'bao_move_to_image': return { type: 'move-to-image', asset: block.getFieldValue('ASSET'), ...searchOptions(block) };
      case 'bao_delay': return { type: 'delay', durationMs: number(block, 'DURATION') };
      case 'bao_key_press': return { type: 'key-press', key: block.getFieldValue('KEY') };
      case 'bao_text_input': return { type: 'text-input', text: block.getFieldValue('TEXT'), intervalMs: number(block, 'INTERVAL') };
      case 'bao_scroll': return { type: 'scroll', deltaX: number(block, 'X'), deltaY: number(block, 'Y') };
      case 'bao_navigate': return { type: 'navigate', url: block.getFieldValue('URL') };
      case 'bao_reload': return { type: 'reload' };
      case 'bao_log': return { type: 'log', message: block.getFieldValue('MESSAGE') };
      case 'bao_if_image': return { type: 'if-image', condition: condition(block), negate: block.getFieldValue('MODE') === 'missing', then: sequence(block.getInputTargetBlock('THEN')), else: sequence(block.getInputTargetBlock('ELSE')) };
      case 'bao_repeat': return { type: 'repeat', times: number(block, 'TIMES'), body: sequence(block.getInputTargetBlock('DO')) };
      case 'bao_repeat_until_image': return { type: 'repeat-until-image', condition: { type: 'image-visible', asset: block.getFieldValue('ASSET'), threshold: 0.9, scales: String(block.getFieldValue('SCALES')).split(',').map(Number), mask: block.getFieldValue('MASK') }, until: block.getFieldValue('UNTIL'), maxIterations: number(block, 'MAX'), delayMs: number(block, 'DELAY'), body: sequence(block.getInputTargetBlock('DO')) };
      default: throw new Error('不支持的积木：' + block.type);
    }
  }
  function compileWorkflow() {
    const starts = workspace.getTopBlocks(true).filter((block) => block.type === 'bao_start');
    if (starts.length !== 1) throw new Error('工作区必须且只能有一个“就绪入口”积木');
    const start = starts[0];
    const readyAsset = start.getFieldValue('ASSET');
    const workflow = {
      formatVersion: 2,
      viewport: { mode: 'fixed', width: 1280, height: 720 },
      id: $('workflow-id').value.trim(),
      name: $('workflow-name').value.trim(),
      description: $('workflow-description').value.trim() || undefined,
      root: sequence(start.getInputTargetBlock('DO')),
    };
    if (!workflow.id || !workflow.name) throw new Error('脚本 ID 和名称不能为空');
    if (readyAsset) workflow.readyWhen = { type: 'image-visible', asset: readyAsset, threshold: number(start, 'THRESHOLD') };
    return workflow;
  }

  function setAssets(assets) {
    state.assets = [...new Set(assets.filter((asset) => imageExtensions.test(asset) && isSafeAssetPath(asset)))].sort();
    $('asset-count').textContent = String(state.assets.length);
    $('asset-empty').hidden = state.assets.length > 0;
    $('asset-list').replaceChildren(...state.assets.map((asset) => {
      const item = document.createElement('li'); item.textContent = asset; return item;
    }));
    for (const block of workspace.getAllBlocks(false)) {
      const field = block.getField('ASSET');
      if (field) {
        const allowEmpty = block.type === 'bao_start';
        const previous = field.getValue();
        field.menuGenerator_ = assetOptions(allowEmpty);
        if (!state.assets.includes(previous) && !(allowEmpty && previous === '')) {
          field.setValue(state.assets[0] || '');
        }
      }
    }
    $('status').textContent = `已扫描 ${state.assets.length} 个素材`;
  }

  function isSafeAssetPath(asset) {
    return Boolean(asset) && !asset.includes('\\') && !asset.startsWith('/') && asset.split('/').every((part) => part && part !== '.' && part !== '..');
  }

  function setAssetContents(contents) {
    state.assetContents.clear();
    for (const [asset, bytes] of Object.entries(contents || {})) {
      if (imageExtensions.test(asset) && isSafeAssetPath(asset)) state.assetContents.set(asset, Uint8Array.from(bytes));
    }
    setAssets([...state.assetContents.keys()]);
  }

  async function readFileBytes(file) {
    if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
    return new Uint8Array(await new Response(file).arrayBuffer());
  }

  async function buildPackage() {
    const workflow = compileWorkflow();
    const missing = state.assets.filter((asset) => !state.assetContents.has(asset));
    if (missing.length) throw new Error(`请重新扫描素材目录，缺少 ${missing.length} 个素材文件内容`);
    const manifest = {
      format: 'baoauto', formatVersion: 2, id: workflow.id, name: workflow.name,
      workflow: 'workflow.json', assets: 'assets/', createdBy: 'BaoFlash Automation Workbench',
    };
    const archive = {
      'manifest.json': fflate.strToU8(JSON.stringify(manifest, null, 2)),
      'workflow.json': fflate.strToU8(JSON.stringify(workflow, null, 2)),
    };
    for (const asset of state.assets) archive[`assets/${asset}`] = state.assetContents.get(asset);
    return fflate.zipSync(archive, { level: 6 });
  }

  async function exportPackage() {
    const workflow = compileWorkflow();
    const bytes = await buildPackage();
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `${workflow.id}.baoauto`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    $('status').textContent = `已导出 ${link.download}（${Math.ceil(bytes.byteLength / 1024)} KB）`;
  }

  function exportProject() {
    const payload = {
      format: 'baoauto-workbench', formatVersion: 1,
      assets: state.assets,
      workspace: Blockly.serialization.workspaces.save(workspace),
      workflow: compileWorkflow(),
    };
    $('project-json').value = JSON.stringify(payload, null, 2);
    $('status').textContent = '项目 JSON 已生成';
    return payload;
  }

  function importProject(payload) {
    if (!payload || payload.format !== 'baoauto-workbench' || payload.formatVersion !== 1 || !payload.workspace) throw new Error('不是受支持的工作台项目');
    state.assetContents.clear();
    setAssets(Array.isArray(payload.assets) ? payload.assets : []);
    workspace.clear();
    Blockly.serialization.workspaces.load(payload.workspace, workspace);
    if (payload.workflow) {
      $('workflow-id').value = payload.workflow.id || '';
      $('workflow-name').value = payload.workflow.name || '';
      $('workflow-description').value = payload.workflow.description || '';
    }
    $('status').textContent = '项目 JSON 已导入';
  }

  $('asset-folder').addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    const paths = files.map((file) => file.webkitRelativePath || file.name);
    const root = paths[0] && paths[0].includes('/') ? paths[0].split('/')[0] + '/' : '';
    const logicalPaths = paths.map((value) => value.startsWith(root) ? value.slice(root.length) : value);
    state.assetContents.clear();
    Promise.all(files.map(async (file, index) => {
      const asset = logicalPaths[index];
      if (imageExtensions.test(asset) && isSafeAssetPath(asset)) state.assetContents.set(asset, await readFileBytes(file));
    })).then(() => setAssets([...state.assetContents.keys()])).catch((error) => { $('status').textContent = error.message; });
  });
  $('export-workspace').addEventListener('click', () => { try { exportProject(); } catch (error) { $('status').textContent = error.message; } });
  $('import-workspace').addEventListener('click', () => { try { importProject(JSON.parse($('project-json').value)); } catch (error) { $('status').textContent = error.message; } });
  $('preview-workflow').addEventListener('click', () => { try { $('project-json').value = JSON.stringify(compileWorkflow(), null, 2); $('status').textContent = 'workflow.json 已生成'; } catch (error) { $('status').textContent = error.message; } });
  $('export-package').addEventListener('click', () => { exportPackage().catch((error) => { $('status').textContent = error.message; }); });

  function seed() {
    const start = workspace.newBlock('bao_start');
    const wait = workspace.newBlock('bao_wait_image');
    const click = workspace.newBlock('bao_click_image');
    const repeat = workspace.newBlock('bao_repeat');
    const delay = workspace.newBlock('bao_delay');
    for (const block of [start, wait, click, repeat, delay]) { block.initSvg(); block.render(); }
    start.getInput('DO').connection.connect(wait.previousConnection);
    wait.nextConnection.connect(click.previousConnection);
    click.nextConnection.connect(repeat.previousConnection);
    repeat.getInput('DO').connection.connect(delay.previousConnection);
    start.moveBy(50, 40);
  }
  seed();

  window.__baoWorkbench = { workspace, setAssets, setAssetContents, compileWorkflow, buildPackage, exportPackage, exportProject, importProject, version: 2 };
})();
