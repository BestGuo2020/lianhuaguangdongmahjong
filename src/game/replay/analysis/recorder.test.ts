import { describe, expect, it } from 'vitest'
import { createAnalysisRecorder, type AnalysisRecorder } from './recorder'
import { createAnalysisMemoryStorage, type AnalysisStorage } from './storage'
import type { AnalysisBlockPart } from './codec'
import type { AnalysisDecision, AnalysisDecisionState, AnalysisLlmAttempt } from './types'

// P0 录制核心的验收点（方案 §3.2／§3.3／§3.4／§3.5，队列与失败处理见 §9.5）：
// 决策关联与前态、三层动作、拒胡/过牌判定、来源与回执分离、LLM 尝试与回退、单调时钟计时、
// 状态去重、失败只暂停分析，以及"录制不修改调用方传进来的任何对象"（§10.1、§10.7 的单元级证据）。

const matchInput = {
  engineBuild: 'blood-flow@test', rulesVersion: 'lotus-blood-flow-v1', rulesFingerprint: 'r1',
  rules: { rounds: 4 }, aiStrategy: 'source-v2', aiFingerprint: 'a1', aiConfig: { reform: true },
  seatControl: ['human', 'llm', 'llm', 'local-ai'] as const,
}

function setup(options: { enabled?: boolean; storage?: AnalysisStorage | null; clock?: { mono: number } } = {}) {
  const clock = options.clock ?? { mono: 1_000 }
  const storage = options.storage === undefined ? createAnalysisMemoryStorage() : options.storage
  const recorder = createAnalysisRecorder({
    enabled: options.enabled ?? true,
    matchId: 'm1',
    rulesetId: 'lotus-blood-flow',
    storage,
    now: () => 1_700_000_000_000,
    monotonic: () => clock.mono,
  })
  return { recorder, storage, clock }
}

async function readParts(storage: AnalysisStorage, tag: string) {
  const read = await storage.read('m1')
  return read.parts.filter((part: AnalysisBlockPart) => part.tag === tag).map((part) => part.value)
}

function legalActions() {
  return [
    { id: 'win-1', kind: 'win' },
    { id: 'discard-3', kind: 'discard', tile: 'm5', handIndex: 3 },
    { id: 'pass-1', kind: 'pass' },
  ]
}

describe('分析录制核心（P0）', () => {
  // §4：提示词模板按版本去重存一次，决策侧只保存实际变量输入（不重复存模板全文）
  it('提示词模板按 id 去重：同一模板只落一条，不同版本各落一条', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    recorder.promptTemplate({ id: 'bloodFlow-decision/v1/稳健/plain', content: '系统提示正文' })
    recorder.promptTemplate({ id: 'bloodFlow-decision/v1/稳健/plain', content: '系统提示正文' })
    recorder.promptTemplate({ id: 'bloodFlow-decision/v1/激进/plain', content: '另一份系统提示' })

    // 决策只引用模板 id + 变量，不重复模板正文
    recorder.windowOpened({
      windowId: 'w1', seat: 1, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1,
      state: { id: 's1', legalActions: [] },
    })
    const attemptId = recorder.attemptStarted({
      decisionWindowId: 'w1', seat: 1, requestId: 'req-1', attempt: 1, provider: 'p', requestModel: 'm', sampling: {},
      promptTemplateId: 'bloodFlow-decision/v1/稳健/plain', promptVariables: { seat: 1, hand: ['m5'] },
    })
    recorder.attemptFinished(attemptId, { outcome: 'success' })
    await recorder.finish()

    const templates = await readParts(storage, 'promptTemplate') as Array<{ id: string; content: string }>
    expect(templates.map(template => template.id)).toEqual(['bloodFlow-decision/v1/稳健/plain', 'bloodFlow-decision/v1/激进/plain'])
    expect(templates[0].content).toBe('系统提示正文')
    const attempts = await readParts(storage, 'llm') as AnalysisLlmAttempt[]
    expect(attempts[0].promptTemplateId).toBe('bloodFlow-decision/v1/稳健/plain')
    expect(attempts[0].promptVariables).toEqual({ seat: 1, hand: ['m5'] })
    expect(JSON.stringify(attempts[0])).not.toContain('系统提示正文')
  })

  it('全链路：配置 → 窗口 → 合法/候选/推荐 → 选择 → 回执，都能读回并互相关联', async () => {
    const { recorder, storage, clock } = setup()
    const configId = recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    expect(configId).not.toBe('')

    recorder.windowOpened({
      windowId: 'w1', seat: 1, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 7,
      state: { id: 's1', fingerprint: 'fp1', hand: ['m5', 'p2'], drawnTileIndex: 1, winScores: { known: true, value: { menqing: 20 } } },
      openedAt: clock.mono,
    })
    recorder.candidates({
      windowId: 'w1', seat: 1, legalActions: legalActions(),
      candidates: [
        { legalActionId: 'discard-3', action: { id: 'discard-3', kind: 'discard', tile: 'm5', handIndex: 3 } },
        { legalActionId: 'win-1', action: { id: 'win-1', kind: 'win' }, reason: 'route-narrowed' },
      ],
      restricted: [{ legalActionId: 'win-1', reason: 'route-narrowed' }],
      estimates: { immediateIncome: { known: true, value: 120 }, riskCost: { known: false }, units: 'points', includesPayments: true },
      recommended: { known: true, value: { legalActionId: 'discard-3', note: 'EV 最高' } },
    })
    clock.mono += 250
    recorder.chosen({ windowId: 'w1', seat: 1, legalActionId: 'discard-3', source: 'local-strategy', commandId: 'cmd-1', at: clock.mono })
    recorder.receipt({ windowId: 'w1', seat: 1, status: 'executed', eventId: 'ev-1', executedLegalActionId: 'discard-3' })
    await recorder.flush()

    const configs = await readParts(storage, 'config')
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({ id: configId, rulesVersion: 'lotus-blood-flow-v1', seatControl: ['human', 'llm', 'llm', 'local-ai'] })

    const states = await readParts(storage, 'decisionState') as AnalysisDecisionState[]
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ id: 's1', hand: ['m5', 'p2'], drawnTileIndex: 1 })

    const decisions = await readParts(storage, 'decision') as Array<AnalysisDecision & { legalActions?: unknown[] }>
    const final = decisions.at(-1)!
    expect(final).toMatchObject({
      matchId: 'm1', roundIndex: 1, authorityEpoch: 'e1', windowId: 'w1', stateVersion: 7, seat: 1,
      windowKind: 'draw-turn', stateId: 's1', source: 'local-strategy', configId,
    })
    expect(final.candidates.map((candidate) => candidate.legalActionId)).toEqual(['discard-3', 'win-1'])
    expect(final.restricted).toEqual([{ legalActionId: 'win-1', reason: 'route-narrowed' }])
    expect(final.choice).toEqual({ known: true, value: { legalActionId: 'discard-3', action: { id: 'discard-3', kind: 'discard', tile: 'm5', handIndex: 3 } } })
    expect(final.execution).toMatchObject({ status: 'executed', commandId: 'cmd-1', eventId: 'ev-1', executedLegalActionId: 'discard-3' })
    expect(final.estimates?.riskCost).toEqual({ known: false })   // 没算过的量不填 0
    expect(final.timing.computeMs).toBe(250)                       // 用单调时钟
    expect(final.declinedWin).toBe(true)                           // 有合法胡牌却选择弃牌
    expect(final.passed).toBeUndefined()
  })

  it('拒胡与过牌的判定口径：没有合法胡牌候选时不得推断为主动过牌', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    // 无胡牌候选，选择弃牌 → 不标拒胡
    recorder.windowOpened({ windowId: 'w1', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 's1' } })
    recorder.candidates({ windowId: 'w1', seat: 0, legalActions: [{ id: 'discard-1', kind: 'discard' }, { id: 'pass-1', kind: 'pass' }], candidates: [] })
    recorder.chosen({ windowId: 'w1', seat: 0, legalActionId: 'discard-1', source: 'human' })
    // 选择过牌 → passed
    recorder.windowOpened({ windowId: 'w2', seat: 0, windowKind: 'claim', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 2, state: { id: 's2' } })
    recorder.candidates({ windowId: 'w2', seat: 0, legalActions: [{ id: 'peng-1', kind: 'peng' }, { id: 'pass-2', kind: 'pass' }], candidates: [] })
    recorder.chosen({ windowId: 'w2', seat: 0, legalActionId: 'pass-2', source: 'model' })
    await recorder.flush()

    const decisions = await readParts(storage, 'decision') as AnalysisDecision[]
    const first = decisions.find((item) => item.windowId === 'w1')!
    const second = decisions.find((item) => item.windowId === 'w2')!
    expect(first.declinedWin).toBeUndefined()
    expect(first.passed).toBeUndefined()
    expect(second.passed).toBe(true)
    expect(second.declinedWin).toBeUndefined()
  })

  it('来源与回执分离：模型回答了但窗口过期，两者都要如实记录', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    recorder.windowOpened({ windowId: 'w1', seat: 2, windowKind: 'claim', roundIndex: 2, authorityEpoch: 'e1', stateVersion: 9, state: { id: 's9' } })
    recorder.candidates({ windowId: 'w1', seat: 2, legalActions: legalActions(), candidates: [] })
    const attemptId = recorder.attemptStarted({
      decisionWindowId: 'w1', seat: 2, requestId: 'req-1', attempt: 1, provider: 'deepseek', requestModel: 'deepseek-chat',
      sampling: { temperature: 0.7 }, promptTemplateId: 'tpl-1', promptVariables: { round: 2 },
    })
    recorder.attemptFinished(attemptId, {
      outcome: 'timeout', responseModel: { known: false },
      fallback: { reason: 'timeout', strategy: 'local-strategy', legalActionId: 'discard-3' },
    })
    recorder.chosen({ windowId: 'w1', seat: 2, legalActionId: 'discard-3', source: 'model-fallback' })
    recorder.receipt({ windowId: 'w1', seat: 2, status: 'window-expired', detail: 'deadline passed' })
    await recorder.flush()

    const attempts = await readParts(storage, 'llm') as AnalysisLlmAttempt[]
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ requestId: 'req-1', attempt: 1, outcome: 'timeout', promptTemplateId: 'tpl-1' })
    expect(attempts[0].fallback).toEqual({ reason: 'timeout', strategy: 'local-strategy', legalActionId: 'discard-3' })
    expect(attempts[0].responseModel).toEqual({ known: false })
    expect(attempts[0].timing.durationMs).toBe(0)

    const decisions = await readParts(storage, 'decision') as AnalysisDecision[]
    const final = decisions.at(-1)!
    expect(final.source).toBe('model-fallback')
    expect(final.execution.status).toBe('window-expired')
    expect(final.llmAttemptIds).toEqual([attempts[0].id])
  })

  it('回退链会把决策来源标成 model-fallback，不会把兜底动作算成模型的选择', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    recorder.windowOpened({ windowId: 'w1', seat: 3, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 's1' } })
    recorder.candidates({ windowId: 'w1', seat: 3, legalActions: legalActions(), candidates: [] })
    const attemptId = recorder.attemptStarted({
      decisionWindowId: 'w1', seat: 3, requestId: 'r', attempt: 1, provider: 'p', requestModel: 'm', sampling: {},
    })
    recorder.attemptFinished(attemptId, { outcome: 'parse-failed', fallback: { reason: 'parse-failed', strategy: 'local-strategy' } })
    recorder.chosen({ windowId: 'w1', seat: 3, legalActionId: 'discard-3', source: 'model' })
    await recorder.flush()
    const decisions = await readParts(storage, 'decision') as AnalysisDecision[]
    expect(decisions.at(-1)!.source).toBe('model-fallback')
  })

  it('决策前态按 id 去重：同一状态不会被重复落库', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    for (let index = 0; index < 3; index += 1) {
      recorder.windowOpened({ windowId: 'w1', seat: 1, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 3, state: { id: 'shared-state', hand: ['m1'] } })
    }
    recorder.windowOpened({ windowId: 'w1', seat: 2, windowKind: 'claim', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 3, state: { id: 'other-state', hand: ['m2'] } })
    await recorder.flush()
    const states = await readParts(storage, 'decisionState') as AnalysisDecisionState[]
    expect(states.map((state) => state.id)).toEqual(['shared-state', 'other-state'])
  })

  it('计时只用本进程单调时钟，且不把墙钟差值当耗时', async () => {
    const clock = { mono: 5_000 }
    const { recorder, storage } = setup({ clock })
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    recorder.windowOpened({ windowId: 'w1', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 's1' }, openedAt: clock.mono, deadlineAt: clock.mono + 3_000 })
    recorder.candidates({ windowId: 'w1', seat: 0, legalActions: legalActions(), candidates: [] })
    clock.mono += 750
    recorder.chosen({ windowId: 'w1', seat: 0, legalActionId: 'discard-3', source: 'human' })
    await recorder.flush()
    const decisions = await readParts(storage, 'decision') as AnalysisDecision[]
    const final = decisions.at(-1)!
    expect(final.timing).toMatchObject({ windowOpenedAt: 5_000, submittedAt: 5_750, computeMs: 750, deadlineAt: 8_000 })
  })

  it('分析区不可用时：只暂停并留痕，不抛错、不无限堆积，之后的记录不再累积', async () => {
    const errors: string[] = []
    const storage = createAnalysisMemoryStorage()
    const recorder = createAnalysisRecorder({
      enabled: true, matchId: 'm1', rulesetId: 'lotus-blood-flow', storage: null, now: () => 1, monotonic: () => 1,
      onError: (detail) => errors.push(detail),
    })
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    recorder.windowOpened({ windowId: 'w1', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 's1' } })
    await recorder.flush()
    expect(recorder.paused()).toBe(true)
    expect(errors.join(' | ')).toContain('分析区不可用')
    const before = recorder.diagnostics()
    recorder.windowOpened({ windowId: 'w2', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 2, state: { id: 's2' } })
    recorder.noteGap({ scope: 'round', from: 2, reason: 'paused' })
    const after = recorder.diagnostics()
    expect(after.pendingBytes).toBe(before.pendingBytes)
    expect((await storage.usage()).bytes).toBe(0)
  })

  it('录制不修改调用方传进来的对象（录制开/关都不改变策略输入，§10.1）', async () => {
    const { recorder } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    const legal = legalActions()
    const candidates = [{ legalActionId: 'discard-3', action: { id: 'discard-3', kind: 'discard', tile: 'm5', handIndex: 3 } }]
    const state = { id: 's1', hand: ['m5', 'p2'], locks: { locked: true } }
    const legalSnapshot = JSON.stringify(legal)
    const candidatesSnapshot = JSON.stringify(candidates)
    const stateSnapshot = JSON.stringify(state)
    recorder.windowOpened({ windowId: 'w1', seat: 1, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state })
    recorder.candidates({ windowId: 'w1', seat: 1, legalActions: legal, candidates })
    recorder.chosen({ windowId: 'w1', seat: 1, legalActionId: 'discard-3', source: 'local-strategy' })
    expect(JSON.stringify(legal)).toBe(legalSnapshot)
    expect(JSON.stringify(candidates)).toBe(candidatesSnapshot)
    expect(JSON.stringify(state)).toBe(stateSnapshot)
  })

  it('未启用分析时：所有方法空转，分析区一次写入都没有（§9.2、§10.7）', async () => {
    let writes = 0
    const inner = createAnalysisMemoryStorage()
    const storage: AnalysisStorage = {
      ...inner,
      write: async (...args) => { writes += 1; return inner.write(...args) },
    }
    const { recorder } = setup({ enabled: false, storage })
    expect(recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })).toBe('')
    recorder.windowOpened({ windowId: 'w1', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 's1' } })
    recorder.candidates({ windowId: 'w1', seat: 0, legalActions: legalActions(), candidates: [] })
    recorder.chosen({ windowId: 'w1', seat: 0, legalActionId: 'discard-3', source: 'local-strategy' })
    expect(recorder.attemptStarted({ decisionWindowId: 'w1', seat: 0, requestId: 'r', attempt: 1, provider: 'p', requestModel: 'm', sampling: {} })).toBe('')
    await recorder.flush()
    const result = await recorder.finish()
    expect(writes).toBe(0)
    expect(recorder.diagnostics()).toMatchObject({ decisions: 0, attempts: 0, pendingBytes: 0 })
    expect(result.status).toBe('disabled')
  })

  it('响应窗口检查点（§9.3）：看得见手牌就落检查点，看不见就留痕且不凭空补', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })

    // 情形一：拿到了该座位的手牌（本地 AI/LLM/人类都能看到自己的手）= 落检查点
    recorder.windowOpened({
      windowId: 'w1', seat: 1, windowKind: 'claim', roundIndex: 2, authorityEpoch: 'e1', stateVersion: 4,
      state: { id: 'claim-state', hand: ['m5', 'm5', 'p2', 's3'], drawnTileIndex: 3 },
    })
    recorder.candidates({ windowId: 'w1', seat: 1, legalActions: [{ id: 'w1/0', kind: 'peng' }], candidates: [] })
    recorder.chosen({ windowId: 'w1', seat: 1, legalActionId: 'w1/0', source: 'model' })
    await recorder.flush()
    const decisions = await readParts(storage, 'decision') as AnalysisDecision[]
    const claim = decisions.find(item => item.windowId === 'w1')!
    expect(claim.source).toBe('model')
    // 检查点作为独立记录落库，用 decisionId 与决策关联
    const checkpoints = await readParts(storage, 'responderCheckpoint') as Array<{ decisionId: string; seat: number; hand: string[]; drawnTileIndex: number }>
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({ seat: 1, hand: ['m5', 'm5', 'p2', 's3'], drawnTileIndex: 3 })
    expect(checkpoints[0].decisionId).toBe(claim.id)

    // 情形二：视角里没有该座位手牌 = 如实记缺失，不写假检查点
    recorder.windowOpened({
      windowId: 'w2', seat: 2, windowKind: 'claim', roundIndex: 2, authorityEpoch: 'e1', stateVersion: 5,
      state: { id: 'claim-state-2' },
    })
    recorder.candidates({ windowId: 'w2', seat: 2, legalActions: [{ id: 'w2/0', kind: 'pass' }], candidates: [] })
    recorder.chosen({ windowId: 'w2', seat: 2, legalActionId: 'w2/0', source: 'human' })
    await recorder.flush()
    const after = await readParts(storage, 'decision') as AnalysisDecision[]
    const blind = after.filter(item => item.windowId === 'w2').at(-1)!
    expect(blind.source).toBe('human')
    // 没有第二份检查点（看不见就不写），且完整性降为 partial
    expect(await readParts(storage, 'responderCheckpoint')).toHaveLength(1)
    expect(await recorder.finish()).toMatchObject({ status: 'partial' })
  })

  it('非响应窗口不写检查点（摸牌回合的手牌本来就是前态本身）', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    recorder.windowOpened({
      windowId: 'w1', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1,
      state: { id: 'turn-state', hand: ['m1', 'm2'], drawnTileIndex: 1 },
    })
    await recorder.flush()
    const states = await readParts(storage, 'decisionState') as AnalysisDecisionState[]
    expect(states[0].hand).toEqual(['m1', 'm2'])
    const finished = await recorder.finish()
    expect(finished.status).toBe('complete')
  })

  it('beginMatch 会登记配置引用（§9.4 的引用计数在生产路径上真正生效）', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    await new Promise(resolve => setTimeout(resolve, 0))
    const configs = await storage.readConfigs('m1') as Array<{ rulesVersion?: string }>
    expect(configs).toHaveLength(1)
    expect(configs[0].rulesVersion).toBe('lotus-blood-flow-v1')
  })

  it('并发 flush 串行化：不会出现序号冲突（真实浏览器实测过 sequence-occupied）', async () => {
    const { recorder, storage } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    recorder.windowOpened({ windowId: 'w1', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 's1' } })
    recorder.candidates({ windowId: 'w1', seat: 0, legalActions: legalActions(), candidates: [] })
    recorder.chosen({ windowId: 'w1', seat: 0, legalActionId: 'discard-3', source: 'human' })
    // 同一批数据触发多次并发写入（队列自动刷盘与场末收尾会这样撞在一起）
    await Promise.all([recorder.flush(), recorder.flush(), recorder.flush()])
    const read = await storage.read('m1')
    expect(read.parts.length).toBeGreaterThan(0)
    expect(recorder.paused(), '并发写入不得把录制暂停').toBe(false)
    expect(read.meta?.status).toBe('complete')
  })

  it('finish() 如实报告完整性：有缺失即 partial', async () => {
    const { recorder } = setup()
    recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    recorder.windowOpened({ windowId: 'w1', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 's1' } })
    const clean = await recorder.finish()
    expect(clean.status).toBe('complete')

    const second = setup()
    second.recorder.beginMatch({ ...matchInput, seatControl: [...matchInput.seatControl] })
    second.recorder.noteGap({ scope: 'round', from: 3, to: 4, reason: 'queue-overflow' })
    const partial = await second.recorder.finish()
    expect(partial.status).toBe('partial')
  })
})
