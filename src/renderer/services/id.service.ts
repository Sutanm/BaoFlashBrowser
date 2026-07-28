let counter = 0;

export function generateId(): string {
  counter++;
  return `tab-${Date.now()}-${counter}`;
}

const urlPattern = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i;

export function isUrl(text: string): boolean {
  return urlPattern.test(text);
}

export function normalizeUrl(input: string): string {
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

  return 'https://cn.bing.com/search?q=' + encodeURIComponent(trimmed);
}
