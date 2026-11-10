/**
 * 昼夜 / 主题遮罩适配（可复用片段，直接拷进 .baoauto 的 scripts/*.js）
 *
 * 适用：画面整体被压暗（夜晚、关灯、滤镜、暗色主题），导致所有硬编码色值失配。
 * 前提：遮罩是**统一线性混合**——`观测 = 白天 × (1 − a) + TINT × a`。
 *      不是逐元素染色，也不是暗角（否则需要空间模型）。
 *
 * 怎么拿到 TINT 和 a（不要凭感觉填）：
 *   1. 在同一场景截两张图：原亮度 / 被遮罩后（开关灯、或白天/夜晚同一机位）。
 *   2. `node artifacts/mask-fit.cjs 原图.png 遮罩后.png`
 *      工具逐通道最小二乘拟合，输出 a、TINT、R²、分区均匀性。
 *   3. R² > 0.99 说明模型成立；分区 a 极差 > 0.06 说明有暗角，需要分区处理。
 *
 * 下面填的是某个 Flash 小游戏实测值（两组独立截图一致：a=0.5000/0.5003，
 * TINT=(24,6,48)，分区极差 ≤0.022）。**换游戏必须重新量**。
 */

// ── 参数（换场景/换游戏时改这里）───────────────────────────────────
const NIGHT_TINT = [24, 6, 48];   // 遮罩色（R,G,B）
const NIGHT_ALPHA = 0.5;          // 遮罩不透明度；实测往往是个整洁值（如 0.5），不是连续渐变
// 夜间容差要跟着压缩：两个色各压 a 之后，彼此距离只剩约 (1−a) 倍。
// 白天 45 的容差，夜里若还用 45，等价于白天的 90——判别力减半，杂色全进来了。
const tolFor = (base, a) => (a ? Math.max(20, Math.round(base * (1 - a))) : base);

// ── 状态与色值换算 ───────────────────────────────────────────────
let dimA = 0;   // 0 = 原亮度；NIGHT_ALPHA = 被遮罩

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** 按遮罩强度压暗一个色值。a=0 原样返回，避免无谓取整误差。 */
const shade = (hex, a = dimA) => (a ? toHex(toRgb(hex).map((v, i) => v * (1 - a) + NIGHT_TINT[i] * a)) : hex);
/** 当前光照下的等效色值列表。 */
const shadeAll = (list, a = dimA) => (a ? list.map((c) => shade(c, a)) : list);

// ── 校准 ─────────────────────────────────────────────────────────

/**
 * 判定当前是否被遮罩。只需要 2 次采样：
 * 拿一块「遮罩前后差异明显」的区域（地面/墙体），分别用原色和换算后的色去数像素，
 * 谁的命中多就是哪种状态。**不要逐档搜索 0~0.9**：搜索的 argmax 会被噪声带偏，
 * 出现 0.15/0.57 这类偏离真值的档位，然后所有颜色跟着算错。
 *
 * @param region  已知色的采样区域（尽量只含场景，不含 UI）
 * @param colors  该区域白天应有的色值
 * @param sample  (region, colors, tolerance) => Promise<number>  ← 你的「数像素」封装
 */
async function calibrateDim(region, colors, sample) {
  const day = await sample(region, colors, tolFor(45, 0));
  const night = await sample(region, shadeAll(colors, NIGHT_ALPHA), tolFor(45, NIGHT_ALPHA));
  // 一边明显胜出才下结论（2 倍），否则保持原状态，等下一轮再试
  if (day >= night * 2) { dimA = 0; return 0; }
  if (night >= day * 2) { dimA = NIGHT_ALPHA; return NIGHT_ALPHA; }
  return dimA;
}

/**
 * 用已知色的「成片程度」判场景是否还在（可选，配合遮罩一起用）。
 * 被传送到别处时，画面里几乎找不到成片的可挖/可用色。
 * @param points  3~5 个分散的采样区域
 */
async function looksLikeScene(points, colors, sample) {
  let pass = 0;
  for (const region of points) {
    const px = await sample(region, colors, tolFor(45, dimA));
    if (px >= 200) pass += 1;
  }
  return pass >= Math.ceil(points.length * 0.6);
}

/**
 * 使用方式：
 *
 *   // 1) 每次运行开始时校准一次
 *   await calibrateDim(WALL_REGION, ['#97c8af'], sample);
 *
 *   // 2) 之后所有「场景色」检测都过 shadeAll + 压缩容差
 *   const px = await sample(groundRegion, shadeAll(ACTIVE_COLORS), tolFor(36, dimA));
 *
 *   // 3) UI 色**不要**换算：弹窗、按钮、文字保持原亮度
 *   const dlg = await sample(dialogRegion, ['#ff9100'], 26);
 *
 * 注意事项（都踩过）：
 *   - UI 层通常不受遮罩影响：给弹窗色做换算，夜里会把明亮的弹窗判成不存在。
 *   - 校准用的区域要「遮罩前后差异大且颜色饱和」：深色地面明暗跨度大，
 *     计数曲线是平的，任何档位都能套上一批像素，定不出 a。
 *   - 校准结果要能被主循环修正：取点连续失败时重跑一次 calibrateDim，
 *     天色变了能自己恢复。
 */
