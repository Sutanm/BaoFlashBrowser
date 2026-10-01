// =============================================================================
// 钓鱼-测速A：图片组(鱼鳔/) + 默认路由
// 进入本脚本瞬间 = 点击收线 = 鱼从 x=0 起点固定速度往返
// 识别用包内 assets/鱼鳔/ 图片组（已验证存在），走默认自动路由，最接近助手稳定识别
// =============================================================================

const SPEED_SAMPLES = 4;
const SPEED_DELTA = 0.010;    // 相邻两次鱼 x 差值>此值=>成年 (ratio位移, 校准)
const ADULT_TO_HOOK_MS = 750; // 成年 起点->鱼钩 (校准)
const YOUNG_TO_HOOK_MS = 1500;// 幼年 起点->鱼钩 (校准)
const PULL_LEAD_MS = 0;

// 图片组：包内 assets/鱼鳔/ 目录下6张 (已确认存在)
const fishLocator = {
  kind: 'image',
  asset: '鱼鳔/鱼-二次扣图.png',
  alternatives: ['鱼鳔/鱼-二次扣图-镜像.png', '鱼鳔/鱼.png', '鱼鳔/鱼-镜像.png', '鱼鳔/鱼左.png', '鱼鳔/鱼右.png'],
  threshold: 0.6,
  mask: 'auto',
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
await bao.log.info('【钓鱼计时A】进入(t0=' + t0 + '，鱼从x=0出发；先连续抓鱼坐标测速)');

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
await bao.log.info('【第一次拉杆A】已点击，端到端=' + (await bao.time.now() - t0) + 'ms，' + (isAdult ? '成年' : '幼年') + '');
return null;
