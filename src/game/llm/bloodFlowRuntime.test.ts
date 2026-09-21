import { LLM_WIN_LINES, LLM_LOSS_LINES, LLM_DRAW_LINES } from './winLines'
import { BLOOD_FLOW_LOSS_LINES, BLOOD_FLOW_WIN_LINES } from './bloodFlowRoundLines'
import { animeVoiceLine } from './animeCharacters'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bloodFlowDecisionBudget, bloodFlowDecisionPrompt, createBloodFlowDecisions, createBloodFlowReactions, remoteVoiceIdentity } from './bloodFlowRuntime'
import { BloodFlowEngine } from '../variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import { seededRandom, simulateRound } from '../variants/lotus/bloodFlow/simulation'
import { scorePatterns } from '../variants/lotus/patterns/score'
import type { LlmProviderPreset } from './config'

const provider: LlmProviderPreset = { id: 'test', name: 'test', apiKey: 'test-private-key', baseUrl: 'https://example.test/v1', model: 'test', style: '稳健', timeoutMs: 40_000 }
function view() {
  const v = bloodFlowSeatView(new BloodFlowEngine({ authorityEpoch: 'epoch', roundId: 'round', random: seededRandom(23), now: () => 0 }), 0)
  v.window!.deadlineAt = Infinity
  v.ownActions = [{ kind: 'win' }, { kind: 'pass' }]
  v.ownScore = scorePatterns(['pinghu'], false, 'self-draw')
  return v
}
afterEach(() => vi.useRealTimers())

describe('E08 decision and reaction isolation', () => {
  it('excludes protected discards from model candidates and rejects a removed choice', async () => {
    const input = view()
    input.players[0].hand=['m1','p9','red','green','white']; input.jokers=['red','green']
    input.ownActions=input.players[0].hand.map((_,index)=>({kind:'discard',index})); input.ownScore=null
    const original=structuredClone(input.ownActions)
    const built=bloodFlowDecisionPrompt(input,[],'test')
    expect(built.candidates.map(c=>c.action)).toEqual([{kind:'discard',index:0},{kind:'discard',index:1},{kind:'discard',index:4}])
    expect(JSON.parse(built.messages.user).discardPolicy).toContain('非精白板按受限替代价值')
    const request=vi.fn(async()=>({choice:'A4',message:''}))
    const service=createBloodFlowDecisions({provider:()=>provider,waits:async()=>[],request})
    expect(await service.decide(input,()=>true)).toBeNull()
    expect(service.stats.invalidActions).toBe(1)
    expect(input.ownActions).toEqual(original)
  })
  it('first win offers win/pass, ignores model speech and deduplicates a request', async () => {
    const request = vi.fn(async () => ({ choice: 'A1', message: 'mandatory important 发言不得播出' }))
    const service = createBloodFlowDecisions({ provider: () => provider, request, waits: async () => [] })
    const input = view()
    const a = service.decide(input, () => true), b = service.decide(input, () => true)
    expect(a).toBe(b)
    expect(await a).toEqual({ kind: 'pass' })
    expect(request).toHaveBeenCalledOnce()
    const sent = request.mock.calls[0] as any
    const payload = JSON.parse(sent[0].messages.user)
    expect(payload.candidates.map((c: any) => c.label)).toEqual(['胡牌（首次胡后锁手）', '过'])
    expect(payload.publicPlayers.every((p: any) => !('hand' in p))).toBe(true)
    expect(sent[0].messages.user).not.toContain('test-private-key')
    expect(service.stats.messages).toBe(0)
  })
  // §4 的"请求内容引用"：模板按版本去重存一次，决策只存**真正发出去的变量**。
  // 这条护栏的重点是"逐字一致"：记录的变量必须就是 messages.user 里那一份（否则离线重建看到的不是模型当时看到的）。
  it('records the prompt template once and the variables verbatim', async () => {
    const templates: Array<{ id: string; content: unknown }> = []
    const started: Array<Record<string, unknown>> = []
    const request = vi.fn(async () => ({ choice: 'A1', message: '' }))
    const service = createBloodFlowDecisions({
      provider: () => provider, request, waits: async () => [],
      analysis: {
        promptTemplate: (input: { id: string; content: unknown }) => { templates.push(input) },
        attemptStarted: (input: Record<string, unknown>) => { started.push(input); return 'attempt-1' },
        attemptFinished: () => {},
        candidates: () => {},
        source: () => {},
      } as never,
    })
    await service.decide(view(), () => true)

    expect(templates, '模板登记一次').toHaveLength(1)
    expect(templates[0].id).toContain('bloodFlow-decision/v1')
    const sent = request.mock.calls[0] as any
    expect(started[0].promptTemplateId).toBe(templates[0].id)
    expect(started[0].promptVariables, '记录的变量必须与发给模型的一致').toEqual(JSON.parse(sent[0].messages.user))
    // §4：禁止保存 API Key／凭据
    expect(JSON.stringify(started[0].promptVariables)).not.toContain(provider.apiKey)
    expect(JSON.stringify(templates[0].content)).not.toContain(provider.apiKey)
  })

  it('does not request a model for locked or forced actions', async () => {    const request = vi.fn()
    const service = createBloodFlowDecisions({ provider: () => provider, request })
    const input = view()
    input.public = { ...input.public, seats: [{ ...input.public.seats[0], locked: true }, ...input.public.seats.slice(1)] as any }
    expect(await service.decide(input, () => true)).toEqual({ kind: 'win' })
    input.ownActions = [{ kind: 'discard', index: 13 }]
    expect(await service.decide(input, () => true)).toEqual({ kind: 'discard', index: 13 })
    expect(request).not.toHaveBeenCalled()
  })
  it('bounds the entire job, discards late results and preserves an explicitly disabled local timeout', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    let resolve!: (v: any) => void
    const request = vi.fn(() => new Promise<any>(r => { resolve = r }))
    const service = createBloodFlowDecisions({ provider: () => provider, request, waits: async () => [] })
    const input = view()
    const pending = service.decide(input, () => true)
    expect(bloodFlowDecisionBudget(provider,input,0)).toBe(40_000)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await pending).toBeNull()
    expect((request.mock.calls[0] as any)[0].signal.aborted).toBe(true)
    resolve({ choice: 'A0', message: '' }); await Promise.resolve()
    expect(service.stats.successes).toBe(0)
    expect(bloodFlowDecisionBudget({ ...provider, timeoutEnabled: false }, input, 0)).toBe(Infinity)
    input.window!.deadlineAt = 3000
    expect(bloodFlowDecisionBudget({ ...provider, timeoutEnabled: false }, input, 0)).toBe(2750)
  })
  for (const theme of ['jade', 'rosewood', 'happyMahjong', 'llm', 'llmAnime']) {
    it(`${theme}: no in-round reaction and only approved themes generate one line per configured seat`, async () => {
      const request = vi.fn(async () => ({ choice: 'COMMENT', message: '下局继续努力' })), emit = vi.fn(async () => {})
      const runner = createBloodFlowReactions({ provider: seat => seat > 0 ? provider : null, theme: () => theme, current: () => true, emit })
      const input = view()
      await runner.run(input)
      expect(request).not.toHaveBeenCalled()
      input.public = { ...input.public, status: 'settled', roundResult: simulateRound(1).result }
      await runner.run(input); await runner.run(input)
      const enabled = theme === 'llm' || theme === 'llmAnime'
      expect(request).not.toHaveBeenCalled()
      expect(emit.mock.calls.map((args: any) => args[0].seat)).toEqual(enabled ? [1, 2, 3] : [])
      const originalLines = [...Object.values(LLM_WIN_LINES).flatMap(styles => styles.稳健), ...LLM_LOSS_LINES.稳健, ...LLM_DRAW_LINES.稳健]
      for (const call of emit.mock.calls as any) expect(originalLines).toContain(call[0].text)
    })
  }
  it('llmAnime uses the seat character result line, other themes keep the style library', async () => {
    const emit = vi.fn(async () => {})
    const seatView = view()
    seatView.public = { ...seatView.public, status: 'settled',
      batches: [{ winners: [{ winner: 1, ordinal: 1, score: { source: 'discard' } }] }],
      roundResult: { ...simulateRound(1).result, winCounts: [1, 0, 0, 0], winNet: [100, 0, 0, 0], kongNet: [0, 0, 0, 0] } } as any
    for (const [theme, character] of [['llmAnime', () => 'deepseek'], ['llm', () => 'deepseek'], ['llmAnime', () => undefined]] as const) {
      emit.mockClear()
      const runner = createBloodFlowReactions({ provider: seat => seat > 0 ? provider : null, theme: () => theme,
        current: () => true, emit, character })
      await runner.run(seatView)
      const lines = emit.mock.calls.map((args: any) => args[0])
      expect(lines.map(line => line.seat), `${theme}`).toEqual([1, 2, 3])
      if (theme === 'llmAnime' && character() === 'deepseek') {
        // 赢家（点炮胡）与其余两家分别说角色专属的 win-discard / loss，音色也换成该角色。
        expect(lines[0].text).toBe(animeVoiceLine('deepseek', 'win-discard'))
        expect(lines[0].voiceKey).toBe('deepseek')
        expect(lines[1].text).toBe(animeVoiceLine('deepseek', 'loss'))
      } else {
        // 非 llmAnime（含 llm 主题）与没有角色的座位：血流专属局末台词库不变。
        const fallback = [...Object.values(BLOOD_FLOW_WIN_LINES).flatMap(styles => styles.稳健),
          ...BLOOD_FLOW_LOSS_LINES.稳健, ...LLM_DRAW_LINES.稳健]
        for (const line of lines) expect(fallback).toContain(line.text)
        expect(lines[0].voiceKey).toBe('default')
      }
    }
  })
  it('theme/round cancellation rejects late commentary without cancelling a valid decision', async () => {
    let finishReaction!: (v: any) => void, finishDecision!: (v: any) => void, decisionSignal!: AbortSignal
    const decisions = createBloodFlowDecisions({ provider: () => provider, waits: async () => [],
      request: options => { decisionSignal = options.signal!; return new Promise(resolve => { finishDecision = resolve }) } })
    const pending = decisions.decide(view(), () => true)
    await Promise.resolve(); await Promise.resolve()
    let theme = 'llm'
    const emit = vi.fn(() => new Promise<void>(resolve => { finishReaction = resolve }))
    const reactions = createBloodFlowReactions({ provider: () => provider, current: () => true, theme: () => theme, emit })
    const ended = view(); ended.public = { ...ended.public, status: 'settled', roundResult: simulateRound(1).result }
    const run = reactions.run(ended)
    theme = 'jade'; reactions.cancel(); finishReaction(undefined)
    await run
    expect(emit).toHaveBeenCalledTimes(1)
    expect((emit.mock.calls[0] as any)[1].aborted).toBe(true)
    expect(decisionSignal.aborted).toBe(false)
    finishDecision({ choice: 'A1', message: '' })
    expect(await pending).toEqual({ kind: 'pass' })
  })
})

describe('联机座位语音身份（服务端供应商下发）', () => {
  it('按快照的 style/voiceKey 取用；非法或缺失一律回退策略默认音色', () => {
    expect(remoteVoiceIdentity({ style: '高冷', voiceKey: 'qwen' })).toEqual({ voiceKey: 'qwen', style: '高冷' })
    expect(remoteVoiceIdentity({ style: '激进', voiceKey: 'gpt' })).toEqual({ voiceKey: 'gpt', style: '激进' })
    // 'auto' 不是运行时音色键；未知键/未知策略回退默认。
    expect(remoteVoiceIdentity({ voiceKey: 'auto' })).toEqual({ voiceKey: 'default', style: '稳健' })
    expect(remoteVoiceIdentity({ style: '暴躁', voiceKey: 'not-a-voice' }))
      .toEqual({ voiceKey: 'default', style: '稳健' })
    expect(remoteVoiceIdentity({})).toEqual({ voiceKey: 'default', style: '稳健' })
  })
})
