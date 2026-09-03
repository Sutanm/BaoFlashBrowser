import { nativeImage, type NativeImage } from 'electron';

/**
 * 取材时自动剥离纯色背景,把"带背景的矩形截图"转成"透明 sprite"。
 *
 * 为什么需要:钓鱼素材包里的收线/拉杆/赶走/上钩都是连背景一起截的矩形图,
 * 透明像素占比为 0,OpenCV Worker 只能走 TM_CCOEFF_NORMED(无 mask)。
 * 模板里 1/3~1/2 像素是背景,归一化相关性把背景也计算进去,背景一旦变化分数
 * 就跌到 0.9 阈值以下。剥离出 alpha 后,Worker 的 hasUsefulAlpha 自动切换
 * TM_CCORR_NORMED(mask),真实纹理背景下 7/7 素材全部从 <0.9 提升到 1.0。
 *
 * 只在"边框主色足够可信"时剥离,其余情况原样返回,避免误伤渐变背景与
 * 前景延伸到边缘的素材。
 */

const KEYOUT_TOLERANCE = 90; // 三通道曼哈顿距离和
const ALPHA_SKIP = 8; // 低于该 alpha 的像素视为透明,不参与主色统计
const MIN_BORDER_EFFECTIVE_SHARE = 0.3; // 边框有效(非透明)像素占比
const MIN_BG_BORDER_COVERAGE = 0.55; // 主色集合对边框有效像素的覆盖率
const MIN_FG_SHARE = 0.05; // 剥离后前景占整图比例下限
const MAX_FG_SHARE = 0.97; // 上限(防止纯色大图被整个清空)

export type AssetKeyOutResult = {
  readonly image: NativeImage;
  /** 是否执行了剥离。false 表示素材无透明需求或背景不可信,保持原样。 */
  readonly keyed: boolean;
  /** 被剥离像素占整图比例。 */
  readonly removedShare: number;
};

/** 纯逻辑核:BGRA 内存图 -> 剥离纯色背景后的 BGRA。不依赖 electron,便于单测。 */
export function keyOutBgraBackground(
  bgra: Uint8Array,
  width: number,
  height: number,
): { output: Buffer; keyed: boolean; removedShare: number } {
  const unchanged = { output: Buffer.from(bgra), keyed: false, removedShare: 0 };
  if (width < 12 || height < 12) return unchanged;
  if (bgra.byteLength !== width * height * 4) return unchanged;

  // 已经带透明通道的素材直接放行:Worker 会走 alpha mask,不需要二次处理。
  let alphaPixels = 0;
  for (let p = 0, i = 3; p < width * height; p += 1, i += 4) {
    if (bgra[i] < 250) {
      alphaPixels += 1;
      if (alphaPixels >= Math.max(4, Math.floor(width * height * 0.005))) return unchanged;
    }
  }

  // 统计 1px 边框主色(跳过透明像素)。
  let effective = 0;
  const counts = new Map<number, number>();
  const emit = (x: number, y: number): void => {
    const i = (y * width + x) * 4;
    if (bgra[i + 3] < ALPHA_SKIP) return;
    effective += 1;
    const key = (bgra[i + 2] << 16) | (bgra[i + 1] << 8) | bgra[i];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x += 1) { emit(x, 0); emit(x, height - 1); }
  for (let y = 0; y < height; y += 1) { emit(0, y); emit(width - 1, y); }

  const borderPixelCount = 2 * width + 2 * height - 4;
  if (borderPixelCount <= 0 || effective / borderPixelCount < MIN_BORDER_EFFECTIVE_SHARE) return unchanged;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // top-3 主色覆盖边框比例;多色纯背景(如按钮含两块背景色)也能处理。
  let covered = 0;
  const palette: number[] = [];
  for (const [color, count] of ranked) {
    if (palette.length >= 3) break;
    if (palette.some((existing) => isNear(color, existing, KEYOUT_TOLERANCE))) continue;
    palette.push(color);
    covered += count;
  }
  if (palette.length === 0 || covered / effective < MIN_BG_BORDER_COVERAGE) return unchanged;

  const output = Buffer.from(bgra);
  let removed = 0;
  for (let p = 0, i = 0; p < width * height; p += 1, i += 4) {
    if (bgra[i + 3] < ALPHA_SKIP) { removed += 1; continue; }
    const color = (bgra[i + 2] << 16) | (bgra[i + 1] << 8) | bgra[i];
    if (palette.some((target) => isNear(color, target, KEYOUT_TOLERANCE))) {
      output[i + 3] = 0;
      removed += 1;
    }
  }
  const total = width * height;
  const fgShare = (total - removed) / total;
  if (fgShare < MIN_FG_SHARE || fgShare > MAX_FG_SHARE) return unchanged;

  return { output, keyed: true, removedShare: removed / total };
}

function isNear(color: number, target: number, tolerance: number): boolean {
  const dr = Math.abs(((color >> 16) & 255) - ((target >> 16) & 255));
  const dg = Math.abs(((color >> 8) & 255) - ((target >> 8) & 255));
  const db = Math.abs((color & 255) - (target & 255));
  return dr + dg + db <= tolerance;
}

/** Electron 包装:NativeImage 出入,取材保存时使用。 */
export function keyOutAssetBackground(image: NativeImage): AssetKeyOutResult {
  const size = image.getSize();
  const bgra = image.toBitmap();
  const { output, keyed, removedShare } = keyOutBgraBackground(bgra, size.width, size.height);
  if (!keyed) return { image, keyed: false, removedShare: 0 };
  const keyedImage = nativeImage.createFromBitmap(output, { width: size.width, height: size.height });
  if (keyedImage.isEmpty()) return { image, keyed: false, removedShare: 0 };
  return { image: keyedImage, keyed, removedShare };
}
