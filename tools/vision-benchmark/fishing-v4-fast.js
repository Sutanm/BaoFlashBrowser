// =============================================================================
// 钓鱼-测速v4：快速判类（拉杆先定位，判速只取2帧，无模糊区扩展）
// 解决"点晚100-300ms"：拉杆静态先定位不占判速窗口；判速2帧尽早判类
// =============================================================================

const SPEED_THRESHOLD = 0.012;   // delta >= 此值 => 成年；否则幼年（幼年~0.008，成年~0.023）
const REF_MS = 200;              // 归一化参考步长
const MAX_SAMPLE_MS = 600;       // 判速窗口上限（成年750ms到鱼钩，须在600ms内判完）
const ADULT_TO_HOOK_MS = 750;
const YOUNG_TO_HOOK_MS = 1500;
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
function coordinateTarget(point) {
  return { locator: { kind: 'coordinate', point: { unit: 'logical', x: point.x, y: point.y } } };
}
function normDelta(dx, dt) { return Math.abs(dx) / Math.max(1, dt) * REF_MS; }

const t0 = await bao.time.now();
await bao.log.info('【钓鱼计时v4】进入(t0=' + t0 + '，先定位拉杆再判速)');

// ① 静态拉杆先定位（不占判速窗口）
let pull = null;
let attempts = 0;
while (!pull && (await bao.time.now()) < t0 + 3000 && attempts < 10) {
  attempts += 1;
  pull = await find(pullLocator, '拉杆按钮');
  if (!pull) await bao.time.sleep(15);
}
if (!pull) throw new Error('拉杆定位超时');
await bao.log.info('拉杆定位完成 ratio=' + pull.ratioPoint.x.toFixed(4) + ',' + pull.ratioPoint.y.toFixed(4)
  + '，耗时=' + ((await bao.time.now()) - t0) + 'ms');

// ② 判速：只抓2帧，尽早判类
async function sampleFish() {
  const nowMs = await bao.time.now();
  const fish = await find(fishLocator, '测速-鱼');
  if (fish && fish.ratioPoint) {
    await bao.log.info('采样 x=' + fish.ratioPoint.x.toFixed(4) + '，t=' + (nowMs - t0) + 'ms');
    return { x: fish.ratioPoint.x, t: nowMs - t0 };
  }
  return null;
}

let s1 = null, s2 = null, sAtt = 0;
const firstCap = t0 + MAX_SAMPLE_MS;
while ((!s1 || !s2) && (await bao.time.now()) < firstCap && sAtt < 6) {
  sAtt += 1;
  const s = await sampleFish();
  if (s) { if (!s1) s1 = s; else s2 = s; }
}

let isAdult;
if (!s1 || !s2) {
  isAdult = false;
  await bao.log.info('测速采样不足，保守按幼年处理');
} else {
  const delta = normDelta(s2.x - s1.x, s2.t - s1.t);
  isAdult = delta >= SPEED_THRESHOLD;
  await bao.log.info('测速判定：delta=' + delta.toFixed(4) + ' >= ' + SPEED_THRESHOLD + ' => ' + (isAdult ? '成年' : '幼年'));
}

// ③ 周期表：从当前时刻算剩余
const toHook = isAdult ? ADULT_TO_HOOK_MS : YOUNG_TO_HOOK_MS;
const nowMs = await bao.time.now();
const remain = Math.max(0, toHook - (nowMs - t0) - PULL_LEAD_MS);
await bao.log.info('周期表：' + (isAdult ? '成年' : '幼年') + ' 到鱼钩=' + toHook + 'ms，已过=' + (nowMs - t0) + 'ms，剩余=' + remain + 'ms');

await bao.time.sleep(remain);
await bao.input.click(coordinateTarget(pull.point), { button: 'primary', count: 1 });
await bao.log.info('【第一次拉杆v4】已点击，端到端=' + (await bao.time.now() - t0) + 'ms，' + (isAdult ? '成年' : '幼年') + '');
return null;
