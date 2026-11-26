import { describe, expect, it } from 'vitest'
import { resolveDevRendererUrl } from '../../src/main/dev-renderer-url'

/**
 * 开发态代理准入（2026-11-26 审计）：内部页会以 `bao://` 的权限加载这个地址，
 * 所以只有「非打包 + 回环」两种条件同时成立才放行。
 */
describe('resolveDevRendererUrl', () => {
  it('开发态 + 回环地址：放行', () => {
    expect(resolveDevRendererUrl('http://127.0.0.1:5173', false)?.port).toBe('5173')
    expect(resolveDevRendererUrl('http://localhost:5173/', false)?.hostname).toBe('localhost')
    expect(resolveDevRendererUrl('http://[::1]:5173', false)?.port).toBe('5173')
  })

  it('打包产物：一律拒绝（环境变量残留不能把内部页变成任意站点代理）', () => {
    expect(resolveDevRendererUrl('http://127.0.0.1:5173', true)).toBeUndefined()
    expect(resolveDevRendererUrl('http://localhost:5173/', true)).toBeUndefined()
  })

  it('非回环 / 非 http(s) / 非法输入：拒绝', () => {
    expect(resolveDevRendererUrl('http://example.com', false)).toBeUndefined()
    expect(resolveDevRendererUrl('http://192.168.1.10:5173', false)).toBeUndefined()
    expect(resolveDevRendererUrl('https://10.0.0.5/', false)).toBeUndefined()
    expect(resolveDevRendererUrl('file:///C:/app/out/renderer/index.html', false)).toBeUndefined()
    expect(resolveDevRendererUrl('not a url', false)).toBeUndefined()
    expect(resolveDevRendererUrl(undefined, false)).toBeUndefined()
    expect(resolveDevRendererUrl('', false)).toBeUndefined()
  })
})
