export function normalizeDomainRule(value: string): string | null {
  const raw = value.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
  if (!raw) return null;
  try {
    const host = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.replace(/\.$/, '');
    if (!host || host.length > 253 || host.includes('..')) return null;
    return host;
  } catch {
    return null;
  }
}

export function domainMatchesRule(urlOrHost: string, rule: string): boolean {
  const host = normalizeDomainRule(urlOrHost);
  const normalizedRule = normalizeDomainRule(rule);
  if (!host || !normalizedRule) return false;
  return host === normalizedRule || host.endsWith(`.${normalizedRule}`);
}
