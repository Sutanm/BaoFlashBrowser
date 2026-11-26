import { describe, expect, it } from 'vitest'
import { domainMatches, parsePolicy, sameOriginHop } from '../../src/main/crossdomain-rules'

/**
 * `crossdomain.xml` 的纯规则（2026-11-26 审计 P2）。
 *
 * 这三条判定是**安全边界**：判宽了等于让任意子域替目标站声明策略，判窄了会让真实站点
 * （`www.*` → 裸域的 301）整份策略取不到。所以每条都写死用例。
 */
describe('parsePolicy', () => {
  it('默认 secure=true；显式 false 才降级', () => {
    const policy = parsePolicy(`
      <cross-domain-policy>
        <allow-access-from domain="*.example.com" />
        <allow-access-from domain="cdn.example.net" secure="false" />
      </cross-domain-policy>`)
    expect(policy.rules).toEqual([
      { domain: '*.example.com', secure: true },
      { domain: 'cdn.example.net', secure: false }
    ])
  })

  it('域统一小写，缺少 domain 的规则被忽略', () => {
    const policy = parsePolicy('<allow-access-from domain="*.EXAMPLE.com"/><allow-access-from secure="false"/>')
    expect(policy.rules).toEqual([{ domain: '*.example.com', secure: true }])
  })
})

describe('domainMatches', () => {
  it('通配子域、精确域与全通配', () => {
    expect(domainMatches('*', 'anything.test')).toBe(true)
    expect(domainMatches('*.example.com', 'a.example.com')).toBe(true)
    expect(domainMatches('*.example.com', 'example.com')).toBe(true)
    expect(domainMatches('*.example.com', 'evil-example.com')).toBe(false)
    expect(domainMatches('example.com', 'example.com')).toBe(true)
    expect(domainMatches('example.com', 'a.example.com')).toBe(false)
  })
})

describe('sameOriginHop（重定向是否可采信）', () => {
  it('同源放行', () => {
    expect(sameOriginHop('https://a.example.com/x', 'https://a.example.com/y')).toBe(true)
    expect(sameOriginHop('http://a.example.com/x', 'http://a.example.com/y')).toBe(true)
  })

  it('同站但不同子域：拒绝（子域常是用户内容，不能替目标站声明策略）', () => {
    expect(sameOriginHop('https://evil.example.com/crossdomain.xml', 'https://www.example.com/crossdomain.xml')).toBe(false)
    expect(sameOriginHop('https://a.example.com/x', 'https://b.example.com/x')).toBe(false)
  })

  it('www 增减是真实站点的 301 形态：放行', () => {
    expect(sameOriginHop('https://www.example.com/crossdomain.xml', 'https://example.com/crossdomain.xml')).toBe(true)
    expect(sameOriginHop('https://example.com/crossdomain.xml', 'https://www.example.com/crossdomain.xml')).toBe(true)
  })

  it('协议变化与降级：拒绝', () => {
    expect(sameOriginHop('https://example.com/x', 'http://example.com/x')).toBe(false)
    expect(sameOriginHop('http://example.com/x', 'https://example.com/x')).toBe(false)
  })

  it('端口不同 = 不同源，且拒绝', () => {
    expect(sameOriginHop('https://example.com:443/x', 'https://example.com:8443/x')).toBe(false)
  })

  it('非法输入拒绝', () => {
    expect(sameOriginHop('not a url', 'https://example.com')).toBe(false)
    expect(sameOriginHop('https://example.com', '')).toBe(false)
  })
})
