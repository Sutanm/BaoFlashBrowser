import { z } from 'zod';

export const DEFAULT_PROXY = {
  mode: 'system' as const,
  protocol: 'http' as const,
  host: '',
  port: 7890,
  bypass: '',
  pacUrl: '',
};

const httpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};

export const proxySettingsSchema = z.object({
  mode: z.enum(['system', 'direct', 'manual', 'pac']),
  protocol: z.enum(['http', 'socks5']),
  host: z.string().trim().max(253),
  port: z.number().int().min(1).max(65535),
  bypass: z.string().trim().max(4096).refine((s) => !/[\r\n\0]/.test(s)),
  pacUrl: z.string().trim().max(2048),
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'manual' && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])$/.test(value.host)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host'], message: 'Invalid proxy host' });
  }
  if (value.mode === 'pac' && !httpUrl(value.pacUrl)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pacUrl'], message: 'PAC requires an HTTP(S) URL without credentials' });
  }
});

export type ProxySettings = z.infer<typeof proxySettingsSchema>;
export interface ProxyTestResult {
  ok: boolean;
  route: string;
  statusCode?: number;
  error?: string;
}

export const proxyTestSchema = z.object({
  proxy: proxySettingsSchema,
  url: z.string().max(2048).refine(httpUrl),
}).strict();

// Electron 11 has no `mode` option. Leave a fresh session untouched for system
// settings; an empty fixed-server rule means direct. Do not use newer APIs.
export function toElectronProxy(proxy: ProxySettings): { proxyRules?: string; proxyBypassRules?: string; pacScript?: string } | null {
  switch (proxy.mode) {
    case 'system': return null;
    case 'direct': return { proxyRules: '' };
    case 'pac': return { pacScript: proxy.pacUrl };
    case 'manual': return {
      proxyRules: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      proxyBypassRules: proxy.bypass,
    };
  }
}
