const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const timeout = setTimeout(() => { console.error('[automation-m1-workbench] FAIL: timed out'); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 820,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await win.loadFile(path.join(ROOT, 'tools', 'automation-demo', 'workbench.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const api = window.__baoWorkbench;
    api.setAssets(['pages/home.png', 'buttons/start.png', 'dialogs/reward.webp', 'ignore.txt']);
    let blocks = api.workspace.getAllBlocks(false);
    blocks.find(block => block.type === 'bao_start').setFieldValue('pages/home.png', 'ASSET');
    blocks.find(block => block.type === 'bao_wait_image').setFieldValue('buttons/start.png', 'ASSET');
    blocks.find(block => block.type === 'bao_click_image').setFieldValue('buttons/start.png', 'ASSET');
    let tail = blocks.find(block => block.type === 'bao_repeat');
    const append = (type) => {
      const block = api.workspace.newBlock(type); block.initSvg(); block.render();
      tail.nextConnection.connect(block.previousConnection); tail = block; return block;
    };
    const waitHidden = append('bao_wait_image_state'); waitHidden.setFieldValue('dialogs/reward.webp', 'ASSET'); waitHidden.setFieldValue('hidden', 'STATE');
    const move = append('bao_move_to_image'); move.setFieldValue('buttons/start.png', 'ASSET');
    append('bao_text_input').setFieldValue('自动输入', 'TEXT');
    append('bao_scroll');
    append('bao_navigate').setFieldValue('https://example.com/game', 'URL');
    append('bao_reload');
    append('bao_log').setFieldValue('导航完成', 'MESSAGE');
    const branch = append('bao_if_image'); branch.setFieldValue('dialogs/reward.webp', 'ASSET'); branch.setFieldValue('missing', 'MODE');
    const branchKey = api.workspace.newBlock('bao_key_press'); branchKey.initSvg(); branchKey.render();
    branch.getInput('THEN').connection.connect(branchKey.previousConnection);
    const until = append('bao_repeat_until_image'); until.setFieldValue('pages/home.png', 'ASSET');
    const untilDelay = api.workspace.newBlock('bao_delay'); untilDelay.initSvg(); untilDelay.render();
    until.getInput('DO').connection.connect(untilDelay.previousConnection);
    blocks = api.workspace.getAllBlocks(false);
    const before = api.exportProject();
    api.workspace.clear();
    api.importProject(before);
    const after = api.exportProject();
    api.setAssetContents({
      'pages/home.png': [1, 2, 3],
      'buttons/start.png': [4, 5, 6],
      'dialogs/reward.webp': [7, 8, 9],
    });
    const packageBytes = await api.buildPackage();
    const packageEntries = Object.keys(fflate.unzipSync(packageBytes)).sort();
    return {
      version: api.version,
      blockly: Blockly.VERSION,
      assets: after.assets,
      topBlocks: api.workspace.getTopBlocks(false).length,
      workflow: after.workflow,
      beforeWorkflow: before.workflow,
      roundTrip: JSON.stringify(before.workflow) === JSON.stringify(after.workflow),
      registeredBlocks: ['bao_wait_image_state', 'bao_move_to_image', 'bao_text_input', 'bao_scroll', 'bao_navigate', 'bao_reload', 'bao_log', 'bao_if_image', 'bao_repeat_until_image'].every(type => Boolean(Blockly.Blocks[type])),
      packageEntries,
      packageBytes: packageBytes.byteLength,
    };
  })()`);
  if (!result.roundTrip) throw new Error(`workspace JSON round trip changed: ${JSON.stringify({ before: result.beforeWorkflow, after: result.workflow })}`);
  if (result.topBlocks !== 1) throw new Error(`expected one entry block, got ${result.topBlocks}`);
  if (result.workflow.readyWhen.asset !== 'pages/home.png') throw new Error('ready condition was not compiled');
  if (result.workflow.root.steps.length !== 12) throw new Error(`statement chain was not compiled: ${result.workflow.root.steps.length}`);
  if (result.assets.length !== 3) throw new Error('asset filtering failed');
  if (!result.registeredBlocks) throw new Error('one or more expanded blocks were not registered');
  if (!result.packageEntries.includes('manifest.json') || !result.packageEntries.includes('workflow.json') || result.packageEntries.filter(name => name.startsWith('assets/')).length !== 3) throw new Error(`invalid .baoauto entries: ${result.packageEntries.join(',')}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUTPUT_DIR, 'm1-workbench.png'), image.toPNG());
  fs.writeFileSync(path.join(OUTPUT_DIR, 'm1-workbench-result.json'), JSON.stringify(result, null, 2));
  console.log('[automation-m1-workbench] PASS', JSON.stringify({
    blockly: result.blockly,
    assets: result.assets.length,
    steps: result.workflow.root.steps.length,
    roundTrip: result.roundTrip,
    packageBytes: result.packageBytes,
  }));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[automation-m1-workbench] FAIL:', error && error.stack ? error.stack : error);
  app.exit(1);
});
