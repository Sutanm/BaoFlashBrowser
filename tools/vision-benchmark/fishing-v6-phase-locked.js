// =============================================================================
// 钓鱼-相位锁定 v6
//
// 只用少量识图样本判定鱼龄、当前位置与方向，然后根据实测往返周期计算下一次
// 经过鱼钩 X 线的时间。它不再假设“JS 入口时刻”等于录像中的拉杆 UI 首帧。
// =============================================================================

const REF_MS = 200;
const YOUNG_SPEED_MAX = 0.0165;
const ADULT_SPEED_MIN = 0.019;
const MIN_PLAUSIBLE_SPEED = 0.002;
const MAX_PLAUSIBLE_SPEED = 0.05;
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 5;
const MAX_SAMPLE_MS = 1000;

// 2026-09-08 实机锚点记录（同一个游戏 Surface 的归一化坐标）：
// 拉杆中心 X=0.5093，静态鱼钩中心 X=0.4278。面板整体移动时二者差值不变。
const HOOK_X_FROM_PULL_X = -0.0815;

// crossing direction 表示鱼穿过鱼钩 X 线时的运动方向。
// rightToLeftMs：右行过线 -> 右端掉头 -> 左行过线。
// leftToRightMs：左行过线 -> 左端掉头 -> 右行过线。
const MOTION = Object.freeze({
  adult: Object.freeze({
    label: '成年', speedPerMs: 0.00017053,
    rightToLeftMs: 694.685, leftToRightMs: 1241.979, hookTravelMs: 750,
  }),
  young: Object.freeze({
    label: '幼年', speedPerMs: 0.00008527,
    rightToLeftMs: 1379.187, leftToRightMs: 2465.307, hookTravelMs: 1500,
  }),
});

const FIRST_PULL_LEAD_MS = 170;
const SECOND_PULL_LEAD_MS = 170;
const MIN_ARM_MS = 25;

const fishLocator = {
  kind: 'image',
  asset: '鱼鳔/鱼-二次扣图.png',
  alternatives: [
    '鱼鳔/鱼-二次扣图-镜像.png', '鱼鳔/鱼.png', '鱼鳔/鱼-镜像.png',
    '鱼鳔/鱼左.png', '鱼鳔/鱼右.png',
  ],
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

async function waitUntil(deadlineMs) {
  while (true) {
    const remain = deadlineMs - Date.now();
    if (remain <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, remain));
  }
}

function pairMotion(a, b) {
  const elapsedMs = b.capturedAt - a.capturedAt;
  if (elapsedMs <= 0) return null;
  const velocity = (b.x - a.x) / elapsedMs;
  const normalizedSpeed = Math.abs(velocity) * REF_MS;
  if (normalizedSpeed < MIN_PLAUSIBLE_SPEED || normalizedSpeed > MAX_PLAUSIBLE_SPEED) return null;
  return { a, b, velocity, normalizedSpeed };
}

function analyzeSamples(samples) {
  const pairs = [];
  for (let index = 1; index < samples.length; index += 1) {
    const pair = pairMotion(samples[index - 1], samples[index]);
    if (pair) pairs.push(pair);
  }
  if (pairs.length < 2) return null;

  const fastest = pairs.reduce((best, pair) => (
    pair.normalizedSpeed > best.normalizedSpeed ? pair : best
  ));
  const classification = fastest.normalizedSpeed <= YOUNG_SPEED_MAX
    ? 'young'
    : fastest.normalizedSpeed >= ADULT_SPEED_MIN ? 'adult' : null;
  if (!classification) return null;

  // 靠近掉头点的一对样本会把速度均值压低。方向取最后一组仍具有足够位移的样本，
  // 速度大小取最快的可信样本；这样既能识别刚掉头，也不把停顿当成幼年鱼。
  const directional = [...pairs].reverse().find((pair) => (
    pair.normalizedSpeed >= fastest.normalizedSpeed * 0.6
  ));
  if (!directional) return null;
  return {
    classification,
    normalizedSpeed: fastest.normalizedSpeed,
    velocity: Math.sign(directional.velocity) * Math.abs(fastest.velocity),
    anchor: directional.b,
  };
}

function nextCrossingFromPhase(now, hookX, motion, profile) {
  // 样本位移只用于判龄和方向。速度大小使用录像时刻表反推的固定值：
  // 起始鱼 X=0.2999、钩 X=0.4278，分别在 750/1500ms 首次过线。
  // 运行识图的 delta 会因模板抖动在同一种鱼上变化近一倍，不能用于剩余时间换算。
  const speed = profile.speedPerMs;
  const x = motion.anchor.x;
  const sampleAt = motion.anchor.capturedAt;
  let crossingAt;
  let direction;

  if (motion.velocity > 0) {
    const travelFromLineMs = Math.abs(x - hookX) / speed;
    if (x < hookX) {
      crossingAt = sampleAt + travelFromLineMs;
      direction = 'R';
    } else {
      // 已经右行越过鱼钩：放弃本次，等右端掉头后的左行过线。
      crossingAt = sampleAt + profile.rightToLeftMs - travelFromLineMs;
      direction = 'L';
    }
  } else {
    const travelFromLineMs = Math.abs(x - hookX) / speed;
    if (x > hookX) {
      crossingAt = sampleAt + travelFromLineMs;
      direction = 'L';
    } else {
      // 已经左行越过鱼钩：放弃本次，等左端掉头后的右行过线。
      crossingAt = sampleAt + profile.leftToRightMs - travelFromLineMs;
      direction = 'R';
    }
  }

  let skipped = 0;
  while (crossingAt - FIRST_PULL_LEAD_MS < now + MIN_ARM_MS) {
    if (direction === 'R') {
      crossingAt += profile.rightToLeftMs;
      direction = 'L';
    } else {
      crossingAt += profile.leftToRightMs;
      direction = 'R';
    }
    skipped += 1;
  }
  return { crossingAt, direction, skipped };
}

const startedAt = Date.now();
await bao.log.info('【相位锁定v6】开始定位拉杆并采样');

let pull = null;
const pullDeadline = startedAt + 3000;
while (!pull && Date.now() < pullDeadline) {
  pull = await find(pullLocator, '拉杆按钮');
  if (!pull) await bao.time.sleep(10);
}
if (!pull || !pull.ratioPoint) throw new Error('拉杆定位超时');
const pullTarget = coordinateTarget(pull.point);
const hookX = pull.ratioPoint.x + HOOK_X_FROM_PULL_X;
if (hookX <= 0 || hookX >= 1) throw new Error('由拉杆锚点推导出的鱼钩 X 无效：' + hookX.toFixed(4));

async function sampleFish() {
  // 匹配结果对应调用开始时截取的帧，时间戳必须记在 find() 之前。
  const capturedAt = Date.now();
  const fish = await find(fishLocator, '测速-鱼');
  if (!fish || !fish.ratioPoint) return null;
  return { x: fish.ratioPoint.x, capturedAt, confidence: fish.confidence };
}

const samples = [];
let analysis = null;
// 拉杆识图偶尔需要预热；测速预算从锚点定位完成后单独计算，不能被预热吞掉。
const sampleDeadline = Date.now() + MAX_SAMPLE_MS;
while (samples.length < MAX_SAMPLES && Date.now() < sampleDeadline) {
  const sample = await sampleFish();
  if (!sample) continue;
  samples.push(sample);
  if (samples.length >= MIN_SAMPLES) {
    analysis = analyzeSamples(samples);
    if (analysis) break;
  }
}
if (!analysis) {
  const observed = samples.length > 1
    ? samples.slice(1).map((sample, index) => {
      const pair = pairMotion(samples[index], sample);
      return pair ? pair.normalizedSpeed.toFixed(4) : '异常';
    }).join(',')
    : '无';
  throw new Error('鱼龄/方向测速不可靠（样本=' + samples.length + '，相邻速度=' + observed + '）');
}

const profile = analysis.classification === 'adult' ? MOTION.adult : MOTION.young;
const selectedAt = Date.now();
const crossing = nextCrossingFromPhase(selectedAt, hookX, analysis, profile);
const firstDeadline = crossing.crossingAt - FIRST_PULL_LEAD_MS;
await bao.log.info(
  '判定=' + profile.label
  + '，速度=' + analysis.normalizedSpeed.toFixed(4)
  + '（计时速度=' + (profile.speedPerMs * REF_MS).toFixed(4) + '）'
  + '，方向=' + (analysis.velocity > 0 ? '右' : '左')
  + '，鱼X=' + analysis.anchor.x.toFixed(4)
  + '，钩X=' + hookX.toFixed(4)
  + '；下一过线=' + crossing.direction
  + '，跳过=' + crossing.skipped
  + '，倒计时=' + Math.round(firstDeadline - selectedAt) + 'ms',
);

await waitUntil(firstDeadline);
const firstDispatchedAt = Date.now();
await bao.input.click(pullTarget, { button: 'primary', count: 1 });
const firstCompletedAt = Date.now();
await bao.log.info(
  '【第一次拉杆】发起偏差=' + Math.round(firstDispatchedAt - firstDeadline)
  + 'ms，调用耗时=' + (firstCompletedAt - firstDispatchedAt) + 'ms',
);

// 鱼钩从第一次点击被发出后开始运动，继续以调用发起时刻为第二阶段起点。
const secondDeadline = firstDispatchedAt + profile.hookTravelMs - SECOND_PULL_LEAD_MS;
await bao.log.info('鱼钩重合倒计时=' + Math.round(secondDeadline - Date.now()) + 'ms');
await waitUntil(secondDeadline);
const secondDispatchedAt = Date.now();
await bao.input.click(pullTarget, { button: 'primary', count: 1 });
const secondCompletedAt = Date.now();
await bao.log.info(
  '【第二次拉杆】计划间隔=' + profile.hookTravelMs
  + 'ms，发起间隔=' + (secondDispatchedAt - firstDispatchedAt)
  + 'ms，调用耗时=' + (secondCompletedAt - secondDispatchedAt) + 'ms',
);
return null;
