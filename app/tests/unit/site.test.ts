import { describe, expect, it } from 'vitest'
import { isSameSite, registrableDomain, siteBoundary } from '../../src/shared/site'

/**
 * 站点边界（审计 P1-3）：`a.com.cn` 与 `b.com.cn` 的末两段是公共后缀 `com.cn`，
 * 它们是**不同站点**。这段逻辑决定弹窗/新窗口的放行，错判等于放开跨站。
 */
describe('registrableDomain', () => {
  it('普通域名取末两段', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com')
    expect(registrableDomain('example.com')).toBe('example.com')
    expect(registrableDomain('game.a.example.com')).toBe('example.com')
  })

  it('多段公共后缀取末三段', () => {
    expect(registrableDomain('game.example.com.cn')).toBe('example.com.cn')
    expect(registrableDomain('a.b.com.cn')).toBe('b.com.cn')
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk')
  })

  it('托管域后缀按公共后缀处理（github.io 上的两个用户是不同站点）', () => {
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io')
    expect(registrableDomain('bob.github.io')).not.toBe(registrableDomain('alice.github.io'))
  })

  it('大小写与结尾点归一', () => {
    expect(registrableDomain('Game.Example.COM.')).toBe('example.com')
  })

  it('IP 与单标签主机原样返回，空/带端口输入返回空串', () => {
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1')
    expect(registrableDomain('localhost')).toBe('localhost')
    expect(registrableDomain('example.com:8080')).toBe('')
    expect(registrableDomain('')).toBe('')
  })
})

describe('siteBoundary', () => {
  it('保留 origin（含端口），站点取可注册域', () => {
    expect(siteBoundary('https://game.example.com.cn:8443/play')).toEqual({
      site: 'example.com.cn',
      origin: 'https://game.example.com.cn:8443'
    })
  })

  it('非 http(s)、空值与非法输入都不算站点', () => {
    expect(siteBoundary('file:///C:/x.html')).toBeUndefined()
    expect(siteBoundary('bao://settings/')).toBeUndefined()
    expect(siteBoundary(undefined)).toBeUndefined()
    expect(siteBoundary('not a url')).toBeUndefined()
  })
})

describe('isSameSite', () => {
  const site = (url: string) => siteBoundary(url)

  it('同站不同子域放行（Flash 时代 lobby → game 的交接）', () => {
    expect(isSameSite(site('https://www.example.com/lobby'), site('https://game.example.com/play'))).toBe(true)
  })

  it('不同可注册域拒绝', () => {
    expect(isSameSite(site('https://a.com.cn/'), site('https://b.com.cn/'))).toBe(false)
  })

  it('协议不一致拒绝（不让 https 页面开 http 弹窗降级）', () => {
    expect(isSameSite(site('https://example.com/'), site('http://example.com/'))).toBe(false)
  })

  it('端口不影响同站判定', () => {
    expect(isSameSite(site('https://example.com:443/'), site('https://example.com:8443/'))).toBe(true)
  })

  it('任一侧缺失都返回 false', () => {
    expect(isSameSite(undefined, site('https://example.com/'))).toBe(false)
    expect(isSameSite(site('https://example.com/'), undefined)).toBe(false)
  })
})
