/**
 * 帧指纹：判断"这一块画面和上次是不是同一幅"。
 *
 * 用途：自动化等待循环每轮都会产生一个新帧（新 frameId），但画面绝大多数时候没变。
 * 用一次廉价的稀疏采样把"相同画面"折叠成一个 32 位数，后续的模板/色块/OCR 结果就能复用。
 *
 * 设计要点：
 * - **只对搜索区域采样**。整帧指纹会被无关动画（背景、计时器、粒子）轻易打穿。
 * - **跳过 alpha 通道**。半透明抗锯齿的抖动不该导致缓存失效。
 * - 默认 stride=4，即每 16 个像素取一个点；720p 全帧约 5.8 万个采样，成本 < 1 ms。
 * - 只用于"相同/不同"的判定，不用于内容寻址——碰撞概率由 ROI 限定 + 缓存过期兜底。
 */

export type FingerprintRegion = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** 每 stride 个像素采一个点。4 是精度与成本的折中；目标很小时可传 1。 */
export const DEFAULT_FINGERPRINT_STRIDE = 4;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`frame fingerprint ${name} must be a positive integer`);
  }
}

/**
 * 计算一张 BGRA 位图在指定区域内的指纹（FNV-1a 32 位）。
 *
 * @param bitmap 行优先 BGRA 像素，长度必须覆盖 width * height * 4
 * @param width  位图宽度（像素）
 * @param height 位图高度（像素）
 * @param region 采样区域；越界直接抛错，不静默截断（静默截断会让两个不同画面撞同一个指纹）
 * @param stride 采样步长，必须 >= 1
 */
export function regionFingerprint(
  bitmap: Uint8Array,
  width: number,
  height: number,
  region: FingerprintRegion = { x: 0, y: 0, width, height },
  stride: number = DEFAULT_FINGERPRINT_STRIDE,
): number {
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');
  assertPositiveInteger(stride, 'stride');
  const expectedBytes = width * height * 4;
  if (bitmap.byteLength < expectedBytes) {
    throw new Error(
      `frame fingerprint bitmap is too small: ${bitmap.byteLength} < ${expectedBytes} bytes`,
    );
  }
  assertPositiveInteger(region.width, 'region.width');
  assertPositiveInteger(region.height, 'region.height');
  if (
    !Number.isSafeInteger(region.x) ||
    !Number.isSafeInteger(region.y) ||
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > width ||
    region.y + region.height > height
  ) {
    throw new Error(
      `frame fingerprint region ${region.x},${region.y} ${region.width}x${region.height} is outside ${width}x${height}`,
    );
  }

  const rowBytes = width * 4;
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  let hash = FNV_OFFSET_BASIS;
  for (let y = region.y; y < bottom; y += stride) {
    const rowStart = y * rowBytes;
    for (let x = region.x; x < right; x += stride) {
      const offset = rowStart + x * 4;
      hash = Math.imul(hash ^ bitmap[offset], FNV_PRIME);
      hash = Math.imul(hash ^ bitmap[offset + 1], FNV_PRIME);
      hash = Math.imul(hash ^ bitmap[offset + 2], FNV_PRIME);
    }
  }
  return hash >>> 0;
}

/** 整帧指纹（等价于区域取满整幅画面）。 */
export function frameFingerprint(
  bitmap: Uint8Array,
  width: number,
  height: number,
  stride: number = DEFAULT_FINGERPRINT_STRIDE,
): number {
  return regionFingerprint(bitmap, width, height, { x: 0, y: 0, width, height }, stride);
}

/**
 * 按画面面积挑一个采样步长，保证至少采到约 `targetSamples` 个点。
 *
 * 为什么需要：固定 stride=4 对 4 像素宽的小区域只采到 1 个点，等于没有指纹；
 * 而 1080p 全帧用 stride=1 又会白白多算 20 倍的采样点。
 * 规则：`stride = clamp(floor(sqrt(pixels / targetSamples)), 1, maxStride)`。
 */
export function adaptiveFingerprintStride(
  width: number,
  height: number,
  targetSamples = 4096,
  maxStride = DEFAULT_FINGERPRINT_STRIDE,
): number {
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');
  assertPositiveInteger(targetSamples, 'targetSamples');
  assertPositiveInteger(maxStride, 'maxStride');
  const raw = Math.floor(Math.sqrt((width * height) / targetSamples));
  return Math.min(maxStride, Math.max(1, raw || 1));
}
