const path = require('path');
const { app } = require('electron');
const { JavaScriptAutomationSandboxHost, JavaScriptAutomationCapabilityBroker } = require('../../release/tests/automation-js-sandbox-host.cjs');

const METHODS = [
  'input.click', 'input.move', 'input.drag', 'input.keyPress', 'input.typeText', 'input.scroll',
  'vision.find', 'vision.exists', 'ocr.findText', 'ocr.readText', 'ocr.readNumber',
  'page.url', 'page.navigate', 'page.reload', 'time.sleep', 'time.now', 'log.write', 'notify.show',
];

async function main() {
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const ports = Object.fromEntries(METHODS.map((method) => [method, async () => method === 'time.now' ? 12345 : null]));
  const broker = new JavaScriptAutomationCapabilityBroker('smoke-token', new Set(), ports);
  const host = new JavaScriptAutomationSandboxHost();
  const script = `
    let networkAllowed=true;try{await fetch('https://example.com/')}catch{networkAllowed=false}
    const original=bao.input.click;try{bao.input.click=()=>{}}catch{}
    const double=(value)=>value*2;let nativeControl=0;for(const value of [1,2,3,4]){if(value%2===0)continue;nativeControl+=double(value)}
    let deniedCode='';try{await bao.notify.show('denied')}catch(error){deniedCode=error.code}
    return {
      requireType:typeof require,
      processType:typeof process,
      electronType:typeof electron,
      ipcType:typeof ipcRenderer,
      baoFrozen:Object.isFrozen(bao)&&Object.isFrozen(bao.input),
      transportImmutable:bao.input.click===original,
      now:await bao.time.now(),
      networkAllowed,
      nativeControl,
      deniedCode,
    };
  `;
  const handle = host.start(script, broker, {
    timeoutMs: 10_000,
    preloadPath: path.resolve(__dirname, '../../dist/javascript-sandbox-preload.js'),
    log: (level, message) => console.log('[sandbox-console]', level, message),
  });
  const result = await handle.completion;
  if (result.status === 'failed') throw result.error;
  const expected = { requireType: 'undefined', processType: 'undefined', electronType: 'undefined', ipcType: 'undefined', baoFrozen: true, transportImmutable: true, now: 12345, networkAllowed: false, nativeControl: 8, deniedCode: 'PERMISSION_DENIED' };
  if (result.status !== 'completed' || JSON.stringify(result.value) !== JSON.stringify(expected)) throw new Error(`sandbox result mismatch: ${JSON.stringify(result)}`);
  const timeoutBroker = new JavaScriptAutomationCapabilityBroker('timeout-token', new Set(), ports);
  const timed = host.start('while(true){}', timeoutBroker, {
    timeoutMs: 150,
    preloadPath: path.resolve(__dirname, '../../dist/javascript-sandbox-preload.js'),
  });
  const timedResult = await timed.completion;
  if (timedResult.status !== 'cancelled' || !timedResult.reason.includes('timed out')) throw new Error(`sandbox timeout mismatch: ${JSON.stringify(timedResult)}`);
  console.log(`[automation-js-sandbox] PASS ${JSON.stringify(result.value)}`);
  app.quit();
}

main().catch((error) => { console.error('[automation-js-sandbox] FAIL', error); app.exit(1); });
