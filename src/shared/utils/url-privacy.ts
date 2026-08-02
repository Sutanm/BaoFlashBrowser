const SENSITIVE_PARAMETER = /^(?:pass(?:word|wd)?|pwd|token|access_token|auth(?:orization)?|cookie|session|sessionid|sid|ticket|secret|credential|user(?:id|name)?|account|flag|pi)$/i;
const SENSITIVE_FRAGMENT = /(?:pass(?:word|wd)?|pwd|token|auth|cookie|session|ticket|secret|credential|userid|username|account)/i;

export function redactUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

export function sanitizeUrlForPersistence(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    if (SENSITIVE_FRAGMENT.test(url.hash)) url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

export function credentialOrigin(value: string, fallbackHost = ''): string {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? '' : url.origin;
  } catch {
    return fallbackHost ? `https://${fallbackHost}` : '';
  }
}
