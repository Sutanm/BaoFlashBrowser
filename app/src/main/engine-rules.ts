import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isBrowserEngine, resolveEngine } from '../shared/engine'
import type { BrowserEngine, EngineRules, EngineSource } from '../shared/engine'

/**
 * 站点引擎规则持久化（架构 §4 数据：M2 之前先落单个 JSON 文件）。
 *
 * 主进程持业务权威；写入走「临时文件 + rename」保证不会留下半截文件。
 * M2 引入业务库时整体迁到 SQLite，接口保持 `resolve/remember` 不变。
 */
const FILE_NAME = 'engine-rules.json'

function rulesPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

let cache: EngineRules | undefined

function load(): EngineRules {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(readFileSync(rulesPath(), 'utf8'))
    const rules: Record<string, BrowserEngine> = {}
    if (parsed && typeof parsed === 'object') {
      for (const [host, engine] of Object.entries(parsed as Record<string, unknown>)) {
        if (isBrowserEngine(engine)) rules[host] = engine
      }
    }
    cache = rules
  } catch {
    // 文件不存在或损坏都退化为「无规则」：默认引擎仍然可用。
    cache = {}
  }
  return cache
}

function persist(rules: EngineRules): void {
  const path = rulesPath()
  const temporary = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, JSON.stringify(rules, null, 2), 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    console.error('无法保存站点引擎规则。', error)
  }
}

export function rules(): EngineRules {
  return load()
}

export function resolve(host: string | undefined): { engine: BrowserEngine; source: EngineSource } {
  return resolveEngine(load(), host)
}

export function remember(host: string, engine: BrowserEngine): void {
  const next = { ...load(), [host]: engine }
  cache = next
  persist(next)
}

/**
 * 取消某个站点的引擎规则（架构 §3 引擎「记住」要可撤销）。
 *
 * 没有这条时用户只能手改 `engine-rules.json`：UI 上「记住此站点」点完即消失，
 * 属于只有正向、没有回退路径的状态。
 */
export function forget(host: string): void {
  const current = load()
  if (!(host in current)) return
  const next = { ...current }
  delete next[host]
  cache = next
  persist(next)
}
