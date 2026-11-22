/**
 * 引擎模型（架构 §3 引擎、§6 M1「引擎切换」）。
 *
 * 双引擎：原生 PPAPI 与 Ruffle。初始引擎由「默认 + 站点规则」决定；用户手动切换
 * 成功后可以把该站点记为规则。切换与站点规则都要留下可理解的来源，便于 UI 展示与
 * 后续审计。
 */
export type BrowserEngine = 'ppapi' | 'ruffle'

/** 当前引擎是怎么来的：默认值、站点规则，还是用户本次手动切换。 */
export type EngineSource = 'default' | 'site-rule' | 'manual'

export const browserEngines: readonly BrowserEngine[] = ['ppapi', 'ruffle']

export const engineLabels: Record<BrowserEngine, string> = {
  ppapi: '原生 Flash',
  ruffle: 'Ruffle'
}

export const engineSourceLabels: Record<EngineSource, string> = {
  default: '默认',
  'site-rule': '站点规则',
  manual: '手动切换'
}

/** 无站点规则时的默认引擎。原生优先，Ruffle 作为兼容回退。 */
export const DEFAULT_ENGINE: BrowserEngine = 'ppapi'

export function isBrowserEngine(value: unknown): value is BrowserEngine {
  return value === 'ppapi' || value === 'ruffle'
}

export function otherEngine(engine: BrowserEngine): BrowserEngine {
  return engine === 'ppapi' ? 'ruffle' : 'ppapi'
}

/** 站点规则以主机名为键（不含端口与协议），小写归一。 */
export function hostOf(address: string): string | undefined {
  try {
    const url = new URL(address)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.hostname.toLowerCase() || undefined
  } catch {
    return undefined
  }
}

export interface EngineRules {
  readonly [host: string]: BrowserEngine
}

export function resolveEngine(rules: EngineRules, host: string | undefined): { engine: BrowserEngine; source: EngineSource } {
  if (host) {
    const rule = rules[host]
    if (isBrowserEngine(rule)) return { engine: rule, source: 'site-rule' }
  }
  return { engine: DEFAULT_ENGINE, source: 'default' }
}
