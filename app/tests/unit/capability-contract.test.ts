import { describe, expect, it } from 'vitest'
import { CAPABILITY_FAILURE_CODES, DEFAULT_PROFILE_ID, browserCodeFor, capabilityFailureText } from '../../src/shared/capability'
import type {
  ActionContext,
  CapabilityAction,
  CapabilityInvocation,
  CapabilityTarget,
  ShellRef,
  TargetRef
} from '../../src/shared/capability'
import {
  CapabilityCallLog,
  validateCapabilityCall,
  validateShellRef,
  validateTargetRef
} from '../../src/main/capability-contract'
import type { CapabilityTabSnapshot, CapabilityWorld } from '../../src/main/capability-contract'

/**
 * Capability 合同 harness（架构 §18 A1 退出条件里的那一份）。
 *
 * 它**不启动 Electron、不建窗口、不碰 CDP/Page Map/Workflow**：只拿纯函数对着假世界断言
 * 「什么样的调用不算数」。四个必测面在下面按 describe 分开：
 * 操作者、显式 target、代际拒绝、租约（含 ADR-0004 的 Flash/加载硬门禁），外加错误码稳定性
 * 与调用记录合同。行为层（真实销毁、真实重建）在 `tests/smoke/tab-discard.test.cjs` 与
 * 后续 A1-c 的整合用例里。
 */

const CONTEXT: ActionContext = { actor: 'human-ui', profileId: DEFAULT_PROFILE_ID }

/** 本文件里真的走通过的失败码。最后一个 describe 断言它覆盖了整张码表。 */
const seenCodes = new Set<string>()

function expectDenied(
  decision: ReturnType<typeof validateCapabilityCall>,
  code: string
): void {
  expect(decision.ok).toBe(false)
  if (decision.ok) return
  expect(decision.code).toBe(code)
  expect(decision.message).toBe(capabilityFailureText[decision.code])
  if (decision.code === code) seenCodes.add(code)
}

function tab(id: number, extra: Partial<CapabilityTabSnapshot> = {}): CapabilityTabSnapshot {
  return { tabId: id, bindingId: 1, navigationId: 7, loading: false, flashContent: false, ...extra }
}

interface WorldOptions {
  tabs?: CapabilityTabSnapshot[]
  leases?: number[]
  shellElements?: string[]
  /** `undefined` 表示**不提供**这个端口（用于断言 fail-closed）。 */
  observations?: string[]
  frames?: string[]
  surfaces?: string[]
  captures?: Record<string, { transformVersion: number }>
}

function makeWorld(options: WorldOptions = {}): CapabilityWorld {
  const tabs = options.tabs ?? [tab(1)]
  const leases = new Set(options.leases ?? [])
  const shellElements = new Set(options.shellElements ?? ['address-bar'])
  const observations = options.observations === undefined ? undefined : new Set(options.observations)
  const frames = options.frames === undefined ? undefined : new Set(options.frames)
  const surfaces = options.surfaces === undefined ? undefined : new Set(options.surfaces)
  const captures = options.captures ?? {}

  const world: CapabilityWorld = {
    tab: (id) => tabs.find((entry) => entry.tabId === id),
    blockedByLease: (id) => leases.has(id),
    shellElement: (elementId) => shellElements.has(elementId)
  }
  if (observations) world.observation = (_id, observationId) => observations.has(observationId)
  if (frames) world.frame = (_id, frameId) => frames.has(frameId)
  if (surfaces) world.surface = (_id, surfaceId) => surfaces.has(surfaceId)
  world.capture = (surfaceId, captureId) => captures[`${surfaceId}/${captureId}`]
  return world
}

/** 默认世界：一个标签（binding 1 / navigation 7）、一个外壳元素、齐全的页面侧端口。 */
function world(overrides: WorldOptions = {}): CapabilityWorld {
  return makeWorld({
    observations: ['obs-1'],
    frames: ['frame-1'],
    surfaces: ['surface-1'],
    captures: { 'surface-1/capture-1': { transformVersion: 3 } },
    ...overrides
  })
}

function call(
  action: CapabilityAction,
  target?: CapabilityTarget,
  context: ActionContext = CONTEXT
): CapabilityInvocation {
  return { context, action, ...(target === undefined ? {} : { target }) }
}

function targetRef(extra: Partial<TargetRef> = {}): TargetRef {
  return {
    kind: 'dom',
    tabId: 1,
    bindingId: 1,
    navigationId: 7,
    observationId: 'obs-1',
    targetId: 'n-42',
    producedBy: 'human-ui',
    ...extra
  } as TargetRef
}

function shellRef(extra: Partial<ShellRef> = {}): ShellRef {
  return {
    surfaceId: 'shell',
    elementId: 'address-bar',
    producedBy: 'human-ui',
    observationId: 'obs-1',
    ...extra
  }
}

describe('结构与操作者', () => {
  it('未知动作名被拒，且不猜它是不是拼错了', () => {
    const invocation = call({ name: 'tab.explode' } as unknown as CapabilityAction)
    expectDenied(validateCapabilityCall(invocation, world()), 'unknown-action')
  })

  it('操作者不在值域内被拒', () => {
    const invocation = call({ name: 'tab.close' }, { tabId: 1 }, {
      actor: 'robot' as ActionContext['actor'],
      profileId: DEFAULT_PROFILE_ID
    })
    expectDenied(validateCapabilityCall(invocation, world()), 'invalid-context')
  })

  it('profileId 为空被拒：能力调用必须说明它在哪个 profile 下发生', () => {
    const invocation = call({ name: 'tab.close' }, { tabId: 1 }, { actor: 'human-ui', profileId: '  ' })
    expectDenied(validateCapabilityCall(invocation, world()), 'invalid-context')
  })

  it('调用本身不是对象时被拒，不抛异常', () => {
    const decision = validateCapabilityCall(undefined as unknown as CapabilityInvocation, world())
    expectDenied(decision, 'invalid-context')
  })

  it('tab.list 不需要 target', () => {
    expect(validateCapabilityCall(call({ name: 'tab.list' }), world())).toEqual({ ok: true })
  })

  it('tab.list 带了 target 反而被拒：多给的字段说明调用方以为自己在做别的事', () => {
    expectDenied(validateCapabilityCall(call({ name: 'tab.list' }, { tabId: 1 }), world()), 'target-not-allowed')
  })
})

describe('显式 target：不隐式依赖当前活动标签', () => {
  it('标签动作不带 target 一律拒（架构 §5 规则 1）', () => {
    expectDenied(validateCapabilityCall(call({ name: 'tab.close' }), world()), 'target-required')
  })

  it('给页面短引用当标签动作的目标：类型不符', () => {
    expectDenied(validateCapabilityCall(call({ name: 'tab.close' }, targetRef()), world()), 'target-kind-mismatch')
  })

  it('给外壳元素引用当标签动作的目标：类型不符', () => {
    expectDenied(validateCapabilityCall(call({ name: 'tab.close' }, shellRef()), world()), 'target-kind-mismatch')
  })

  it('外壳动作给浏览器 target：类型不符（外壳元素不是标签）', () => {
    expectDenied(validateCapabilityCall(call({ name: 'shell.invoke' }, { tabId: 1 }), world()), 'target-kind-mismatch')
  })

  it('tabId 非法（0 / 小数 / 字符串）被拒', () => {
    for (const tabId of [0, 1.5, '3']) {
      const invocation = call({ name: 'tab.close' }, { tabId } as unknown as CapabilityTarget)
      expectDenied(validateCapabilityCall(invocation, world()), 'invalid-target')
    }
  })

  it('target 指向已关闭的标签', () => {
    expectDenied(validateCapabilityCall(call({ name: 'tab.close' }, { tabId: 99 }), world()), 'unknown-tab')
  })

  it('合法调用返回被解析的 tabId，执行器不必再解析一次', () => {
    expect(validateCapabilityCall(call({ name: 'tab.close' }, { tabId: 1 }), world())).toEqual({ ok: true, tabId: 1 })
  })
})

describe('代际拒绝：binding 与 navigation', () => {
  it('绑定代际不符被拒（休眠/重建/引擎切换之后）', () => {
    const invocation = call({ name: 'tab.close' }, { tabId: 1, expectedBindingId: 2 })
    expectDenied(validateCapabilityCall(invocation, world()), 'binding-stale')
  })

  it('导航代际不符被拒', () => {
    const invocation = call({ name: 'tab.close' }, { tabId: 1, expectedNavigationId: 6 })
    expectDenied(validateCapabilityCall(invocation, world()), 'navigation-stale')
  })

  it('两者都不符时报 binding：旧绑定下的 navigation 没有可比性', () => {
    const invocation = call({ name: 'tab.close' }, { tabId: 1, expectedBindingId: 2, expectedNavigationId: 6 })
    expectDenied(validateCapabilityCall(invocation, world()), 'binding-stale')
  })

  it('代际相符才放行', () => {
    const invocation = call({ name: 'tab.close' }, { tabId: 1, expectedBindingId: 1, expectedNavigationId: 7 })
    expect(validateCapabilityCall(invocation, world())).toEqual({ ok: true, tabId: 1 })
  })

  it('声明的代际本身非法被拒（负数代际是调用方的 bug）', () => {
    const invocation = call({ name: 'tab.close' }, { tabId: 1, expectedBindingId: -1 })
    expectDenied(validateCapabilityCall(invocation, world()), 'invalid-target')
  })
})

describe('动作策略：谁能做什么', () => {
  it('拖出标签只允许人类：它是指针手势的产物', () => {
    const invocation = call({ name: 'tab.tearoff', screenX: 10, screenY: 20 }, { tabId: 1 }, {
      actor: 'agent',
      profileId: DEFAULT_PROFILE_ID
    })
    expectDenied(validateCapabilityCall(invocation, world()), 'actor-not-allowed')
  })

  it('工作流也不能拖出标签', () => {
    const invocation = call({ name: 'tab.tearoff', screenX: 10, screenY: 20 }, { tabId: 1 }, {
      actor: 'workflow',
      profileId: DEFAULT_PROFILE_ID
    })
    expectDenied(validateCapabilityCall(invocation, world()), 'actor-not-allowed')
  })

  it('丢弃标签不允许人类操作者：人想表达的是关闭或保持活跃', () => {
    const invocation = call({ name: 'tab.discard', reason: '省内存' }, { tabId: 1 })
    expectDenied(validateCapabilityCall(invocation, world()), 'actor-not-allowed')
  })

  it('人类可以正常激活标签', () => {
    expect(validateCapabilityCall(call({ name: 'tab.activate' }, { tabId: 1 }), world())).toEqual({
      ok: true,
      tabId: 1
    })
  })
})

describe('ADR-0004 硬门禁：显式丢弃标签', () => {
  const AGENT: ActionContext = { actor: 'agent', profileId: DEFAULT_PROFILE_ID }

  it('必须说明理由（架构 §7 规则 12）', () => {
    expectDenied(validateCapabilityCall(call({ name: 'tab.discard', reason: '   ' }, { tabId: 1 }, AGENT), world()), 'reason-required')
  })

  it('含 Flash 内容的标签不得销毁', () => {
    const worldWithFlash = makeWorld({ tabs: [tab(1, { flashContent: true })] })
    expectDenied(validateCapabilityCall(call({ name: 'tab.discard', reason: '省内存' }, { tabId: 1 }, AGENT), worldWithFlash), 'flash-content')
  })

  it('正在加载的标签不得销毁', () => {
    const loadingWorld = makeWorld({ tabs: [tab(1, { loading: true })] })
    expectDenied(validateCapabilityCall(call({ name: 'tab.discard', reason: '省内存' }, { tabId: 1 }, AGENT), loadingWorld), 'tab-loading')
  })

  it('持有阻止休眠租约的标签不得销毁', () => {
    const leased = makeWorld({ leases: [1] })
    expectDenied(validateCapabilityCall(call({ name: 'tab.discard', reason: '省内存' }, { tabId: 1 }, AGENT), leased), 'lease-blocks-discard')
  })

  it('三条理由同时成立时报 Flash：游戏连续性优先于内存回收', () => {
    const everything = makeWorld({ tabs: [tab(1, { flashContent: true, loading: true })], leases: [1] })
    expectDenied(validateCapabilityCall(call({ name: 'tab.discard', reason: '省内存' }, { tabId: 1 }, AGENT), everything), 'flash-content')
  })

  it('门禁全清时才放行', () => {
    expect(validateCapabilityCall(call({ name: 'tab.discard', reason: '省内存' }, { tabId: 1 }, AGENT), world())).toEqual({
      ok: true,
      tabId: 1
    })
  })
})

describe('页面短引用：validateTargetRef 统一入口', () => {
  it('代际相符的 dom 引用可解析', () => {
    expect(validateTargetRef(targetRef(), world())).toEqual({ ok: true, tabId: 1 })
  })

  it('绑定代际不符：休眠/重建之后旧引用失效', () => {
    expectDenied(validateTargetRef(targetRef({ bindingId: 2 }), world()), 'binding-stale')
  })

  it('导航代际不符：页面已经换文档', () => {
    expectDenied(validateTargetRef(targetRef({ navigationId: 8 }), world()), 'navigation-stale')
  })

  it('标签已不存在', () => {
    expectDenied(validateTargetRef(targetRef({ tabId: 5 }), world()), 'unknown-tab')
  })

  it('没有观察端口时按失效处理（fail-closed，不猜）', () => {
    expectDenied(validateTargetRef(targetRef(), world({ observations: undefined })), 'observation-stale')
  })

  it('观察快照已过期', () => {
    expectDenied(validateTargetRef(targetRef({ observationId: 'obs-old' }), world()), 'observation-stale')
  })

  it('frame 已不存在', () => {
    expectDenied(validateTargetRef(targetRef({ frameId: 'frame-old' }), world()), 'frame-stale')
  })

  it('surface 已不存在', () => {
    const surfaceRef = targetRef({ kind: 'surface', surfaceId: 'surface-old' } as Partial<TargetRef>)
    expectDenied(validateTargetRef(surfaceRef, world()), 'surface-stale')
  })

  it('视觉引用的截图帧已失效', () => {
    const visual = targetRef({
      kind: 'visual',
      surfaceId: 'surface-1',
      captureId: 'capture-old',
      transformVersion: 3
    } as Partial<TargetRef>)
    expectDenied(validateTargetRef(visual, world()), 'capture-stale')
  })

  it('帧还在但坐标变换变了：坐标不是同一个坐标系', () => {
    const visual = targetRef({
      kind: 'visual',
      surfaceId: 'surface-1',
      captureId: 'capture-1',
      transformVersion: 2
    } as Partial<TargetRef>)
    expectDenied(validateTargetRef(visual, world()), 'transform-stale')
  })

  it('视觉引用全对时可解析', () => {
    const visual = targetRef({
      kind: 'visual',
      surfaceId: 'surface-1',
      captureId: 'capture-1',
      transformVersion: 3
    } as Partial<TargetRef>)
    expect(validateTargetRef(visual, world())).toEqual({ ok: true, tabId: 1 })
  })

  it('产出者非法（架构 §6.5 规则 2）', () => {
    const ref = targetRef({ producedBy: 'nobody' as TargetRef['producedBy'] })
    expectDenied(validateTargetRef(ref, world()), 'invalid-producer')
  })

  it('有人绕过类型塞进 kind: shell：页面引用不接受外壳目标', () => {
    const ref = targetRef({ kind: 'shell' } as unknown as Partial<TargetRef>)
    expectDenied(validateTargetRef(ref, world()), 'invalid-target')
  })

  it('targetId 为空被拒', () => {
    expectDenied(validateTargetRef(targetRef({ targetId: '' }), world()), 'invalid-target')
  })
})

describe('外壳元素引用：validateShellRef 统一入口', () => {
  it('存在于外壳元素表的引用可解析', () => {
    expect(validateShellRef(shellRef(), world())).toEqual({ ok: true })
  })

  it('元素不存在或不可被指认', () => {
    expectDenied(validateShellRef(shellRef({ elementId: 'ghost' }), world()), 'unknown-shell-element')
  })

  it('elementId 为空被拒', () => {
    expectDenied(validateShellRef(shellRef({ elementId: ' ' }), world()), 'invalid-target')
  })

  it('surfaceId 不是 shell：外壳引用不能伪装成页面引用', () => {
    const ref = shellRef({ surfaceId: 'page' as ShellRef['surfaceId'] })
    expectDenied(validateShellRef(ref, world()), 'target-kind-mismatch')
  })

  it('产出者非法', () => {
    const ref = shellRef({ producedBy: 'nobody' as ShellRef['producedBy'] })
    expectDenied(validateShellRef(ref, world()), 'invalid-producer')
  })

  it('外壳动作走同一条校验路径', () => {
    expect(validateCapabilityCall(call({ name: 'shell.invoke' }, shellRef()), world())).toEqual({ ok: true })
  })
})

describe('稳定错误码', () => {
  it('码表是快照：改名、删码、改顺序都会让这条用例失败', () => {
    expect(CAPABILITY_FAILURE_CODES).toEqual([
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
    ])
  })

  it('每个码都有非空且互不相同的文案（渲染层按码取文案）', () => {
    const texts = CAPABILITY_FAILURE_CODES.map((code) => capabilityFailureText[code])
    expect(texts.every((text) => typeof text === 'string' && text.trim().length > 0)).toBe(true)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('每个码在本 harness 里都被真的走通过一次（不留"理论上会有"的码）', () => {
    const untested = CAPABILITY_FAILURE_CODES.filter((code) => !seenCodes.has(code))
    expect(untested).toEqual([])
  })
})

describe('能力码 → 界面稳定码', () => {
  it('标签已关闭直接对上（界面本来就有这条文案）', () => {
    expect(browserCodeFor('unknown-tab')).toBe('unknown-tab')
  })

  it('「调用方请求本身不合法」归到 invalid-command', () => {
    const invalid: Array<Parameters<typeof browserCodeFor>[0]> = [
      'invalid-context',
      'invalid-producer',
      'invalid-target',
      'unknown-action',
      'actor-not-allowed',
      'target-required',
      'target-not-allowed',
      'target-kind-mismatch',
      'reason-required'
    ]
    for (const code of invalid) expect(browserCodeFor(code)).toBe('invalid-command')
  })

  it('门禁与代际失效走 capability-denied（细节留在记录的稳定码里）', () => {
    const denied: Array<Parameters<typeof browserCodeFor>[0]> = [
      'binding-stale',
      'navigation-stale',
      'observation-stale',
      'frame-stale',
      'surface-stale',
      'capture-stale',
      'transform-stale',
      'unknown-shell-element',
      'lease-blocks-discard',
      'flash-content',
      'tab-loading'
    ]
    for (const code of denied) expect(browserCodeFor(code)).toBe('capability-denied')
  })
})

describe('结构化调用记录', () => {
  it('成功调用记 outcome=ok，不带 code', () => {
    const log = new CapabilityCallLog({ now: () => 1_000 })
    const invocation = call({ name: 'tab.close' }, { tabId: 1 })
    const record = log.append(invocation, validateCapabilityCall(invocation, world()))
    expect(record).toMatchObject({ recordId: 'call-1', at: 1_000, actor: 'human-ui', action: 'tab.close', outcome: 'ok' })
    expect(record.code).toBeUndefined()
    expect(record.target).toEqual({ kind: 'browser', tabId: 1 })
  })

  it('被拒调用记下稳定错误码', () => {
    const log = new CapabilityCallLog()
    const invocation = call({ name: 'tab.close' }, { tabId: 9 })
    const record = log.append(invocation, validateCapabilityCall(invocation, world()))
    expect(record.outcome).toBe('denied')
    expect(record.code).toBe('unknown-tab')
  })

  it('不记录动作参数与载荷：地址不进入审计记录', () => {
    const log = new CapabilityCallLog()
    const invocation = call({ name: 'tab.navigate', address: 'https://secret.example/a?token=abc' }, { tabId: 1 })
    const record = log.append(invocation, validateCapabilityCall(invocation, world()))
    expect(JSON.stringify(record)).not.toContain('secret.example')
    expect(JSON.stringify(record)).not.toContain('token=abc')
  })

  it('记录 ID 递增、可按序读回', () => {
    const log = new CapabilityCallLog()
    const first = call({ name: 'tab.list' })
    const second = call({ name: 'tab.activate' }, { tabId: 1 })
    log.append(first, validateCapabilityCall(first, world()))
    log.append(second, validateCapabilityCall(second, world()))
    expect(log.list().map((entry) => entry.recordId)).toEqual(['call-1', 'call-2'])
    expect(log.size).toBe(2)
  })

  it('上下文非法时能记多少记多少，不编造一个合法 actor', () => {
    const log = new CapabilityCallLog()
    const invocation = {
      context: { actor: 'robot', profileId: '' },
      action: { name: 'tab.close' }
    } as unknown as CapabilityInvocation
    const record = log.append(invocation, validateCapabilityCall(invocation, world()))
    expect(record.actor).toBeUndefined()
    expect(record.profileId).toBeUndefined()
    expect(record.code).toBe('invalid-context')
  })

  it('超过上限时丢最旧的（环形缓冲）', () => {
    const log = new CapabilityCallLog({ limit: 2 })
    for (let index = 0; index < 3; index += 1) {
      const invocation = call({ name: 'tab.list' })
      log.append(invocation, validateCapabilityCall(invocation, world()))
    }
    expect(log.list().map((entry) => entry.recordId)).toEqual(['call-2', 'call-3'])
  })

  it('读回的是副本：外部改动影响不到记录表', () => {
    const log = new CapabilityCallLog()
    const invocation = call({ name: 'tab.close' }, { tabId: 1 })
    log.append(invocation, validateCapabilityCall(invocation, world()))
    const [entry] = log.list()
    entry.action = 'tampered'
    expect(log.list()[0].action).toBe('tab.close')
  })
})
