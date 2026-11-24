import { describe, expect, it } from 'vitest'
import { THEME_CLOCK_DAY, localClockTime, themeClockSky } from '../../src/renderer/theme-clock'

const at = (hours: number, minutes = 0, seconds = 0, ms = 0) =>
  new Date(2026, 0, 1, hours, minutes, seconds, ms)

describe('localClockTime', () => {
  it('把本地时间换成「当天毫秒数」', () => {
    expect(localClockTime(at(0))).toBe(0)
    expect(localClockTime(at(12))).toBe(12 * 60 * 60 * 1000)
    expect(localClockTime(at(12, 34, 56, 789))).toBe(((12 * 60 + 34) * 60 + 56) * 1000 + 789)
    expect(localClockTime(at(23, 59, 59, 999))).toBe(THEME_CLOCK_DAY - 1)
  })

  it('24 小时正好是一圈', () => {
    expect(THEME_CLOCK_DAY).toBe(24 * 60 * 60 * 1000)
  })
})

describe('themeClockSky', () => {
  it('正午是白天：night = 0', () => {
    const sky = themeClockSky(12 * 60 * 60 * 1000)
    expect(sky.night).toBe(0)
    expect(sky.twilight).toBe(0)
  })

  it('午夜是黑夜：night = 1（夹取到上界）', () => {
    expect(themeClockSky(0).night).toBe(1)
  })

  it('06:00 / 18:00 过地平线：night 恰好一半、twilight 最强', () => {
    for (const hour of [6, 18]) {
      const sky = themeClockSky(hour * 60 * 60 * 1000)
      expect(sky.night).toBeCloseTo(0.5, 5)
      expect(sky.twilight).toBeCloseTo(1, 5)
    }
  })

  it('取值始终落在 [0, 1]（颜色计算依赖它，越界会算出非法色）', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const sky = themeClockSky(hour * 60 * 60 * 1000)
      expect(sky.night).toBeGreaterThanOrEqual(0)
      expect(sky.night).toBeLessThanOrEqual(1)
      expect(sky.twilight).toBeGreaterThanOrEqual(0)
      expect(sky.twilight).toBeLessThanOrEqual(1)
    }
  })

  it('按时间点取到预期的昼夜值（06:00 / 18:00 是分界，正午最亮、午夜最暗）', () => {
    const nightAt = (hour: number) => themeClockSky(hour * 60 * 60 * 1000).night
    expect(nightAt(0)).toBe(1)
    expect(nightAt(5)).toBe(1)
    expect(nightAt(6)).toBeCloseTo(0.5, 5)
    expect(nightAt(8)).toBe(0)
    expect(nightAt(12)).toBe(0)
    expect(nightAt(18)).toBeCloseTo(0.5, 5)
    expect(nightAt(20)).toBe(1)
    expect(nightAt(23)).toBe(1)
  })
})
