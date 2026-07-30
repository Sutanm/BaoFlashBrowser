let counter = 0;

export function generateId(): string {
  counter++;
  return `tab-${Date.now()}-${counter}`;
}

const urlPattern = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i;

export function isUrl(text: string): boolean {
  return urlPattern.test(text);
}

const SEARCH_ENGINES: Record<string, string> = {
  bing: 'https://cn.bing.com/search?q=',
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
