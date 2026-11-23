import { resolveEngine } from '../shared/engine'
import type { BrowserEngine, EngineRules, EngineSource } from '../shared/engine'
import { engineRules, forgetRule, rememberRule, settings } from './storage'

/**
 * 站点引擎规则（架构 §3 引擎、§4 数据）。
 *
 * M1 是 `userData/engine-rules.json`（临时方案）；M2 的 v1 迁移把它一次性导入
 * `engine_rules` 表，本文件只剩「读快照 + 写库」的薄封装，`resolve/remember/forget`
 * 三个签名保持不变，调用方（`browser-window.ts`）无需改动。
 *
 * 默认引擎也来自设置库（`engine.default`）：`resolve()` 在无站点规则时用它兜底。
 */
export function rules(): EngineRules {
  return engineRules()
}

export function resolve(host: string | undefined): { engine: BrowserEngine; source: EngineSource } {
  return resolveEngine(engineRules(), host, settings().defaultEngine)
}

export function remember(host: string, engine: BrowserEngine): boolean {
  return rememberRule(host, engine)
}

/**
 * 取消某个站点的引擎规则（架构 §3 引擎「记住」要可撤销）。
 *
 * 没有这条时用户只能手改数据文件：UI 上「记住此站点」点完即消失，属于只有正向、
 * 没有回退路径的状态。
 */
export function forget(host: string): boolean {
  return forgetRule(host)
}
