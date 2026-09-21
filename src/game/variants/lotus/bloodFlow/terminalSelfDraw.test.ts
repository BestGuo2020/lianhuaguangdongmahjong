import { expect, it } from 'vitest'
import fixture from './terminalSelfDraw.fixture.json'
import type { BloodFlowSeatView } from './seatView'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from './config'
import { bloodFlowEvContext } from './evContext'
import { decideBloodFlowActionEv } from './ai'
import { computeReformHint } from './reformHint'
import { buildBloodFlowDecisionInput } from '../../../llm/bloodFlowDecisionInput'
import { bloodFlowDecisionPrompt } from '../../../llm/bloodFlowRuntime'

// e27b1ef3 / round-2/window/336 / seat 1; exported from exact replay.
// Seat projection only: no opponent concealed tiles or future wall.
const view = () => structuredClone(fixture) as unknown as BloodFlowSeatView

it('retains and recommends the actual final self-draw despite a committed route and score deficit', () => {
  const v = view(), before = structuredClone(v)
  expect(v.players.filter(p => p.seat !== v.seat).every(p => !p.hand.length)).toBe(true)
  expect(v.wallCount).toBe(0)
  expect(v.ownScore?.paymentPerPayer).toBe(10)
  for (const config of [BLOOD_FLOW_LLM_AI, { ...BLOOD_FLOW_AI, chainForecast: 'legacy' as const,
    routeOpportunityGuard: false, firstWinFloorLate: 100 }]) {
    const built = buildBloodFlowDecisionInput(v, 'last-draw', {}, config)
    const win = built.candidates.find(c => c.action.kind === 'win')!
    expect(win).toBeDefined()
    expect(built.collapsedByRoute).toBe(false)
    expect(built.collapsedActions.some(c => c.action.kind === 'win')).toBe(false)
    expect(built.request.engineSuggestion).toBe(win.id)
    expect(win.features.ev?.win).toMatchObject({ immediateTotal: 30, lockedChain: 0 })
    expect(win.features.ev?.win?.declinedReason).toBeUndefined()
    expect(win.features.risks).toContain('末张自摸：胡后本局结束，改张不再有后续摸牌收益')
    expect(decideBloodFlowActionEv(v, config)).toEqual({ kind: 'win' })
  }
  const payload = JSON.parse(bloodFlowDecisionPrompt(v, [], 'last-draw', undefined, {}, '稳健', BLOOD_FLOW_LLM_AI).messages.user)
  expect(payload.bigHandRoute?.committed ?? false).toBe(false)
  expect(payload.candidates.find((c: { id: string }) => c.id === payload.engineSuggestion).label).toContain('胡牌')
  expect(v).toEqual(before)
})

it('zeros future income in every forecast and in the actual LLM candidate features', () => {
  const v = view()
  for (const chainForecast of ['legacy', 'self-draw-v1', 'source-v2'] as const) {
    const ev = bloodFlowEvContext(v, { ...BLOOD_FLOW_AI, chainForecast })
    expect(ev.chainAfterWin).toBe(0)
    expect(ev.developEv).toBe(0)
    expect(ev.winEv).toBe(30)
    expect(ev.reformCandidates.length).toBeGreaterThan(0)
    expect(ev.reformCandidates.every(c => c.ev === 0)).toBe(true)
  }
  const built = buildBloodFlowDecisionInput(v, 'last-draw', {}, BLOOD_FLOW_LLM_AI)
  const reforms = built.candidates.flatMap(c => c.features.ev?.reform ? [c.features.ev.reform] : [])
  expect(reforms.some(c => c.anyWait)).toBe(true)
  expect(reforms.every(c => c.chain === 0)).toBe(true)
  expect(built.candidates.find(c => c.action.kind === 'pass')?.features.ev?.developEv).toBe(0)
  const player = v.players[v.seat]
  expect(computeReformHint({ hand: player.hand, drawnTileIndex: player.drawnTileIndex,
    wallCount: 0, visible: player.hand, ownScore: v.ownScore!,
    hints: { current: [], discards: [{ discard: 'm4', waits: [{ tile: 'p1',
      selfDraw: { ...v.ownScore!, paymentPerPayer: 1000 }, discard: { ...v.ownScore!, paymentPerPayer: 1000 } }] }] },
    config: BLOOD_FLOW_LLM_AI })).toBeNull()
})

it('does not broaden route release into positive-wall turns or final discard competition', () => {
  const v = view()
  const positive = buildBloodFlowDecisionInput({ ...v, wallCount: 1 }, 'one-left', {}, BLOOD_FLOW_LLM_AI)
  expect(positive.collapsedByRoute).toBe(true)
  expect(positive.candidates.some(c => c.action.kind === 'win')).toBe(false)
  expect(bloodFlowEvContext({ ...v, wallCount: 1 }, BLOOD_FLOW_LLM_AI).chainAfterWin).toBeGreaterThan(0)
  const claim = view()
  claim.window = { ...claim.window!, kind: 'win', source: { ...claim.window!.source, kind: 'discard', seat: 0 } }
  claim.players[claim.seat].drawnTileIndex = -1
  claim.ownActions = [{ kind: 'win' }, { kind: 'peng' }, { kind: 'pass' }]
  expect(buildBloodFlowDecisionInput(claim, 'last-claim', {}, BLOOD_FLOW_LLM_AI).candidates.some(c => c.action.kind === 'win')).toBe(false)
  const noWin = view()
  noWin.ownActions = noWin.ownActions.filter(a => a.kind !== 'win')
  noWin.ownScore = null
  expect(buildBloodFlowDecisionInput(noWin, 'no-win', {}, BLOOD_FLOW_LLM_AI).candidates.some(c => c.action.kind === 'win')).toBe(false)
})
