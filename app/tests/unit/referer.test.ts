import { describe, expect, it } from 'vitest'
import { trimReferer } from '../../src/shared/referer'

describe('跨源 Referer 裁剪', () => {
  it('同源保留完整 URL（含路径与查询）', () => {
    expect(trimReferer('https://a.example/game/1.html?x=1', 'https://a.example/asset.swf'))
      .toBe('https://a.example/game/1.html?x=1')
  })

  it('跨源只保留 origin', () => {
    expect(trimReferer('https://a.example/game/1.html?x=1', 'https://cdn.example/asset.swf'))
      .toBe('https://a.example/')
  })

  it('端口不同算跨源', () => {
    expect(trimReferer('https://a.example:8443/game/1.html', 'https://a.example/asset.swf'))
      .toBe('https://a.example:8443/')
  })

  it('https → http 降级不发 Referer', () => {
    expect(trimReferer('https://a.example/1.html', 'http://a.example/asset.swf')).toBeUndefined()
  })

  it('http → https 仍按跨源只发 origin', () => {
    expect(trimReferer('http://a.example/1.html', 'https://a.example/asset.swf')).toBe('http://a.example/')
  })

  it('非 http(s) 来源不发', () => {
    expect(trimReferer('file:///app/out/renderer/index.html', 'https://a.example/asset.swf')).toBeUndefined()
    expect(trimReferer('not a url', 'https://a.example/asset.swf')).toBeUndefined()
  })
})
