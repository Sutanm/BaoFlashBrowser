export const THEME_CLOCK_DAY = 24 * 60 * 60 * 1000

export function localClockTime(now = new Date()): number {
  return ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000
    + now.getMilliseconds()
}

export function themeClockSky(time: number): { night: number; twilight: number } {
  // 06:00 和 18:00 是表盘上日月经过水平线的位置。
  const elevation = -Math.cos(time / THEME_CLOCK_DAY * 2 * Math.PI)
  return {
    night: Math.max(0, Math.min(1, 0.5 - elevation * 2)),
    twilight: Math.max(0, 1 - Math.abs(elevation) * 3)
  }
}
