/**
 * 多窗口 P3：tabId 必须在**全局**唯一，不能只靠进程内计数器。
 *
 * 两个渲染进程的 counter 都从 0 开始，同一毫秒创建标签就会生成相同 id；
 * P3 的 tabId → TabManager 全局索引会把它们映射到同一个实例（串窗）。
 * 因此每个渲染进程带一个随机前缀（Chromium 87 也支持 getRandomValues）。
 * 前缀只影响唯一性，id 字符集仍满足 tab-session 的
 * `/^[A-Za-z0-9_-]{1,128}$/` 校验。
 */
function createScopePrefix(): string {
  try {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  }
}

const SCOPE_PREFIX = createScopePrefix();
let counter = 0;

export function generateId(): string {
  counter++;
  return `tab-${SCOPE_PREFIX}-${Date.now()}-${counter}`;
}

const urlPattern = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i;

export function isUrl(text: string): boolean {
  return urlPattern.test(text);
}

const SEARCH_ENGINES: Record<string, string> = {
  bing: 'https://www.bing.com/search?q=',
  google: 'https://www.google.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
};

export function normalizeUrl(input: string, searchEngine?: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'about:newtab';

  if (/^file:\/\//i.test(trimmed) || /^about:/i.test(trimmed)) {
    return trimmed;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (isUrl(trimmed)) {
    return 'https://' + trimmed;
  }

  const engine = SEARCH_ENGINES[searchEngine || ''] || SEARCH_ENGINES.bing;
  return engine + encodeURIComponent(trimmed);
}
