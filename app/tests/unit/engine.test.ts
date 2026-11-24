import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE,
  browserEngines,
  engineLabels,
  engineSourceLabels,
  hostOf,
  isBrowserEngine,
  otherEngine,
  resolveEngine
} from '../../src/shared/engine'

describe('hostOf', () => {
  it('取小写主机名，忽略协议、端口与路径', () => {
    expect(hostOf('https://WWW.Example.COM:8443/game/play.swf')).toBe('www.example.com')
    expect(hostOf('http://example.com')).toBe('example.com')
  })

  it('非 http(s) 与非法输入返回 undefined', () => {
    expect(hostOf('file:///C:/x.html')).toBeUndefined()
    expect(hostOf('bao://settings/')).toBeUndefined()
    expect(hostOf('not a url')).toBeUndefined()
    expect(hostOf('')).toBeUndefined()
  })
})

describe('resolveEngine', () => {
  it('有站点规则时按规则走并标注来源', () => {
    expect(resolveEngine({ 'example.com': 'ruffle' }, 'example.com')).toEqual({ engine: 'ruffle', source: 'site-rule' })
  })

  it('没有规则时回落到默认值', () => {
    expect(resolveEngine({}, 'example.com')).toEqual({ engine: DEFAULT_ENGINE, source: 'default' })
    expect(resolveEngine({ 'other.com': 'ruffle' }, 'example.com')).toEqual({ engine: DEFAULT_ENGINE, source: 'default' })
  })

  it('规则表里被写坏的取值不算命中（不能把站点判成未知引擎）', () => {
    const rules = { 'example.com': 'flash' } as unknown as Record<string, 'ppapi' | 'ruffle'>
    expect(resolveEngine(rules, 'example.com').source).toBe('default')
  })

  it('尊重自定义 fallback（用户把默认引擎改成 Ruffle 时）', () => {
    expect(resolveEngine({}, 'example.com', 'ruffle')).toEqual({ engine: 'ruffle', source: 'default' })
  })

  it('没有主机（起始页 / 内部页）时用 fallback', () => {
    expect(resolveEngine({ 'example.com': 'ruffle' }, undefined)).toEqual({ engine: DEFAULT_ENGINE, source: 'default' })
  })
})

describe('引擎常量与工具', () => {
  it('默认引擎是原生优先，Ruffle 作为回退', () => {
    expect(DEFAULT_ENGINE).toBe('ppapi')
    expect([...browserEngines]).toEqual(['ppapi', 'ruffle'])
  })

  it('isBrowserEngine 只认两个引擎', () => {
    expect(isBrowserEngine('ppapi')).toBe(true)
    expect(isBrowserEngine('ruffle')).toBe(true)
    expect(isBrowserEngine('flash')).toBe(false)
    expect(isBrowserEngine(undefined)).toBe(false)
  })

  it('otherEngine 是自反的', () => {
    expect(otherEngine('ppapi')).toBe('ruffle')
    expect(otherEngine('ruffle')).toBe('ppapi')
  })

  it('标签齐全（UI 直接取用，缺键会渲染出 undefined）', () => {
    for (const engine of browserEngines) {
      expect(engineLabels[engine]).toBeTruthy()
      expect(engineSourceLabels.default).toBeTruthy()
    }
  })
})
