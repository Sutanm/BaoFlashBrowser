// =============================================================================
// 钓鱼-测速v3：够快判类 + 双阈值抗误判
// 进入瞬间=点击收线=鱼从x=0起点固定速度往返
// 优化：① 前2帧判速(不拖时间) ② 双阈值分段，模糊区扩展采样 ③ 判类后立即算周期表
// =============================================================================

const ADULT_DELTA_MIN = 0.012;   // >= 此值 => 成年
const YOUNG_DELTA_MAX = 0.008;   // <= 此值 => 幼年
const EXTRA_SAMPLES = 2;         // 模糊区再多采2帧
const ADULT_TO_HOOK_MS = 750;    // 成年 起点->鱼钩 (校准)
const YOUNG_TO_HOOK_MS = 1500;   // 幼年 起点->鱼钩 (校准)
const PULL_LEAD_MS = 0;

const fishLocator = {
  kind: 'image',
  asset: '鱼鳔/鱼-二次扣图.png',
  alternatives: ['鱼鳔/鱼-二次扣图-镜像.png', '鱼鳔/鱼.png', '鱼鳔/鱼-镜像.png', '鱼鳔/鱼左.png', '鱼鳔/鱼右.png'],
  threshold: 0.6, mask: 'auto',
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

// bao.input.click 接收的是 TargetRef（含 locator），不是裸坐标。包装成 coordinate target。
function coordinateTarget(point) {
  return { locator: { kind: 'coordinate', point: { unit: 'logical', x: point.x, y: point.y } } };
}

const t0 = await bao.time.now();
await bao.log.info('【钓鱼计时v3】进入(t0=' + t0 + '，先测速判类)');

async function sampleFish() {
  const nowMs = await bao.time.now();
  const fish = await find(fishLocator, '测速-鱼');
  if (fish && fish.ratioPoint) {
    await bao.log.info('采样 x=' + fish.ratioPoint.x.toFixed(4) + '，t=' + (nowMs - t0) + 'ms');
    return { x: fish.ratioPoint.x, t: nowMs - t0 };
  }
  return null;
}

// 归一化参考步长：用 delta/(时间差) 再乘一个参考系数，让阈值稳定
const REF_MS = 200;
function normDelta(dx, dt) { return Math.abs(dx) / Math.max(1, dt) * REF_MS; }

// 采2帧初判
let s1 = null, s2 = null, attempts = 0;
const firstCap = t0 + 800; // 成年约750ms到鱼钩，判速须在此前完成；超时按幼年保守
while ((!s1 || !s2) && (await bao.time.now()) < firstCap && attempts < 8) {
  attempts += 1;
  const s = await sampleFish();
  if (s) { if (!s1) s1 = s; else s2 = s; }
}

if (!s1 || !s2) {
  await bao.log.info('测速采样不足，保守按幼年处理');
  const toHook = YOUNG_TO_HOOK_MS;
  let pull = null;
  const pullDeadline = await bao.time.now() + 5000;
  while (!pull && (await bao.time.now()) < pullDeadline) { pull = await find(pullLocator, '拉杆按钮'); if (!pull) await bao.time.sleep(20); }
  if (!pull) throw new Error('拉杆识别超时');
  const remain = Math.max(0, toHook - ((await bao.time.now()) - t0) - PULL_LEAD_MS);
  await bao.log.info('周期表(保守幼年) 到鱼钩=' + toHook + 'ms，剩余=' + remain + 'ms');
  await bao.time.sleep(remain);
  await bao.input.click(coordinateTarget(pull.point), { button: 'primary', count: 1 });
  await bao.log.info('【第一次拉杆v3】已点击(保守幼年)，端到端=' + (await bao.time.now() - t0) + 'ms');
  return null;
}

const delta = normDelta(s2.x - s1.x, s2.t - s1.t);
let isAdult;
if (delta >= ADULT_DELTA_MIN) isAdult = true;
else if (delta <= YOUNG_DELTA_MAX) isAdult = false;
else {
  // 模糊区：再多采2帧，用首尾位移
  await bao.log.info('模糊区(delta=' + delta.toFixed(4) + ')，扩展采样' + EXTRA_SAMPLES + '帧');
  let sx = s1.x, st = s1.t, got = 0;
  const cap = t0 + firstCap + 700;
  while (got < EXTRA_SAMPLES && (await bao.time.now()) < cap) {
    const s = await sampleFish();
    if (s) { sx = s.x; st = s.t; got += 1; }
  }
  const extDelta = normDelta(sx - s1.x, st - s1.t);
  isAdult = extDelta >= ADULT_DELTA_MIN;
  await bao.log.info('扩展后 extDelta=' + extDelta.toFixed(4) + ' => ' + (isAdult ? '成年' : '幼年'));
}
await bao.log.info('测速判定：delta=' + delta.toFixed(4) + ' => ' + (isAdult ? '成年' : '幼年'));

// 周期表：从当前时刻算剩余，同时并行/期间定位拉杆
const toHook = isAdult ? ADULT_TO_HOOK_MS : YOUNG_TO_HOOK_MS;
let pull = null;
const pullDeadline = await bao.time.now() + 5000;
while (!pull && (await bao.time.now()) < pullDeadline) {
  pull = await find(pullLocator, '拉杆按钮');
  if (!pull) await bao.time.sleep(20);
}
if (!pull) throw new Error('拉杆识别超时');
const nowMs = await bao.time.now();
const remain = Math.max(0, toHook - (nowMs - t0) - PULL_LEAD_MS);
await bao.log.info('周期表：' + (isAdult ? '成年' : '幼年') + ' 到鱼钩=' + toHook + 'ms，已过=' + (nowMs - t0) + 'ms，剩余=' + remain + 'ms');

await bao.time.sleep(remain);
await bao.input.click(coordinateTarget(pull.point), { button: 'primary', count: 1 });
await bao.log.info('【第一次拉杆v3】已点击，端到端=' + (await bao.time.now() - t0) + 'ms，' + (isAdult ? '成年' : '幼年') + '');
return null;
