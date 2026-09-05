import { afterEach, describe, expect, it, vi } from 'vitest'
import { bloodFlowDecisionBudget, bloodFlowDecisionPrompt, createBloodFlowDecisions, createBloodFlowReactions } from './bloodFlowRuntime'
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
    expect(built.candidates.map(c=>c.action)).toEqual([{kind:'discard',index:0},{kind:'discard',index:1}])
    expect(JSON.parse(built.messages.user).discardPolicy).toContain('保护精牌和白板')
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
  it('does not request a model for locked or forced actions', async () => {
    const request = vi.fn()
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
    await vi.advanceTimersByTimeAsync(4500)
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
      const runner = createBloodFlowReactions({ provider: seat => seat > 0 ? provider : null, theme: () => theme, current: () => true, request, emit })
      const input = view()
      await runner.run(input)
      expect(request).not.toHaveBeenCalled()
      input.public = { ...input.public, status: 'settled', roundResult: simulateRound(1).result }
      await runner.run(input); await runner.run(input)
      const enabled = theme === 'llm' || theme === 'llmAnime'
      expect(request).toHaveBeenCalledTimes(enabled ? 3 : 0)
      expect(emit.mock.calls.map((args: any) => args[0].seat)).toEqual(enabled ? [1, 2, 3] : [])
      for (const call of request.mock.calls as any) expect(call[0].messages.user).not.toContain('hand')
    })
  }
  it('theme/round cancellation rejects late commentary without cancelling a valid decision', async () => {
    let finishReaction!: (v: any) => void, finishDecision!: (v: any) => void, decisionSignal!: AbortSignal
    const decisions = createBloodFlowDecisions({ provider: () => provider, waits: async () => [],
      request: options => { decisionSignal = options.signal!; return new Promise(resolve => { finishDecision = resolve }) } })
    const pending = decisions.decide(view(), () => true)
    await Promise.resolve(); await Promise.resolve()
    let theme = 'llm'
    const emit = vi.fn()
    const reactions = createBloodFlowReactions({ provider: () => provider, current: () => true, theme: () => theme, emit,
      request: () => new Promise(resolve => { finishReaction = resolve }) })
    const ended = view(); ended.public = { ...ended.public, status: 'settled', roundResult: simulateRound(1).result }
    const run = reactions.run(ended)
    theme = 'jade'; reactions.cancel(); finishReaction({ choice: 'COMMENT', message: '迟到感言' })
    await run
    expect(emit).not.toHaveBeenCalled()
    expect(decisionSignal.aborted).toBe(false)
    finishDecision({ choice: 'A1', message: '' })
    expect(await pending).toEqual({ kind: 'pass' })
  })
})
