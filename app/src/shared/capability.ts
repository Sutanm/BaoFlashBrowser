/**
 * 统一浏览器能力接口（Browser Capability）的**合同**。
 *
 * 为什么单独一个文件：现有 `BrowserCommand`（见 `./browser.ts`）是 Vue 外壳的 IPC 合同，
 * 不是能力接口——它按界面需要拼命令、不携带操作者、不携带代际，也无法表达「这是谁指的目标」。
 * 架构 §5 要求新的调用显式携带 actor、target 和代际，§6.4 要求所有消费短引用的能力经过统一
 * 校验入口，§6.5 要求人产出的引用与 Agent 产出的引用是**同一类型、同一 ID 空间**。
 *
 * 这份合同与 `BrowserCommand` 的关系是「逐步接管」，不是并存两套语义：UI 适配层会把当前活动
 * 标签翻译成显式 `tabId` 再调 Capability（架构 §5 规则 2），`BrowserCommand` 最终退成一层薄适配。
 *
 * 边界（重要）：
 * - 本文件只有类型与常量，**不 import electron**，因此渲染层将来可以直接产出 `TargetRef`；
 * - 校验逻辑在 `../main/capability-contract.ts`（纯函数，可单测）；
 * - 这里不定义执行器。合同先立、执行器随后按步骤接入，不为没有消费者的能力建空壳。
 */

import type { BrowserEngine } from './engine'
import type { BrowserFailureCode } from './browser'

/**
 * 操作者。与 `TargetProducer` 值域相同但**语义不同**，故意分开声明：
 * `actor` 是「谁执行动作」，`producedBy` 是「谁产出了这个地址」，二者可以不同
 * （人指了一个目标，Agent 去执行——架构 §6.5 规则 3）。
 */
export type ActorKind = 'human-ui' | 'agent' | 'workflow' | 'system'

export const ACTOR_KINDS: readonly ActorKind[] = ['human-ui', 'agent', 'workflow', 'system']

/** 指代的产出者（架构 §6.5）。人机共用同一地址空间，必须能回答「谁指的」。 */
export type TargetProducer = 'human-ui' | 'agent' | 'workflow' | 'system'

export const TARGET_PRODUCERS: readonly TargetProducer[] = ['human-ui', 'agent', 'workflow', 'system']

/**
 * M2 只有一个 profile（架构 §13：普通用户标签使用默认 shared profile）。
 * 显式常量而不是到处写字面量：多 profile 落地时这里是要改的唯一位置。
 */
export const DEFAULT_PROFILE_ID = 'shared'

/** 调用上下文（架构 §5）。`taskId` / `sessionId` 只有自动化侧的生产者才填。 */
export interface ActionContext {
  actor: ActorKind
  profileId: string
  taskId?: string
  sessionId?: string
}

/**
 * 浏览器/标签级目标（架构 §5）。`expected*` 是调用方**声明它以为的代际**：
 * 实际代际不符就拒绝执行，而不是「反正 tabId 还在，凑合执行」。
 */
export interface BrowserTarget {
  tabId: number
  expectedBindingId?: number
  expectedNavigationId?: number
}

/**
 * 页面短引用（架构 §6.4）。它只在一次观察快照内有效，**不得**持久化。
 * 代际字段不是装饰：`bindingId` 在休眠、崩溃恢复、引擎切换后变化，`navigationId`
 * 在同一次绑定内每次主文档导航变化，两者任一不符即证明「引用指向的已经不是同一个东西」。
 */
export interface TargetRefBase {
  tabId: number
  bindingId: number
  navigationId: number
  frameId?: string
  observationId: string
  targetId: string
  producedBy: TargetProducer
}

export type TargetRef =
  | (TargetRefBase & { kind: 'dom' | 'ax' })
  | (TargetRefBase & { kind: 'surface'; surfaceId: string })
  | (TargetRefBase & { kind: 'visual'; surfaceId: string; captureId: string; transformVersion: number })

/**
 * 外壳元素引用（架构 §6.5 规则 4–7）。
 *
 * 独立类型、独立 ID 空间，**不复用 `TargetRef`，也不重新引入 `kind: 'shell'`**（审计裁决 #2）。
 * 外壳元素树是本项目自有代码，所以它可以是「命名即地址」：稳定 `elementId`，不依赖 Page Map、
 * CDP 或视觉兜底，也不需要 `DurableTargetSpec`。代价是它**只能**解析为 Browser/Shell 命令，
 * 不得解析为 DOM 点击（架构 §14.4.3 规则 9、§20 非目标）。
 */
export interface ShellRef {
  surfaceId: 'shell'
  elementId: string
  route?: string
  producedBy: TargetProducer
  observationId: string
}

/** 任何可以作为 `target` 传进来的东西。 */
export type CapabilityTarget = BrowserTarget | TargetRef | ShellRef

/**
 * M2 的标签与外壳动作。
 *
 * 只登记**现在真的要做**的动作：页面能力（点击、读文本、截图）属 A2/A3，不在这里提前占位。
 * 动作名用 `域.动作` 形式，便于日志与审计按域聚合。
 */
export type CapabilityAction =
  | { name: 'tab.list' }
  | { name: 'tab.activate' }
  | { name: 'tab.close' }
  | { name: 'tab.navigate'; address: string }
  | { name: 'tab.reload' }
  | { name: 'tab.move'; index: number }
  | { name: 'tab.duplicate' }
  | { name: 'tab.pin'; value: boolean }
  | { name: 'tab.mute'; value: boolean }
  | { name: 'tab.setEngine'; engine: BrowserEngine }
  | { name: 'tab.keepAwake'; value: boolean }
  /** 指针手势的产物：坐标来自屏幕拖动，因此只允许人类操作者（见 capability-contract 的策略表）。 */
  | { name: 'tab.tearoff'; screenX: number; screenY: number }
  /** 显式丢弃指定标签（架构 §7 规则 12）：无人值守省内存的唯一入口，必须说明理由。 */
  | { name: 'tab.discard'; reason: string }
  /** 外壳元素动作：目标是 `ShellRef`，由外壳元素表映射成 Browser/Shell 命令，不是 DOM 点击。 */
  | { name: 'shell.invoke' }

export type CapabilityActionName = CapabilityAction['name']

/** 一次能力调用。`target` 按动作策略可缺省（只有 `tab.list` 允许缺省）。 */
export interface CapabilityInvocation {
  context: ActionContext
  action: CapabilityAction
  target?: CapabilityTarget
}

/**
 * 稳定失败码。
 *
 * 规则：渲染层/Agent 按代码取文案与决策，**不解析 message**（架构 §5 规则 5）。
 * 因此每个码都必须在测试里被真的走通一次，不留"理论上会有"的码。
 */
export type CapabilityFailureCode =
  | 'invalid-context'
  | 'invalid-producer'
  | 'invalid-target'
  | 'unknown-action'
  | 'actor-not-allowed'
  | 'target-required'
  | 'target-not-allowed'
  | 'target-kind-mismatch'
  | 'unknown-tab'
  | 'binding-stale'
  | 'navigation-stale'
  | 'observation-stale'
  | 'frame-stale'
  | 'surface-stale'
  | 'capture-stale'
  | 'transform-stale'
  | 'unknown-shell-element'
  | 'reason-required'
  | 'lease-blocks-discard'
  | 'flash-content'
  | 'tab-loading'

export const CAPABILITY_FAILURE_CODES: readonly CapabilityFailureCode[] = [
  'invalid-context',
  'invalid-producer',
  'invalid-target',
  'unknown-action',
  'actor-not-allowed',
  'target-required',
  'target-not-allowed',
  'target-kind-mismatch',
  'unknown-tab',
  'binding-stale',
  'navigation-stale',
  'observation-stale',
  'frame-stale',
  'surface-stale',
  'capture-stale',
  'transform-stale',
  'unknown-shell-element',
  'reason-required',
  'lease-blocks-discard',
  'flash-content',
  'tab-loading'
]

export const capabilityFailureText: Record<CapabilityFailureCode, string> = {
  'invalid-context': '能力调用的操作者或 profile 无效',
  'invalid-producer': '目标引用缺少有效的产出者',
  'invalid-target': '目标引用的结构无效',
  'unknown-action': '未知的浏览器能力动作',
  'actor-not-allowed': '该操作者不能执行此动作',
  'target-required': '该动作必须显式指定目标标签',
  'target-not-allowed': '该动作不接受目标标签',
  'target-kind-mismatch': '目标引用的类型与动作不匹配',
  'unknown-tab': '目标标签已关闭或不存在',
  'binding-stale': '目标标签的页面已重建，短引用失效',
  'navigation-stale': '目标标签已导航到其他文档，短引用失效',
  'observation-stale': '目标引用的观察快照已失效',
  'frame-stale': '目标 frame 已不存在',
  'surface-stale': '目标 surface 已不存在',
  'capture-stale': '视觉目标引用的截图帧已失效',
  'transform-stale': '视觉目标引用的坐标变换已过期',
  'unknown-shell-element': '外壳元素不存在或不可被指认',
  'reason-required': '显式丢弃标签必须说明理由',
  'lease-blocks-discard': '该标签持有阻止休眠的租约',
  'flash-content': '含 Flash 内容的标签不得被销毁',
  'tab-loading': '正在加载的标签不得被销毁'
}

/**
 * 结构化调用记录（架构 §18 A1：审计模块尚未进入 A1 时，先固化可供审计消费的合同）。
 *
 * 只记录**身份与结论**：谁、对什么、什么动作、成不成、为什么不成、多久。
 * 不记录动作参数、页面内容、CDP 参数或响应——与架构 §8 对 CDP Hub「只记指标」的口径一致。
 * 页面派生的载荷另有来源分类（§14.3 `source: 'untrusted-page'`），不从这里走。
 */
export interface CapabilityCallRecordTarget {
  kind: TargetRef['kind'] | 'browser' | 'shell'
  tabId?: number
  bindingId?: number
  navigationId?: number
  observationId?: string
  elementId?: string
  producedBy?: TargetProducer
}

export interface CapabilityCallRecord {
  /** `call-1`、`call-2`……递增整数，测试与日志可对照。 */
  recordId: string
  at: number
  /**
   * 操作者与 profile 是可选的：上下文本身非法时（`invalid-context`），审计只知道
   * 「发生过一次非法调用」。能记多少记多少，不编造一个看起来合法的 actor。
   */
  actor?: ActorKind
  profileId?: string
  taskId?: string
  sessionId?: string
  action: string
  target?: CapabilityCallRecordTarget
  outcome: 'ok' | 'denied'
  code?: CapabilityFailureCode
  durationMs?: number
}

/**
 * 能力失败码 → 界面稳定码。
 *
 * 界面已有自己那套码（`BrowserFailureCode`）与文案，21 个能力码不该灌进 UI：能对上的对上
 * （「标签已关闭」「你的请求本身不合法」），对不上的统一 `capability-denied`，
 * 细节留在调用记录的稳定码里（message 也会带上）。
 */
export function browserCodeFor(code: CapabilityFailureCode): BrowserFailureCode {
  switch (code) {
    case 'unknown-tab':
      return 'unknown-tab'
    case 'invalid-context':
    case 'invalid-producer':
    case 'invalid-target':
    case 'unknown-action':
    case 'actor-not-allowed':
    case 'target-required':
    case 'target-not-allowed':
    case 'target-kind-mismatch':
    case 'reason-required':
      return 'invalid-command'
    default:
      return 'capability-denied'
  }
}

/**
 * 判别辅助：调用方（IPC 边界）拿到的是 `unknown` 形状的数据，需要先分类再校验。
 * 三者都以 `tabId` 为业务锚点，所以判定必须看各自的**独有**字段。
 */
export function isShellRef(value: unknown): value is ShellRef {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ShellRef>
  return candidate.surfaceId === 'shell' && typeof candidate.elementId === 'string'
}

export function isTargetRef(value: unknown): value is TargetRef {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TargetRef>
  return typeof candidate.kind === 'string' && typeof candidate.targetId === 'string'
}

export function isBrowserTarget(value: unknown): value is BrowserTarget {
  if (!value || typeof value !== 'object') return false
  if (isShellRef(value) || isTargetRef(value)) return false
  // 只看「有没有 tabId 这个字段」，不看它的类型：类型错了要报 `invalid-target`，
  // 而不是含混地说「你给的目标类型不对」——后者会让调用方去改根本没错的地方。
  return 'tabId' in value
}
