import { describe, expect, it } from 'vitest';
import { resourceNameFromUrl } from '../src/main/modules/ruffle-session-protocol';

// Ruffle 的组件 URL 解析是 Ruffle ≥0.8 之后最容易静默回归的一环：publicPath
// 必须带 authority 段（`ruffle-resource://ruffle/`），否则 Chromium 87 在
// `new URL('./x.wasm', publicPath)` 上抛 Invalid URL，表现为白屏 + “Failed to
// load Ruffle WASM”。同一个 URL 在主进程的 WHATWG 解析里落在 hostname，在
// Chromium 的非标准 scheme 解析里留在 path 首段，两种形态都必须归一化。
describe('ruffle-resource URL normalisation', () => {
  it('serves the authority form Ruffle ≥0.8 emits', () => {
    expect(resourceNameFromUrl('ruffle-resource://ruffle/ruffle_web-wasm_mvp_bg.UMWKJ7EM.wasm'))
      .toBe('ruffle_web-wasm_mvp_bg.UMWKJ7EM.wasm');
  });

  it('preserves the case of the hashed wasm file name', () => {
    // Chromium 会把 authority（hostname）小写化；文件名必须原样保留，否则
    // Linux/macOS 上大小写敏感的文件系统会 404。
    expect(resourceNameFromUrl('ruffle-resource://ruffle/ruffle_web_bg.QDRSAAAZ.wasm'))
      .toBe('ruffle_web_bg.QDRSAAAZ.wasm');
  });

  it('also serves the CJK font source', () => {
    expect(resourceNameFromUrl('ruffle-resource://ruffle/SourceHanSansCN-Regular.otf'))
      .toBe('SourceHanSansCN-Regular.otf');
  });

  it('stays compatible with the legacy authority-less forms', () => {
    expect(resourceNameFromUrl('ruffle-resource://core.ruffle.5e30dc5777a75720eae2.js'))
      .toBe('core.ruffle.5e30dc5777a75720eae2.js');
    expect(resourceNameFromUrl('ruffle-resource:///core.ruffle.5e30dc5777a75720eae2.js'))
      .toBe('core.ruffle.5e30dc5777a75720eae2.js');
  });

  it('rejects empty and traversal-shaped URLs', () => {
    expect(resourceNameFromUrl('ruffle-resource://ruffle/')).toBeNull();
    expect(resourceNameFromUrl('ruffle-resource://ruffle/sub/dir.js')).toBeNull();
    expect(resourceNameFromUrl('not a url')).toBeNull();
    // 百分号编码不能把分隔符走私进来：解码后 basename 校验必须拒绝。
    expect(resourceNameFromUrl('ruffle-resource://ruffle/%2e%2e%2fsecret')).toBeNull();
    // 真实 URL 解析会先消掉 `..` 段，结果仍是资源目录内的 basename。
    expect(resourceNameFromUrl('ruffle-resource://ruffle/../secret')).toBe('secret');
  });
});
