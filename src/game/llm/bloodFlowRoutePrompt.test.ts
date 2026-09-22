import { expect, it } from 'vitest'
import fixtures from './fixtures/bloodFlowRoutePrompt.json'
import { bloodFlowDecisionPrompt } from './bloodFlowRuntime'
import { BLOOD_FLOW_LLM_AI } from '../variants/lotus/bloodFlow/config'
import type { BloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import { bloodFlowRouteInstruction } from './bloodFlowRoutePrompt'

// 69b249d1's ten contradictory requests: only seat-visible state, no hidden wall or opponent hands.
it.each(fixtures)('describes retained actions consistently at $key without changing candidates or recommendation', fixture => {
  const view = structuredClone(fixture.view) as unknown as BloodFlowSeatView
  const before = structuredClone(view)
  expect(view.players.filter(p => p.seat !== view.seat).every(p => !p.hand.length)).toBe(true)
  const prompt = bloodFlowDecisionPrompt(view, [], fixture.key, undefined, {}, '稳健', BLOOD_FLOW_LLM_AI)
  expect(prompt.candidates.map(c => c.label)).toEqual(fixture.expectedLabels)
  expect(prompt.request.engineSuggestion).toBe(fixture.expectedSuggestion)
  const data = JSON.parse(prompt.messages.user)
  expect(prompt.templateId).toContain('bloodFlow-decision/v2/')
  expect(data.ruleSummary).not.toContain('候选里不会出现')
  expect(data.ruleSummary).not.toContain('引擎已决定放弃小胡')
  expect(data.ruleSummary).not.toContain('这条十六至三十二倍级牌型')
  if (prompt.candidates.some(c => c.action.kind === 'win')) expect(data.ruleSummary).toContain('胡牌仍可选择')
  expect(data.candidates.some((c: { id: string }) => c.id === data.engineSuggestion)).toBe(true)
  expect(view).toEqual(before)
})

it('distinguishes partial removal of a type from removing every candidate of that type', () => {
  const summary = bloodFlowRouteInstruction({ collapsedByRoute: true, bigHandRoute: { label: '混一色' },
    candidates: [{ id: 'A0', action: { kind: 'chi', tiles: ['m1', 'm2', 'm3'] } }, { id: 'A1', action: { kind: 'pass' } }],
    collapsedActions: [{ action: { kind: 'chi', tiles: ['p1', 'p2', 'p3'] } }, { action: { kind: 'win' } }],
    request: { engineSuggestion: 'A0' } })
  expect(summary).toContain('当前保留的动作类型：吃、过')
  expect(summary).toContain('吃1个')
  expect(summary).toContain('本次路线筛选已移除胡牌候选')
  expect(summary).not.toContain('胡牌仍可选择')
  expect(summary).toContain('本地推荐是A0（吃）')
})

it('does not invent removals, recommendations or constraints when none exist', () => {
  const input = { collapsedByRoute: true, bigHandRoute: { label: '碰碰胡' },
    candidates: [{ id: 'A0', action: { kind: 'pass' as const } }], collapsedActions: [], request: { engineSuggestion: 'missing' } }
  const summary = bloodFlowRouteInstruction(input)
  expect(summary).toContain('本窗口没有因路线筛选移除候选')
  expect(summary).not.toContain('本地推荐是')
  expect(summary).not.toContain('已移除胡牌')
  expect(bloodFlowRouteInstruction({ ...input, collapsedByRoute: false })).toBe('')
})
