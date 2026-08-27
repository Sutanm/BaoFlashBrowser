export interface CapturedCredentialParams {
  password: string;
  username: string;
}

/** Parse login parameters without normalizing credential values or logging the input. */
export function extractCredentialParams(rawInput: string): CapturedCredentialParams | null {
  try {
    const raw = String(rawInput || '');
    const queryStart = raw.indexOf('?');
    const hashStart = raw.indexOf('#', Math.max(0, queryStart));
    const encoded = queryStart >= 0
      ? raw.slice(queryStart + 1, hashStart > queryStart ? hashStart : undefined)
      : raw;
    if (!encoded || encoded.indexOf('=') < 0) return null;

    let password = '';
    let username = '';
    for (const pair of encoded.split('&')) {
      const separator = pair.indexOf('=');
      if (separator < 0) continue;
      const decode = (value: string): string => decodeURIComponent(value.replace(/\+/g, ' '));
      const key = decode(pair.slice(0, separator)).toLowerCase();
      const value = decode(pair.slice(separator + 1));
      if (!password && (key === 'password' || key === 'pwd' || key === 'pass')) password = value;
      if (!username && ['username', 'user', 'login', 'account', 'acct', 'name'].includes(key)) username = value;
    }
    return password.length >= 2 ? { password, username } : null;
  } catch {
    return null;
  }
}

/** Parse either an URL-encoded body/URL or a flat JSON login payload. */
export function extractCredentialPayload(input: unknown): CapturedCredentialParams | null {
  const raw = typeof input === 'string' ? input : (() => {
    try { return input && typeof input === 'object' ? JSON.stringify(input) : ''; } catch { return ''; }
  })();
  const encoded = extractCredentialParams(raw);
  if (encoded) return encoded;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const passwordValue = value.password ?? value.pwd ?? value.pass;
    const usernameValue = value.username ?? value.user ?? value.login ?? value.account ?? value.acct ?? value.name;
    const password = passwordValue == null ? '' : String(passwordValue);
    return password.length >= 2 ? { password, username: usernameValue == null ? '' : String(usernameValue) } : null;
  } catch {
    return null;
  }
}
