import { describe, expect, it } from 'vitest'
import { createBloodFlowDecisionSink, mapCandidatesToLegalActions, type DecisionAnalysisRecorder } from './decisionSink'
import { collapsedActionsOf } from '../../llm/bloodFlowDecisionInput'
import type { AnalysisCandidate, AnalysisLegalAction, AnalysisLlmOutcome, AnalysisMaybe } from './types'

// 决策运行时 → 分析记录的接缝（§3.3、§4、§9.5）：
// 候选与合法动作的 ID 对齐、真正发给模型的推荐、请求生命周期、来源、以及对不上的候选如实计数。

interface CandidateCall {
  windowId: string; seat: number
  legalActions: AnalysisLegalAction[]; candidates: AnalysisCandidate[]
  restricted?: Array<{ legalActionId: string; reason: string }>
  recommended?: AnalysisMaybe<{ legalActionId: string; note?: string }>
}

function fakeRecorder() {
  const calls = {
    candidates: [] as CandidateCall[],
    templates: [] as Array<{ id: string; content: unknown }>,
    started: [] as Array<{ decisionWindowId: string; seat: number; requestId: string; attempt: number; provider: string; requestModel: string }>,
    finished: [] as Array<{ attemptId: string; outcome: AnalysisLlmOutcome }>,
    sources: [] as Array<{ windowId: string; seat: number; source: string }>,
  }
  let serial = 0
  const recorder: DecisionAnalysisRecorder = {
    candidates: (input) => { calls.candidates.push(input) },
    promptTemplate: (input) => { calls.templates.push({ id: input.id, content: input.content }) },
    attemptStarted: (input) => { calls.started.push(input); return `attempt-${++serial}` },
    attemptFinished: (attemptId, input) => { calls.finished.push({ attemptId, outcome: input.outcome }) },
    source: (input) => { calls.sources.push(input) },
  }
  return { recorder, calls }
}

const legal = [
  { kind: 'win' },
  { kind: 'discard', tile: 'm5', index: 3 },
  { kind: 'pass' },
]

describe('决策接缝', () => {
  it('候选按动作内容对齐到窗口内稳定 ID；对不上的候选只计数不猜测', () => {
    const mapped = mapCandidatesToLegalActions('w1', legal, [
      { id: 'c-discard', action: { kind: 'discard', tile: 'm5', index: 3 } },
      { id: 'c-win', action: { kind: 'win' } },
      { id: 'c-ghost', action: { kind: 'peng', tile: 'p9', from: 2 } },   // 不在合法动作里
    ])
    expect(mapped.unmapped).toBe(1)
    expect(mapped.candidates.map((candidate) => candidate.legalActionId)).toEqual(['w1/1', 'w1/0'])
    expect(mapped.candidates[0].action).toMatchObject({ kind: 'discard', tile: 'm5', handIndex: 3 })
    // 顺序按候选给出（便于与运行时/模型回答对齐），ID 指回合法动作
    expect(mapped.candidates[1].action.kind).toBe('win')
  })

  it('候选、被限制动作、真正发给模型的推荐都会记下来', () => {
    const { recorder, calls } = fakeRecorder()
    const sink = createBloodFlowDecisionSink({ recorder })
    sink.candidates({
      windowId: 'w1', seat: 1, legalActions: legal,
      candidates: [
        { id: 'c-discard', action: { kind: 'discard', tile: 'm5', index: 3 }, label: '打五万' },
        { id: 'c-win', action: { kind: 'win' }, label: '胡' },
      ],
      restricted: [{ action: { kind: 'win' }, reason: 'route-narrowed' }],
      recommended: { candidateId: 'c-discard', note: 'EV 最高' },
    })
    expect(calls.candidates).toHaveLength(1)
    const call = calls.candidates[0]
    expect(call.candidates.map((candidate) => candidate.legalActionId)).toEqual(['w1/1', 'w1/0'])
    expect(call.restricted).toEqual([{ legalActionId: 'w1/0', reason: 'route-narrowed' }])
    expect(call.recommended).toEqual({ known: true, value: { legalActionId: 'w1/1', note: 'EV 最高' } })
    // 合法动作集本身也要带上（前态需要它）
    expect(call.legalActions.map((action) => action.id)).toEqual(['w1/0', 'w1/1', 'w1/2'])
  })

  it('请求生命周期：开始拿到 attemptId，结束带 outcome 与最终回答', () => {
    const { recorder, calls } = fakeRecorder()
    const sink = createBloodFlowDecisionSink({ recorder })
    const attemptId = sink.attemptStarted({
      windowId: 'w1', seat: 2, requestId: 'req-7', attempt: 1, provider: 'deepseek',
      requestModel: 'deepseek-chat', sampling: { temperature: 0.6 }, promptTemplateId: 'tpl-1',
    })
    expect(attemptId).toBe('attempt-1')
    expect(calls.started[0]).toMatchObject({ decisionWindowId: 'w1', seat: 2, requestId: 'req-7', attempt: 1 })
    sink.attemptFinished(attemptId, {
      outcome: 'success', responseModel: { known: true, value: 'deepseek-chat-0812' },
      answer: { known: true, value: { text: '打五万', candidateId: 'c-discard' } },
    })
    expect(calls.finished).toEqual([{ attemptId: 'attempt-1', outcome: 'success' }])
    // 未知 attemptId 不产生回执（迟到回答不得串到别的窗口，§10.2）
    sink.attemptFinished('attempt-unknown', { outcome: 'timeout' })
    expect(calls.finished).toHaveLength(1)
  })

  it('来源独立登记（供 chosen 覆盖 unknown），并且未启用时全部空转', () => {
    const { recorder, calls } = fakeRecorder()
    const sink = createBloodFlowDecisionSink({ recorder })
    sink.source({ windowId: 'w1', seat: 3, source: 'model-fallback' })
    expect(calls.sources).toEqual([{ windowId: 'w1', seat: 3, source: 'model-fallback' }])
    sink.candidates({ windowId: 'w1', seat: 3, legalActions: legal, candidates: [] })
    expect(calls.candidates).toHaveLength(1)   // 基线

    const disabled = createBloodFlowDecisionSink({ recorder, enabled: false })
    disabled.candidates({ windowId: 'w1', seat: 0, legalActions: legal, candidates: [] })
    expect(disabled.attemptStarted({ windowId: 'w1', seat: 0, requestId: 'r', attempt: 1, provider: 'p', requestModel: 'm', sampling: {} })).toBe('')
    disabled.attemptFinished('attempt-anything', { outcome: 'timeout' })
    disabled.source({ windowId: 'w1', seat: 0, source: 'model' })
    expect(calls.candidates).toHaveLength(1)   // 未启用 ⇒ 一次都没有新增
    expect(calls.sources).toHaveLength(1)
    expect(calls.finished).toHaveLength(0)
  })

  it('接缝自身抛错不冒泡到模型请求路径，只通知一次（§9.5）', () => {
    const errors: string[] = []
    const exploding: DecisionAnalysisRecorder = {
      candidates: () => { throw new Error('storage exploded') },
      promptTemplate: () => { throw new Error('storage exploded') },
      attemptStarted: () => { throw new Error('storage exploded') },
      attemptFinished: () => { throw new Error('storage exploded') },
      source: () => { throw new Error('storage exploded') },
    }
    const sink = createBloodFlowDecisionSink({ recorder: exploding, onError: (detail) => errors.push(detail) })
    expect(() => sink.candidates({ windowId: 'w1', seat: 0, legalActions: legal, candidates: [] })).not.toThrow()
    expect(() => sink.promptTemplate({ id: 'tpl', content: 'system' })).not.toThrow()
    expect(sink.attemptStarted({ windowId: 'w1', seat: 0, requestId: 'r', attempt: 1, provider: 'p', requestModel: 'm', sampling: {} })).toBe('')
    expect(() => sink.source({ windowId: 'w1', seat: 0, source: 'model' })).not.toThrow()
  })

  it('提示词模板经接缝登记（§4：模板去重存一次，决策只存变量）', () => {
    const { recorder, calls } = fakeRecorder()
    const sink = createBloodFlowDecisionSink({ recorder })
    sink.promptTemplate({ id: 'bloodFlow-decision/v1/稳健/plain', content: '系统提示正文' })
    expect(calls.templates).toEqual([{ id: 'bloodFlow-decision/v1/稳健/plain', content: '系统提示正文' }])
  })

  it('被收窄的动作清单（§3.3）能直接喂进接缝并被记录', () => {
    // 决策输入侧只回布尔，清单由前后差集得出（collapsedActionsOf）；这里验证它能落到 restricted 上
    const original = [
      { kind: 'win', tile: 'm5' },
      { kind: 'peng', tile: 'm5', from: 1 },
      { kind: 'discard', tile: 'm9', index: 4 },
      { kind: 'pass' },
    ]
    const collapsed = collapsedActionsOf(original, [original[2], original[3]], 'big-hand-route')
    expect(collapsed.map(entry => entry.action.kind)).toEqual(['win', 'peng'])
    expect(collapsed.every(entry => entry.reason === 'big-hand-route')).toBe(true)
    expect(collapsedActionsOf(original, original, 'big-hand-route')).toEqual([])   // 未收窄不得凭空产生

    const { recorder, calls } = fakeRecorder()
    const sink = createBloodFlowDecisionSink({ recorder })
    sink.candidates({
      windowId: 'w1', seat: 0,
      legalActions: original,                 // 合法动作仍是全集
      candidates: [{ id: 'c1', action: original[2] }],
      restricted: collapsed,
    })
    expect(calls.candidates[0].restricted).toEqual([
      { legalActionId: 'w1/0', reason: 'big-hand-route' },
      { legalActionId: 'w1/1', reason: 'big-hand-route' },
    ])
  })
})
