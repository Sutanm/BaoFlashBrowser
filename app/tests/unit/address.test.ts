import { describe, expect, it } from 'vitest'
import { isWebAddress, parseAddress, placeholderTitle, sameDocument } from '../../src/main/address'

/**
 * 地址与文档身份判断（`browser-window.ts` 的纯层，2026-11-26 抽出）。
 *
 * 这些边界以前只能靠真 Electron 的 smoke 撞出来（历史上出过两次：占位标题让标签栏闪地址、
 * `sameDocument` 把不同端口当同一文档）。这里把边界固定成用例，改错会立刻红。
 */

describe('parseAddress：地址栏输入 → 可加载 URL', () => {
  it('没有 scheme 时补 https', () => {
    expect(parseAddress('example.com/a')).toBe('https://example.com/a')
  })

  it('已有 scheme 时原样保留，并规范成 href', () => {
    expect(parseAddress('http://example.com')).toBe('http://example.com/')
  })

  it('host:port 不被当成 scheme（127.0.0.1:8080）', () => {
    expect(parseAddress('127.0.0.1:8080/x')).toBe('https://127.0.0.1:8080/x')
  })

  it('含内部空白一律拒绝', () => {
    expect(parseAddress('example.com/a b')).toBeUndefined()
  })

  it('空串拒绝', () => {
    expect(parseAddress('   ')).toBeUndefined()
  })

  it('非 http(s) scheme 拒绝（javascript:/file:/data:）', () => {
    expect(parseAddress('javascript:alert(1)')).toBeUndefined()
    expect(parseAddress('file:///C:/Windows/System32')).toBeUndefined()
    expect(parseAddress('data:text/html,<h1>x</h1>')).toBeUndefined()
  })

  it('带内联凭据的地址拒绝（凭据会进历史与规则键）', () => {
    expect(parseAddress('https://user:pass@example.com/')).toBeUndefined()
  })
})

describe('isWebAddress', () => {
  it('只接受 http/https', () => {
    expect(isWebAddress('https://example.com/')).toBe(true)
    expect(isWebAddress('ftp://example.com/')).toBe(false)
  })

  it('带凭据不算网页地址', () => {
    expect(isWebAddress('https://user:pass@example.com/')).toBe(false)
  })
})

describe('placeholderTitle：Chromium 的占位标题', () => {
  it('空标题算占位', () => {
    expect(placeholderTitle('', 'https://example.com/')).toBe(true)
  })

  it('bao:// 开头的标题算占位（内部页首帧）', () => {
    expect(placeholderTitle('bao://settings', 'bao://settings/')).toBe(true)
  })

  it('标题等于地址（忽略结尾斜杠）算占位', () => {
    expect(placeholderTitle('example.com/a', 'https://example.com/a')).toBe(false)
    expect(placeholderTitle('https://example.com/a', 'https://example.com/a/')).toBe(true)
  })

  it('真实标题不算占位', () => {
    expect(placeholderTitle('设置', 'bao://settings/')).toBe(false)
  })
})

describe('sameDocument：外壳页识别', () => {
  it('查询串与 hash 不参与比较', () => {
    expect(sameDocument('http://127.0.0.1:5173/?v=1#x', 'http://127.0.0.1:5173/')).toBe(true)
  })

  it('结尾斜杠忽略', () => {
    expect(sameDocument('http://a.com/x/', 'http://a.com/x')).toBe(true)
  })

  it('端口不同即不同文档（2026-11-25 审计修掉的漏洞）', () => {
    expect(sameDocument('https://example.com:8443/', 'https://example.com:443/')).toBe(false)
  })

  it('协议或主机不同即不同文档', () => {
    expect(sameDocument('http://example.com/', 'https://example.com/')).toBe(false)
    expect(sameDocument('https://a.example.com/', 'https://example.com/')).toBe(false)
  })

  it('路径不同即不同文档', () => {
    expect(sameDocument('https://example.com/a', 'https://example.com/b')).toBe(false)
  })

  it('非法 URL 返回 false 而不是抛错', () => {
    expect(sameDocument('not a url', 'https://example.com/')).toBe(false)
  })
})
