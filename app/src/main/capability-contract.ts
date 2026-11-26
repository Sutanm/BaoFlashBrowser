/**
 * Capability 合同校验（A1-a）：纯函数，不 import electron。
 *
 * 职责只有一件：**在执行之前**判定一次调用是否成立，并给出稳定失败码。
 * 它不执行动作、不碰 WebContents、不读页面——执行器在 A1-c 接线时落地。
 *
 * 为什么校验要独立成纯层：
 * - 架构 §6.4 要求「所有消费短引用的能力必须经过统一的 `validateTargetRef`」，而这条规则
 *   只有在**一个**地方实现才算数。散落到各动作里，迟早各写一份、各漏一项；
 * - 代际拒绝（binding/navigation）与休眠门禁（ADR-0004）都是「事后无法补救」的判断，
 *   必须在纯层可测、可穷举；
 * - 合同 harness 不依赖 UI、Workflow、CDP Hub 或 Page Map（架构 §18 A1 退出条件）。
 *
 * 校验顺序是合同的一部分，测试按顺序断言：
 * 结构 → 操作者 → 目标存在性与类型 → 标签身份 → 代际 → 观察/frame/surface →
 * 视觉 capture/transform → 动作级门（丢弃理由、Flash 内容、加载中、租约）。
 * 先报结构错误，再报身份错误，最后报策略错误——最先坏的先说。
 */

import {
  ACTOR_KINDS,
  TARGET_PRODUCERS,
  capabilityFailureText,
  isBrowserTarget,
  isShellRef,
  isTargetRef
} from '../shared/capability'
import type {
  ActionContext,
  ActorKind,
  CapabilityActionName,
  CapabilityCallRecord,
  CapabilityCallRecordTarget,
  CapabilityFailureCode,
  CapabilityInvocation,
  CapabilityTarget,
  ShellRef,
  TargetRef
} from '../shared/capability'

/** 校验需要知道的**当前事实**。不传 Electron 对象，只传快照值。 */
export interface CapabilityTabSnapshot {
  tabId: number
  /** WebContents 绑定代际：休眠、崩溃恢复、引擎切换后变化（架构 §6.4）。 */
  bindingId: number
  /** 同一绑定内主文档导航代际。 */
  navigationId: number
  /** 正在加载：ADR-0004 硬门禁，不得销毁。 */
  loading: boolean
  /** 含 Flash 内容（帧树 DOM 探测的结论，不是引擎类型）：ADR-0004 硬门禁，不得销毁。 */
  flashContent: boolean
}

/**
 * 校验器的世界端口。
 *
 * `tab` / `blockedByLease` / `shellElement` 是 M2 就必须给的三项；其余是可选的，
 * **缺端口时按失效处理（fail-closed）**：拿不到证据就不能假装引用仍然有效。
 * 页面侧端口（observation/frame/surface/capture）在 A2/A3 接入，今天没有生产者，
 * 因此页面短引用在 M2 一律被拒绝——这是诚实的，不是能力缺失的妥协。
 */
export interface CapabilityWorld {
  tab(tabId: number): CapabilityTabSnapshot | undefined
  /** 该标签是否被 `preventsDiscard` 的有效租约挡住（架构 §7 规则 8）。 */
  blockedByLease(tabId: number): boolean
  /** 外壳元素是否存在于当前外壳元素表（架构 §6.5 规则 5）。 */
  shellElement(elementId: string): boolean
  observation?(tabId: number, observationId: string): boolean
  frame?(tabId: number, frameId: string): boolean
  surface?(tabId: number, surfaceId: string): boolean
  capture?(surfaceId: string, captureId: string): { transformVersion: number } | undefined
}

export type CapabilityDecision =
  | { ok: true; tabId?: number }
  | { ok: false; code: CapabilityFailureCode; message: string }

function fail(code: CapabilityFailureCode): CapabilityDecision {
  return { ok: false, code, message: capabilityFailureText[code] }
}

const ALL_ACTORS: readonly ActorKind[] = ACTOR_KINDS

/**
 * 动作策略表。
 *
 * `actors` 不是形式主义：`tab.tearoff` 是指针手势的产物（屏幕坐标来自用户拖动），
 * `tab.discard` 是无人值守的内存回收语义（架构 §7 规则 12「Agent 要省内存只能显式请求丢弃」）。
 * 人想表达相同意图时的动作分别是「拖到新窗口」和「关闭 / 保持活跃」——把自动化塞进这两个动作
 * 只会让人看不出发生了什么。其余动作四类操作者共用同一条执行路径（架构 §5 规则 6）。
 */
interface ActionPolicy {
  target: 'none' | 'browser' | 'shell'
  actors: readonly ActorKind[]
}

// 显式标注而不是 `satisfies`：后者会把 `actors` 推断成字面量元组，
// 联合起来 `.includes()` 的参数类型退化成 `never`，改策略时看不出所以然。
const POLICIES: Record<CapabilityActionName, ActionPolicy> = {
  'tab.list': { target: 'none', actors: ALL_ACTORS },
  'tab.activate': { target: 'browser', actors: ALL_ACTORS },
  'tab.close': { target: 'browser', actors: ALL_ACTORS },
  'tab.navigate': { target: 'browser', actors: ALL_ACTORS },
  'tab.reload': { target: 'browser', actors: ALL_ACTORS },
  'tab.move': { target: 'browser', actors: ALL_ACTORS },
  'tab.duplicate': { target: 'browser', actors: ALL_ACTORS },
  'tab.pin': { target: 'browser', actors: ALL_ACTORS },
  'tab.mute': { target: 'browser', actors: ALL_ACTORS },
  'tab.setEngine': { target: 'browser', actors: ALL_ACTORS },
  'tab.keepAwake': { target: 'browser', actors: ALL_ACTORS },
  'tab.tearoff': { target: 'browser', actors: ['human-ui'] },
  'tab.discard': { target: 'browser', actors: ['agent', 'workflow', 'system'] },
  'shell.invoke': { target: 'shell', actors: ALL_ACTORS }
}

function isKnownAction(name: unknown): name is CapabilityActionName {
  return typeof name === 'string' && Object.hasOwn(POLICIES, name)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isActor(value: unknown): value is ActorKind {
  return typeof value === 'string' && (ACTOR_KINDS as readonly string[]).includes(value)
}

function isProducer(value: unknown): boolean {
  return typeof value === 'string' && (TARGET_PRODUCERS as readonly string[]).includes(value)
}

/**
 * 页面短引用的统一校验入口（架构 §6.4）。
 *
 * A3 的 Page/Automation 能力接入后直接调它；今天它的消费者是合同 harness 与将来的指认校验，
 * 所以「看起来没人调用」是阶段态，不是死代码——**它是被要求先固化的那个入口**。
 */
export function validateTargetRef(ref: TargetRef, world: CapabilityWorld): CapabilityDecision {
  if (!ref || typeof ref !== 'object') return fail('invalid-target')
  if (!isNonEmptyString(ref.targetId) || !isNonEmptyString(ref.observationId)) return fail('invalid-target')
  if (!isPositiveInteger(ref.tabId)) return fail('invalid-target')
  if (!isGeneration(ref.bindingId) || !isGeneration(ref.navigationId)) return fail('invalid-target')
  if (!isProducer(ref.producedBy)) return fail('invalid-producer')

  const kind = ref.kind
  if (kind !== 'dom' && kind !== 'ax' && kind !== 'surface' && kind !== 'visual') return fail('invalid-target')
  if ((kind === 'surface' || kind === 'visual') && !isNonEmptyString(ref.surfaceId)) return fail('invalid-target')
  if (kind === 'visual' && !isNonEmptyString(ref.captureId)) return fail('invalid-target')
  if (kind === 'visual' && !isGeneration(ref.transformVersion)) return fail('invalid-target')
  if (ref.frameId !== undefined && !isNonEmptyString(ref.frameId)) return fail('invalid-target')

  const snapshot = world.tab(ref.tabId)
  if (!snapshot) return fail('unknown-tab')
  // 先绑定后导航：旧绑定下的 navigationId 没有可比性，报「绑定失效」才是对的原因。
  if (ref.bindingId !== snapshot.bindingId) return fail('binding-stale')
  if (ref.navigationId !== snapshot.navigationId) return fail('navigation-stale')

  if (!world.observation || !world.observation(ref.tabId, ref.observationId)) return fail('observation-stale')
  if (ref.frameId !== undefined && (!world.frame || !world.frame(ref.tabId, ref.frameId))) return fail('frame-stale')

  if (kind === 'surface' || kind === 'visual') {
    if (!world.surface || !world.surface(ref.tabId, ref.surfaceId)) return fail('surface-stale')
  }
  if (kind === 'visual') {
    const capture = world.capture?.(ref.surfaceId, ref.captureId)
    if (!capture) return fail('capture-stale')
    // 帧在但坐标变换变了：坐标已经不是同一个坐标系，必须重新取帧（架构 §14.4.5 规则 15）。
    if (capture.transformVersion !== ref.transformVersion) return fail('transform-stale')
  }

  return { ok: true, tabId: ref.tabId }
}

/** 外壳元素引用的校验入口（架构 §6.5 规则 4–7）。解析目标只能是 Browser/Shell 命令。 */
export function validateShellRef(ref: ShellRef, world: CapabilityWorld): CapabilityDecision {
  if (!ref || typeof ref !== 'object') return fail('invalid-target')
  if (ref.surfaceId !== 'shell') return fail('target-kind-mismatch')
  if (!isNonEmptyString(ref.elementId)) return fail('invalid-target')
  if (!isNonEmptyString(ref.observationId)) return fail('invalid-target')
  if (!isProducer(ref.producedBy)) return fail('invalid-producer')
  if (!world.shellElement(ref.elementId)) return fail('unknown-shell-element')
  return { ok: true }
}

/**
 * 一次能力调用的校验。
 *
 * 注意「显式 target」是硬规则（架构 §5 规则 1）：没有 `target` 就**不猜**当前活动标签。
 * UI 适配层负责把活动标签翻译成显式 `tabId`；Agent 与工作流没有「当前标签」这个概念。
 */
export function validateCapabilityCall(
  invocation: CapabilityInvocation,
  world: CapabilityWorld
): CapabilityDecision {
  if (!invocation || typeof invocation !== 'object') return fail('invalid-context')

  const context = invocation.context as ActionContext | undefined
  if (!context || typeof context !== 'object') return fail('invalid-context')
  if (!isActor(context.actor)) return fail('invalid-context')
  if (!isNonEmptyString(context.profileId)) return fail('invalid-context')

  const action = invocation.action as { name?: unknown } | undefined
  if (!action || typeof action !== 'object' || !isKnownAction(action.name)) return fail('unknown-action')
  const policy = POLICIES[action.name]

  if (!policy.actors.includes(context.actor)) return fail('actor-not-allowed')

  const target = invocation.target as CapabilityTarget | undefined

  if (policy.target === 'none') {
    if (target !== undefined && target !== null) return fail('target-not-allowed')
    return { ok: true }
  }

  if (target === undefined || target === null) return fail('target-required')

  if (policy.target === 'shell') {
    if (!isShellRef(target)) return fail('target-kind-mismatch')
    return validateShellRef(target, world)
  }

  // policy.target === 'browser'
  if (!isBrowserTarget(target)) return fail('target-kind-mismatch')
  if (!isPositiveInteger(target.tabId)) return fail('invalid-target')
  if (target.expectedBindingId !== undefined && !isGeneration(target.expectedBindingId)) return fail('invalid-target')
  if (target.expectedNavigationId !== undefined && !isGeneration(target.expectedNavigationId)) {
    return fail('invalid-target')
  }

  const snapshot = world.tab(target.tabId)
  if (!snapshot) return fail('unknown-tab')
  if (target.expectedBindingId !== undefined && target.expectedBindingId !== snapshot.bindingId) {
    return fail('binding-stale')
  }
  if (target.expectedNavigationId !== undefined && target.expectedNavigationId !== snapshot.navigationId) {
    return fail('navigation-stale')
  }

  if (action.name === 'tab.discard') {
    // ADR-0004 的优先级：游戏连续性 > 内存回收。所以先报「销毁会丢内容」的硬理由，
    // 再报「有人还在用」。调用方据此知道该等还是该退。
    const reason = (invocation.action as { reason?: unknown }).reason
    if (!isNonEmptyString(reason)) return fail('reason-required')
    if (snapshot.flashContent) return fail('flash-content')
    if (snapshot.loading) return fail('tab-loading')
    if (world.blockedByLease(target.tabId)) return fail('lease-blocks-discard')
  }

  return { ok: true, tabId: target.tabId }
}

/** 记录里只放身份，不放参数与载荷（见 shared/capability.ts 的说明）。 */
function describeTarget(target: CapabilityTarget | undefined): CapabilityCallRecordTarget | undefined {
  if (!target || typeof target !== 'object') return undefined
  if (isShellRef(target)) {
    return {
      kind: 'shell',
      elementId: target.elementId,
      observationId: target.observationId,
      producedBy: target.producedBy
    }
  }
  if (isTargetRef(target)) {
    return {
      kind: target.kind,
      tabId: target.tabId,
      bindingId: target.bindingId,
      navigationId: target.navigationId,
      observationId: target.observationId,
      producedBy: target.producedBy
    }
  }
  // browser target 的 expected* 是调用方的**声明**，不是实际代际，记进来会误导审计：
  // 实际代际由世界快照决定，要查就查那个（记录不是事实源）。
  return { kind: 'browser', tabId: target.tabId }
}

export interface CapabilityCallLogOptions {
  now?: () => number
  /** 环形缓冲上限。默认 500 条：够一次会话的定性分析，不会无限吃内存。 */
  limit?: number
}

/**
 * 结构化调用记录（架构 §18 A1 要求的可被后续审计消费的合同）。
 *
 * 现在只做「记录」不做「审计」：审计模块（导出、脱敏、查询界面）属 A5，这里先把形状钉死，
 * 免得将来发现「想查的东西当初没记」。
 */
export class CapabilityCallLog {
  private sequence = 0
  private readonly entries: CapabilityCallRecord[] = []
  private readonly clock: () => number
  private readonly limit: number

  constructor(options: CapabilityCallLogOptions = {}) {
    this.clock = options.now ?? (() => Date.now())
    this.limit = options.limit ?? 500
  }

  get size(): number {
    return this.entries.length
  }

  append(invocation: CapabilityInvocation, decision: CapabilityDecision, durationMs?: number): CapabilityCallRecord {
    this.sequence += 1
    const context = (invocation?.context ?? undefined) as ActionContext | undefined
    const action = (invocation?.action as { name?: unknown } | undefined)?.name
    const record: CapabilityCallRecord = {
      recordId: `call-${this.sequence}`,
      at: this.clock(),
      ...(isActor(context?.actor) ? { actor: context.actor } : {}),
      ...(isNonEmptyString(context?.profileId) ? { profileId: context.profileId } : {}),
      ...(context?.taskId === undefined ? {} : { taskId: context.taskId }),
      ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      action: typeof action === 'string' ? action : 'invalid',
      ...(decision.ok ? { outcome: 'ok' as const } : { outcome: 'denied' as const, code: decision.code }),
      ...(durationMs === undefined ? {} : { durationMs })
    }
    const target = describeTarget(invocation?.target)
    if (target) record.target = target

    this.entries.push(record)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    return { ...record }
  }

  /** 返回副本，外部改不到内部状态。 */
  list(): CapabilityCallRecord[] {
    return this.entries.map((entry) => ({ ...entry, ...(entry.target ? { target: { ...entry.target } } : {}) }))
  }

  clear(): void {
    this.entries.length = 0
  }
}