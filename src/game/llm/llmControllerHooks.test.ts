// LLM 控制器「分析记录」可选钩子（§5 判据，见
// docs/blood-flow/design/analysis-two-variants-work-agreement.md §5）。
//
// 这一层是**纯旁路**：钩子只上报这次请求本来就已经有的东西（候选、推荐、提示词、回答、失败原因），
// 不新增请求、不改变回退行为。因此本文件同时断言两件事：
//   ① 不传钩子时零调用、零行为变化（返回动作与统计逐项相等）；
//   ② 传钩子时上报的内容与**真正发给模型的请求体**逐字对得上（用假 SSE 抓 fetch 的 body 比对）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CoreLlmController,
  createLlmStats,
  decisionPromptTemplateId,
  DECISION_PROMPT_TEMPLATE_VERSION,
  type LlmControllerHooks,
  type LlmDecisionAnswerHookInput,
  type LlmDecisionRequestHookInput,
} from './llmController'
import { resetReasoningBudgetForTests } from './reasoningBudget'
import type { LlmProviderConfig } from './config'
import type { TurnContext } from '../core/controllers/playerController'

const API_KEY = 'sk-hook-test-secret'

function provider(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    // 与 runtime.ts 的 toProviderConfig 同口径：预置带入 providerType，不靠 baseUrl 事后推断
    providerType: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: API_KEY,
    model: 'deepseek-chat',
    style: '稳健',
    timeoutMs: 8_000,
    ...overrides,
  }
}

/** 一次真实回合的上下文：座位上没有癞子白板，候选就是各种弃牌（≥1 个，够触发真实请求）。 */
function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    playerIndex: 2,
    hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p2', 'p3', 'p4', 's5', 's7'],
    melds: [],
    exposedMelds: 0,
    kongBloom: false,
    skipDraw: false,
    afterKong: false,
    scores: [25_000, 25_000, 25_000, 25_000],
    peers: [
      { discards: ['p9'], melds: [] },
      { discards: ['s1'], melds: [] },
      { discards: [], melds: [] },
      { discards: ['m5'], melds: [] },
    ],
    seatWind: '西',
    roundWind: '东',
    dealerIndex: 0,
    roundIndex: 2,
    requestId: 'turn-2-17',
    stateVersion: '2:discard:71:0:2:56',
    visibleTiles: [],
    publicTiles: [],
    upperLastDiscard: null,
    earlyRound: true,
    wallCount: 71,
    jokerTiles: ['white'],
    wildcardTiles: [],
    turnOrigin: 'draw',
    drawnTile: null,
    ...overrides,
  }
}

/** 假 SSE 响应：把**真正发出去的请求体**抓下来，供"逐字相等"断言使用。 */
function stubModelReply(reply: { choice: string; message: string } = { choice: 'A1', message: '稳住。' }) {
  const sent: Array<{ model?: string; messages?: Array<{ role: string; content: string }> }> = []
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as (typeof sent)[number])
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as never)
  return sent
}

/** 收集一次请求上报的开始/结束（两者都只在真的发出请求时触发）。 */
function recorder() {
  const requests: LlmDecisionRequestHookInput[] = []
  const answers: LlmDecisionAnswerHookInput[] = []
  const hooks: LlmControllerHooks = {
    onDecisionRequest: (input) => requests.push(input),
    onDecisionAnswer: (input) => answers.push(input),
  }
  return { hooks, requests, answers }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetReasoningBudgetForTests()
})

describe('分析钩子：不传时零成本、零行为变化（§5）', () => {
  it('不传钩子也照常决策，且与传钩子时返回同一动作、同一统计', async () => {
    stubModelReply()
    const bare = new CoreLlmController(provider(), {}, createLlmStats())
    const bareAction = await bare.requestTurn(turnContext())

    stubModelReply()
    const { hooks, requests } = recorder()
    const hooked = new CoreLlmController(provider(), hooks, createLlmStats())
    const hookedAction = await hooked.requestTurn(turnContext())

    expect(requests).toHaveLength(1)
    expect(hookedAction).toEqual(bareAction)
    expect(hooked.stats).toEqual(bare.stats)
    expect(bare.stats.requests).toBe(1)
  })

  it('候选只有一个（被短路成本地策略）时不发请求、也不上报', async () => {
    stubModelReply()
    const { hooks, requests, answers } = recorder()
    const controller = new CoreLlmController(provider(), hooks, createLlmStats())
    // 手牌只剩一种可打（其余都是白板癞子）⇒ 候选唯一 ⇒ decideCanonical 直接回退，没有请求
    await controller.requestTurn(turnContext({ hand: ['m1', 'white', 'white', 'white'] }))
    expect(requests).toHaveLength(0)
    expect(answers).toHaveLength(0)
    expect(controller.stats.requests).toBe(0)
  })
})

describe('onDecisionRequest：候选、推荐、模板与变量（§5）', () => {
  it('上报窗口内稳定 ID、候选、模型与提示词引用', async () => {
    stubModelReply()
    const { hooks, requests } = recorder()
    await new CoreLlmController(provider(), hooks, createLlmStats()).requestTurn(turnContext())
    const input = requests[0]!

    expect(input.seat).toBe(2)
    expect(input.requestId).toBe('turn-2-17')
    // 经典本地引擎没有独立权威窗口号 ⇒ windowId 就是引擎侧请求标识（两侧同一套编号）
    expect(input.windowId).toBe('turn-2-17')
    expect(input.provider).toBe('deepseek')
    expect(input.model).toBe('deepseek-chat')
    expect(typeof input.sentAt).toBe('number')

    // legalActions 与 candidates 一一对应，ID 是 `${windowId}/${下标}`
    expect(input.legalActions.length).toBeGreaterThan(1)
    expect(input.candidates).toHaveLength(input.legalActions.length)
    input.legalActions.forEach((action, index) => {
      expect(action.id).toBe(`${input.windowId}/${index}`)
      expect(input.candidates[index]!.id).toBe(action.id)
      expect(action.kind).toBe((input.candidates[index]!.action as { kind: string }).kind)
    })
    // summary 是提示词里的编号（A1/A2…），用于把记录与 promptVariables.user 对起来
    expect(input.candidates[0]!.summary).toMatch(/^[A-Z]/)
    // 推荐必须是候选里的一个（真正发出去的那个，不是事后补算）
    if (input.recommended) {
      expect(input.candidates.map((candidate) => candidate.id)).toContain(input.recommended.candidateId)
    }
  })

  it('promptVariables 与真正发给模型的 messages 逐字相等', async () => {
    const sent = stubModelReply({ choice: 'A2', message: '这手先过。' })
    const { hooks, requests } = recorder()
    await new CoreLlmController(provider(), hooks, createLlmStats()).requestTurn(turnContext())

    const body = sent[0]!
    const variables = requests[0]!.promptVariables as { system: string; user: string }
    expect(variables.user).toBe(body.messages!.find((message) => message.role === 'user')!.content)
    expect(variables.system).toBe(body.messages!.find((message) => message.role === 'system')!.content)
  })

  it('模板 id 只由玩法与风格决定：同规格两次请求得到同一个 id（内容按 id 去重只存一次）', async () => {
    stubModelReply()
    const first = recorder()
    await new CoreLlmController(provider(), first.hooks, createLlmStats()).requestTurn(turnContext())
    stubModelReply()
    const second = recorder()
    await new CoreLlmController(provider(), second.hooks, createLlmStats()).requestTurn(turnContext())

    const expected = `decision-prompt/${DECISION_PROMPT_TEMPLATE_VERSION}/lotus-classic/稳健`
    expect(first.requests[0]!.promptTemplateId).toBe(expected)
    expect(second.requests[0]!.promptTemplateId).toBe(expected)
    expect(decisionPromptTemplateId('lotus-classic', '激进')).not.toBe(expected)
    expect(decisionPromptTemplateId('lotus-legacy', '稳健')).not.toBe(expected)
  })

  it('变量里不含 API Key / Authorization（§4、§8）', async () => {
    stubModelReply()
    const { hooks, requests, answers } = recorder()
    await new CoreLlmController(provider(), hooks, createLlmStats()).requestTurn(turnContext())
    const dumped = `${JSON.stringify(requests[0]!.promptVariables)}${JSON.stringify(requests[0]!.candidates)}${JSON.stringify(requests[0]!.legalActions)}${JSON.stringify(answers)}`
    expect(dumped).not.toContain(API_KEY)
    expect(dumped.toLowerCase()).not.toContain('authorization')
    expect(dumped.toLowerCase()).not.toContain('apikey')
  })
})

describe('onDecisionAnswer：结果、原话与回退原因（§5）', () => {
  it('经典玩法模型选了严格劣于推荐的弃牌时回退，并保留原回答', async () => {
    stubModelReply({ choice: 'A1', message: '先打这一张。' })
    const { hooks, requests, answers } = recorder()
    const controller = new CoreLlmController(provider(), hooks, createLlmStats())
    const hand = [
      'm6', 'm7', 'm8', 'p6', 'p6', 'p7', 'p8', 'p8', 'p9',
      's1', 's4', 's4', 'west', 'p1',
    ] as TurnContext['hand']
    const action = await controller.requestTurn(turnContext({ hand, visibleTiles: hand, wallCount: 40 }))
    const request = requests[0]!
    const recommended = request.legalActions.find((candidate) => candidate.id === request.recommended?.candidateId)!
    expect(recommended.kind).toBe('discard')
    expect(action).toEqual({ kind: 'discard', handIndex: recommended.handIndex })
    expect(hand[recommended.handIndex!]).toBe('west')
    expect(answers[0]).toMatchObject({
      outcome: 'guarded', choice: 'A1', raw: '先打这一张。',
      fallback: { reason: 'classic-discard-dominated-by-recommendation' },
    })
    expect(controller.stats.fallbacks).toBe(1)
    expect(controller.stats.successes).toBe(0)
  })

  it('成功：带上模型原话与解析到的候选', async () => {
    stubModelReply({ choice: 'A2', message: '这手先过。' })
    const { hooks, answers } = recorder()
    await new CoreLlmController(provider(), hooks, createLlmStats()).requestTurn(turnContext())
    expect(answers).toHaveLength(1)
    expect(answers[0]!.outcome).toBe('success')
    expect(answers[0]!.choice).toBe('A2')
    expect(answers[0]!.raw).toBe('这手先过。')
    expect(answers[0]!.fallback).toBeUndefined()
    expect(answers[0]!.requestId).toBe('turn-2-17')
    expect(typeof answers[0]!.completedAt).toBe('number')
  })

  it('回答里的编号不在候选列表：客户端先做一次语义重试，重试仍非法才如实记成 error', async () => {
    stubModelReply({ choice: 'ZZ', message: '随便说说。' })
    const { hooks, answers } = recorder()
    const controller = new CoreLlmController(provider(), hooks, createLlmStats())
    const action = await controller.requestTurn(turnContext())
    // 白名单校验在客户端（parseLlmOutput）里，控制器看不到非法回答本身：
    // outcome=invalid 那条分支是防御性的（解析层已经拦掉"编号不存在"这一种），这里记的是请求失败。
    expect(answers[0]!.outcome).toBe('error')
    expect(answers[0]!.fallback?.reason).toContain('不在合法候选列表')
    // 回退没有被改变：仍然给出一个合法的本地动作
    expect(action.kind).toBe('discard')
    expect(controller.stats.fallbacks).toBe(1)
    expect(controller.stats.successes).toBe(0)
  })

  it('请求异常：outcome=error 并如实带上原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }) as never)
    const { hooks, answers } = recorder()
    const controller = new CoreLlmController(provider(), hooks, createLlmStats())
    const action = await controller.requestTurn(turnContext())
    expect(answers[0]!.outcome).toBe('error')
    expect(answers[0]!.fallback?.reason).toContain('network down')
    expect(answers[0]!.raw).toBe('')
    expect(answers[0]!.choice).toBeNull()
    expect(action.kind).toBe('discard')
  })

  it('请求超时：outcome=timeout（与 error 分开记）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }) as never)
    const { hooks, answers } = recorder()
    const controller = new CoreLlmController(provider(), hooks, createLlmStats())
    await controller.requestTurn(turnContext())
    expect(answers[0]!.outcome).toBe('timeout')
    expect(answers[0]!.fallback?.reason).toContain('timeout')
  })

  it('钩子自身抛错不影响对局：动作照常返回', async () => {
    stubModelReply({ choice: 'A2', message: '这手先过。' })
    const controller = new CoreLlmController(provider(), {
      onDecisionRequest: () => { throw new Error('分析上报炸了') },
      onDecisionAnswer: () => { throw new Error('分析上报炸了') },
    }, createLlmStats())
    await expect(controller.requestTurn(turnContext())).resolves.toMatchObject({ kind: 'discard' })
  })
})
