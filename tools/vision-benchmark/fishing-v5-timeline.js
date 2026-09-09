// =============================================================================
// 钓鱼-定时表 v5：快速判类 -> 选择尚未错过的下一次过线时刻 -> 绝对时间点击
//
// t0 必须与采集时刻表时采用同一个定义：进入本脚本的时刻（前一积木刚点完“收线”）。
// 下方数组由 60 FPS 录像逐帧跟踪后拟合生成；每项都由浮点周期计算绝对时刻后
// 独立取整，不能用取整后的周期反复累加，否则误差会随循环累计。
// =============================================================================

// 实机日志：幼年目前最高 0.0156，成年目前最低 0.0202。分界取两者中点附近，
// 既避免把抖动的幼年鱼误判为成年，也给低速采样的成年鱼留下判定余量。
const SPEED_THRESHOLD = 0.018;
const REF_MS = 200;
// 首个成年过线点来不及赶上时继续测速，判定完成后自动选择下一过线点，
// 比直接报“测速采样不足”更可靠。
const MAX_SAMPLE_MS = 900;
// 2026-09-09 实机边界录像连续校准：累计提前 130ms 后仍略晚，
// 再前移约一帧（约 40ms），累计提前量取 170ms。
// 两阶段分开保留，后续可根据“横向没对齐”或“纵向没重合”独立微调。
const FIRST_PULL_LEAD_MS = 170;
const SECOND_PULL_LEAD_MS = 170;
const MIN_ARM_MS = 15;         // 只为本地定时与点击发起留余量；临近截止点时不在点击前跨 IPC 写日志。

// 成年：完整周期 1936.664ms，双向相位差 694.685ms；以运行中已验证的 750ms
// 作为首个右行相位。幼年：完整周期 3844.494ms，双向相位差 1379.187ms；
// 以运行中已验证的 1500ms 作为首个右行相位。
const ADULT_CROSSINGS_MS = [750, 1445, 2687, 3381, 4623, 5318, 6560, 7255, 8497, 9191, 10433, 11128, 12370, 13065, 14307, 15001, 16243, 16938, 18180, 18875, 20117, 20811, 22053, 22748, 23990, 24685, 25927, 26621, 27863, 28558, 29800];
const YOUNG_CROSSINGS_MS = [1500, 2879, 5344, 6724, 9189, 10568, 13033, 14413, 16878, 18257, 20722, 22102, 24567, 25946, 28411, 29791];

// 第一次拉杆后鱼静止，鱼钩从起点出发。当前按“速度相同、到目标距离相同”设置。
const ADULT_HOOK_TO_FISH_MS = 750;
const YOUNG_HOOK_TO_FISH_MS = 1500;

const fishLocator = {
  kind: 'image',
  asset: '鱼鳔/鱼-二次扣图.png',
  alternatives: ['鱼鳔/鱼-二次扣图-镜像.png', '鱼鳔/鱼.png', '鱼鳔/鱼-镜像.png', '鱼鳔/鱼左.png', '鱼鳔/鱼右.png'],
  threshold: 0.6,
  mask: 'auto',
};
const pullLocator = { kind: 'image', asset: '拉杆.png', threshold: 0.7, mask: 'auto' };

function coordinateTarget(point) {
  return { locator: { kind: 'coordinate', point: { unit: 'logical', x: point.x, y: point.y } } };
}
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
function normalizedSpeed(a, b) {
  return Math.abs(b.x - a.x) / Math.max(1, b.t - a.t) * REF_MS;
}
async function waitUntil(deadlineMs) {
  // 使用沙箱本地时钟和计时器。bao.time.now/sleep 每次都要跨 IPC，短间隔循环
  // 反而会把几十毫秒的往返耗时叠加到最终点击上。
  while (true) {
    const remain = deadlineMs - Date.now();
    if (remain <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, remain));
  }
}

const t0 = Date.now();
await bao.log.info('【定时表v5】t0=' + t0 + '，开始定位拉杆并测速');

// 拉杆先定位。即使识图耗时导致首个过线点已经错过，后面也会选择下一项而非立即误点。
let pull = null;
const pullDeadline = t0 + 3000;
while (!pull && Date.now() < pullDeadline) {
  pull = await find(pullLocator, '拉杆按钮');
  if (!pull) await bao.time.sleep(10);
}
if (!pull) throw new Error('拉杆定位超时');
const pullTarget = coordinateTarget(pull.point);

async function sampleFish() {
  // 鱼坐标属于调用开始后立即截取的画面，不能标记成模板匹配完成时间；
  // 否则一次识图耗时的波动会被误算成鱼速变化。
  const capturedAt = Date.now();
  const fish = await find(fishLocator, '测速-鱼');
  if (!fish || !fish.ratioPoint) return null;
  return { x: fish.ratioPoint.x, t: capturedAt - t0 };
}

let first = null;
let second = null;
const sampleDeadline = t0 + MAX_SAMPLE_MS;
while ((!first || !second) && Date.now() < sampleDeadline) {
  const sample = await sampleFish();
  if (sample) {
    if (!first) first = sample;
    else if (sample.t > first.t) second = sample;
  }
}
if (!first || !second) throw new Error('测速采样不足；本版不再猜测鱼龄并误点');

const delta = normalizedSpeed(first, second);
const isAdult = delta >= SPEED_THRESHOLD;
const kind = isAdult ? '成年' : '幼年';
const crossings = isAdult ? ADULT_CROSSINGS_MS : YOUNG_CROSSINGS_MS;
const classifiedAt = Date.now();
const elapsed = classifiedAt - t0;
const nextCrossing = crossings.find((time) => time >= elapsed + MIN_ARM_MS + FIRST_PULL_LEAD_MS);
if (nextCrossing === undefined) throw new Error(kind + '鱼30秒时刻表已用尽（已过' + elapsed + 'ms）');

const firstDeadline = t0 + nextCrossing - FIRST_PULL_LEAD_MS;
const decisionMessage = '判定=' + kind + '，delta=' + delta.toFixed(4)
  + '；选择过线点=' + nextCrossing + 'ms，倒计时=' + (firstDeadline - classifiedAt) + 'ms';
const loggedDecisionBeforeClick = firstDeadline - Date.now() > 60;
if (loggedDecisionBeforeClick) await bao.log.info(decisionMessage);
await waitUntil(firstDeadline);
const firstDispatchedAt = Date.now();
await bao.input.click(pullTarget, { button: 'primary', count: 1 });
const firstCompletedAt = Date.now();
if (!loggedDecisionBeforeClick) await bao.log.info(decisionMessage + '（临近截止点，日志延后）');
await bao.log.info('【第一次拉杆】过线目标=' + nextCrossing + 'ms，发起=' + (firstDispatchedAt - t0)
  + 'ms，调用耗时=' + (firstCompletedAt - firstDispatchedAt) + 'ms');

// 鱼钩从第一次点击被发出后就开始运动；不能使用 click() Promise 的完成时刻，
// 否则输入调用本身的约 30~50ms 会被错误地追加到第二阶段等待中。
const hookTravelMs = isAdult ? ADULT_HOOK_TO_FISH_MS : YOUNG_HOOK_TO_FISH_MS;
const secondDeadline = firstDispatchedAt + hookTravelMs - SECOND_PULL_LEAD_MS;
await bao.log.info('鱼钩重合倒计时=' + (secondDeadline - Date.now()) + 'ms');
await waitUntil(secondDeadline);
const secondDispatchedAt = Date.now();
await bao.input.click(pullTarget, { button: 'primary', count: 1 });
const secondCompletedAt = Date.now();
await bao.log.info('【第二次拉杆】计划间隔=' + hookTravelMs + 'ms，发起间隔='
  + (secondDispatchedAt - firstDispatchedAt) + 'ms，调用耗时=' + (secondCompletedAt - secondDispatchedAt) + 'ms');
return null;
