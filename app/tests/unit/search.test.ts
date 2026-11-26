import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_ENGINE,
  SEARCH_ENGINES,
  isSearchEngine,
  looksLikeAddress,
  searchEngineLabels,
  searchUrlFor
} from '../../src/shared/search'

/**
 * 搜索引擎模型（2026-11-26：地址栏/realbox 的"非 URL 输入"回退）。
 *
 * 这两条判据以前不存在，直接后果是中文输入被 WHATWG URL 当成 IDN 主机名
 * （`https://百度` → `xn--wxtr44c`）并真的去解析 → ERR_NAME_NOT_RESOLVED，
 * 用户看到的是"地址栏用不了"。用例把「什么才算地址」钉死在这里。
 */

describe('looksLikeAddress：只有主机名才像地址', () => {
  it('带点号的域名是地址', () => {
    expect(looksLikeAddress('example.com')).toBe(true)
    expect(looksLikeAddress('www.4399.com/game')).toBe(true)
    expect(looksLikeAddress('a.b.c:8080/x?q=1')).toBe(true)
    // 中文域名是真实存在的（会被 IDN 化成 punycode），不能当关键词。
    expect(looksLikeAddress('百度.com')).toBe(true)
  })

  it('localhost / IP 字面量是地址', () => {
    expect(looksLikeAddress('localhost')).toBe(true)
    expect(looksLikeAddress('localhost:5173')).toBe(true)
    expect(looksLikeAddress('127.0.0.1:8080')).toBe(true)
    expect(looksLikeAddress('[::1]:8080')).toBe(true)
  })

  it('明确写了 http(s) scheme 是地址', () => {
    expect(looksLikeAddress('http://example.com')).toBe(true)
    expect(looksLikeAddress('HTTPS://example.com/a')).toBe(true)
  })

  it('中文/单词/带空格的输入不是地址（本次事故的核心）', () => {
    expect(looksLikeAddress('百度')).toBe(false)
    expect(looksLikeAddress('搜所')).toBe(false)
    expect(looksLikeAddress('4399')).toBe(false)
    expect(looksLikeAddress('hello world')).toBe(false)
    expect(looksLikeAddress('4399 小游戏')).toBe(false)
    expect(looksLikeAddress('')).toBe(false)
    expect(looksLikeAddress('   ')).toBe(false)
  })

  it('其它 scheme 不算地址（由主进程判非法，不走搜索）', () => {
    expect(looksLikeAddress('ftp://example.com')).toBe(false)
    expect(looksLikeAddress('file:///C:/Windows')).toBe(false)
    expect(looksLikeAddress('javascript:alert(1)')).toBe(false)
  })

  it('结尾的点按 FQDN 写法忽略', () => {
    expect(looksLikeAddress('example.com.')).toBe(true)
  })
})

describe('searchUrlFor：关键词 → 搜索地址', () => {
  it('按引擎模板拼接并百分号编码', () => {
    expect(searchUrlFor('baidu', '百度')).toBe('https://www.baidu.com/s?wd=%E7%99%BE%E5%BA%A6')
    expect(searchUrlFor('bing', 'hello world')).toBe('https://www.bing.com/search?q=hello%20world')
    expect(searchUrlFor('google', 'a+b&c')).toBe('https://www.google.com/search?q=a%2Bb%26c')
  })

  it('空白输入返回空串（防手误，不产生半截模板）', () => {
    expect(searchUrlFor('baidu', '   ')).toBe('')
  })

  it('每个内置引擎都有标签与模板', () => {
    for (const engine of SEARCH_ENGINES) {
      expect(searchEngineLabels[engine]).toBeTruthy()
      expect(searchUrlFor(engine, 'x')).toContain('x')
    }
  })
})

describe('引擎取值域', () => {
  it('只认目录里的 id', () => {
    for (const engine of SEARCH_ENGINES) expect(isSearchEngine(engine)).toBe(true)
    expect(isSearchEngine('sogou')).toBe(false)
    expect(isSearchEngine('')).toBe(false)
    expect(isSearchEngine(undefined)).toBe(false)
  })

  it('默认引擎在目录里', () => {
    expect(isSearchEngine(DEFAULT_SEARCH_ENGINE)).toBe(true)
  })

  it('默认是必应（2026-11-26 产品决定：不依赖额外网络环境、结果页没有跳转/推广页）', () => {
    // 钉住产品决策：改默认值必须同时改这条用例与设置页文案，不能靠"顺手换一家"。
    expect(DEFAULT_SEARCH_ENGINE).toBe('bing')
  })
})
