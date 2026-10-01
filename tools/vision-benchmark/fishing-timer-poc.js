// =============================================================================
// 钓鱼 - 计时器 + 测速判定 + 周期表（走积木/助手一致的识别通道）
// 进入本脚本的一瞬间 = 点击收线 = 鱼从 x=0 起点开始固定速度往返
// =============================================================================

// ---------------- 可调常量（游戏实测后校准） ----------------
const SPEED_SAMPLES = 4;                // 测速采样帧数（连续抓鱼的坐标）
// 速度分界：相邻两次抓鱼的 x 差值。成年快、幼年慢。单位=ratio位移。需实测校准。
const SPEED_DELTA = 0.010;              // 相邻两次采样 x 差值>此值=>成年
const ADULT_TO_HOOK_MS = 750;           // 成年：起点到鱼钩（校准）
const YOUNG_TO_HOOK_MS = 1500;          // 幼年：起点到鱼钩（校准）
const PULL_LEAD_MS = 0;
// -----------------------------------------------------------

// 鱼定位：和助手一致的图片组识别（asset + alternatives 展开全部鱼素材）。
// 注意：normalize 会自动给裸名补 assets/ 前缀；若组素材在包里有目录前缀(如 鱼鳔/)，这里需加前缀。
// 素材包鱼组6个：鱼-二次扣图、鱼-二次扣图-镜像、鱼、鱼-镜像、鱼左、鱼右。
const fishLocator = {
  kind: 'image', asset: '鱼-二次扣图.png',
  alternatives: ['鱼-二次扣图-镜像.png', '鱼.png', '鱼-镜像.png', '鱼左.png', '鱼右.png'],
  threshold: 0.6, mask: 'auto',
};
// 拉杆按钮（点击目标）
const pullLocator = {
  kind: 'image', asset: '拉杆.png', threshold: 0.7, mask: 'auto',
};

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

// ---------------- t0：全局计时起点 = 点击收线瞬间 ----------------
const t0 = await bao.time.now();
await bao.log.info('【钓鱼计时】进入（t0=' + t0 + '；先连续抓鱼坐标测速，再定位拉杆）');

// ② 测速：连续抓鱼的 x 坐标，相邻差值判速。
const samples = [];
let isAdult = null;
let speedElapsedMs = -1;
const speedDeadline = t0 + 1600;
while (samples.length < SPEED_SAMPLES && (await bao.time.now()) < speedDeadline) {
  const nowMs = await bao.time.now();
  const elapsed = nowMs - t0;
  const fish = await find(fishLocator, '测速-鱼');
  if (fish && fish.ratioPoint) {
    samples.push({ x: fish.ratioPoint.x, t: elapsed, y: fish.ratioPoint.y });
    await bao.log.info('测速采样#' + samples.length + '：x=' + fish.ratioPoint.x.toFixed(4)
      + '，y=' + fish.ratioPoint.y.toFixed(4) + '，t=' + elapsed + 'ms');
  }
}
if (samples.length >= 2) {
  // 用相邻两次的平均 x 差值判速（比值位移）
  let sumDelta = 0;
  for (let i = 1; i < samples.length; i++) sumDelta += Math.abs(samples[i].x - samples[i - 1].x);
  const avgDelta = sumDelta / (samples.length - 1);
  isAdult = avgDelta >= SPEED_DELTA;
  speedElapsedMs = samples[samples.length - 1].t;
  const first = samples[0], last = samples[samples.length - 1];
  await bao.log.info('测速判定：X ' + first.x.toFixed(4) + '->' + last.x.toFixed(4)
    + '，avgDelta=' + avgDelta.toFixed(5) + '，阈值=' + SPEED_DELTA
    + ' => ' + (isAdult ? '成年' : '幼年') + '（采样' + samples.length + '帧）');
} else {
  isAdult = false;
  speedElapsedMs = (await bao.time.now()) - t0;
  await bao.log.info('测速采样不足(' + samples.length + '帧)，保守按幼年处理');
}

// ① 定位拉杆按钮（点击目标）
let pull = null;
const pullDeadline = await bao.time.now() + 5000;
while (!pull && (await bao.time.now()) < pullDeadline) {
  pull = await find(pullLocator, '拉杆按钮');
  if (!pull) await bao.time.sleep(20);
}
if (!pull) throw new Error('拉杆按钮识别超时（判定=' + (isAdult ? '成年' : '幼年') + '）');
await bao.log.info('拉杆定位完成：ratio=' + pull.ratioPoint.x.toFixed(4) + ',' + pull.ratioPoint.y.toFixed(4));

// ③ 周期表预测：剩余等待 = 到鱼钩时间 - 已耗时
const toHook = isAdult ? ADULT_TO_HOOK_MS : YOUNG_TO_HOOK_MS;
const nowAfterPull = await bao.time.now();
const remain = Math.max(0, toHook - (nowAfterPull - t0) - PULL_LEAD_MS);
await bao.log.info('周期表：' + (isAdult ? '成年' : '幼年') + ' 到鱼钩=' + toHook + 'ms，已过='
  + (nowAfterPull - t0) + 'ms，剩余=' + remain + 'ms');

// ④ 定时等待 -> 点击拉杆
await bao.time.sleep(remain);
await bao.input.click(pull.point, { button: 'primary', count: 1 });
await bao.log.info('【第一次拉杆】已点击，端到端=' + (await bao.time.now() - t0) + 'ms，' + (isAdult ? '成年' : '幼年') + '');
return null;
