// =============================================================================
// 钓鱼-测速B：根目录单张(鱼-二次扣图) + 泳道region限定 + 低阈值
// 进入本脚本瞬间 = 点击收线 = 鱼从 x=0 起点固定速度往返
// B版差异：用根目录单张素材 + 限定鱼的泳道(横向带)，避免全屏找鱼抓到背景
// =============================================================================

const SPEED_SAMPLES = 4;
const SPEED_DELTA = 0.010;    // 相邻两次鱼 x 差值>此值=>成年 (ratio位移, 校准)
const ADULT_TO_HOOK_MS = 750; // 成年 起点->鱼钩 (校准)
const YOUNG_TO_HOOK_MS = 1500;// 幼年 起点->鱼钩 (校准)
const PULL_LEAD_MS = 0;

// 根目录单张(已验证存在) + 泳道region横向带
const fishLocator = {
  kind: 'image',
  asset: '鱼-二次扣图.png',
  threshold: 0.4,      // 单张阈值稍低，提高召回
  mask: 'auto',
  // region 限定到鱼的泳道（横向带）。由于玩家静止、鱼在面板内水平带游动，
  // 这里用相对画面的横向带；若比例不对可调整。
  // 这里先不设 region（避免坐错坐标），用 A 版图片组对比。
};
const pullLocator = { kind: 'image', asset: '拉杆.png', threshold: 0.7, mask: 'auto' };

function errorText(error) {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code + ': ' : '';
    if (typeof error.message === 'string') return code + error.message;
  }
  return String(error);
}
async function find(locator, label) {
  try { return await bao.vision.find(locator); }
  catch (error) { throw new Error(label + '识别异常：' + errorText(error)); }
}

const t0 = await bao.time.now();
await bao.log.info('【钓鱼计时B】进入(t0=' + t0 + '，单张鱼素材测速)');

// 测速
const samples = [];
let isAdult = null, speedElapsedMs = -1;
const speedDeadline = t0 + 1600;
while (samples.length < SPEED_SAMPLES && (await bao.time.now()) < speedDeadline) {
  const nowMs = await bao.time.now();
  const elapsed = nowMs - t0;
  const fish = await find(fishLocator, '测速-鱼');
  if (fish && fish.ratioPoint) {
    samples.push({ x: fish.ratioPoint.x, t: elapsed, y: fish.ratioPoint.y });
    await bao.log.info('测速采样#' + samples.length + '：x=' + fish.ratioPoint.x.toFixed(4) + '，y=' + fish.ratioPoint.y.toFixed(4) + '，t=' + elapsed + 'ms');
  }
}
if (samples.length >= 2) {
  let sumDelta = 0;
  for (let i = 1; i < samples.length; i++) sumDelta += Math.abs(samples[i].x - samples[i - 1].x);
  const avgDelta = sumDelta / (samples.length - 1);
  isAdult = avgDelta >= SPEED_DELTA;
  speedElapsedMs = samples[samples.length - 1].t;
  const first = samples[0], last = samples[samples.length - 1];
  await bao.log.info('测速判定：X ' + first.x.toFixed(4) + '->' + last.x.toFixed(4) + '，avgDelta='
    + avgDelta.toFixed(5) + '，阈值=' + SPEED_DELTA + ' => ' + (isAdult ? '成年' : '幼年') + '（样本' + samples.length + '）');
} else {
  isAdult = false;
  speedElapsedMs = (await bao.time.now()) - t0;
  await bao.log.info('测速采样不足(' + samples.length + '帧)，保守按幼年处理');
}

// 定位拉杆
let pull = null;
const pullDeadline = await bao.time.now() + 5000;
while (!pull && (await bao.time.now()) < pullDeadline) {
  pull = await find(pullLocator, '拉杆按钮');
  if (!pull) await bao.time.sleep(20);
}
if (!pull) throw new Error('拉杆识别超时（判定=' + (isAdult ? '成年' : '幼年') + '）');
await bao.log.info('拉杆定位：ratio=' + pull.ratioPoint.x.toFixed(4) + ',' + pull.ratioPoint.y.toFixed(4));

// 周期表
const toHook = isAdult ? ADULT_TO_HOOK_MS : YOUNG_TO_HOOK_MS;
const nowAfterPull = await bao.time.now();
const remain = Math.max(0, toHook - (nowAfterPull - t0) - PULL_LEAD_MS);
await bao.log.info('周期表：' + (isAdult ? '成年' : '幼年') + ' 到鱼钩=' + toHook + 'ms，已过=' + (nowAfterPull - t0) + 'ms，剩余=' + remain + 'ms');

// 定时点击
await bao.time.sleep(remain);
await bao.input.click(pull.point, { button: 'primary', count: 1 });
await bao.log.info('【第一次拉杆B】已点击，端到端=' + (await bao.time.now() - t0) + 'ms，' + (isAdult ? '成年' : '幼年') + '');
return null;
