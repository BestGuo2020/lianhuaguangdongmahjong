// 能大明杠时不给"碰"候选（方案 A）：
//  ① 血流候选层撤掉碰 → LLM 与本地 AI（能杠必杠）行为一致；
//  ② 只有 2 张时碰照常存在，不会误伤；
//  ③ 血流 LLM 载荷里也确实不再出现"碰"候选。
import { describe, expect, it } from 'vitest'
import { bloodFlowAiActions, decideBloodFlowActionEv } from './ai'
import { buildBloodFlowDecisionInput } from '../../../llm/bloodFlowDecisionInput'
import { BLOOD_FLOW_AI } from './config'
import type { BloodFlowSeatView } from './seatView'
import type { TileType } from '../../../core/contracts/types'

/** 手上三张 m5 + 别人打出 m5 → 能大明杠（碰完会剩一张 m5 要打掉）。 */
const THREE: TileType[] = ['m5', 'm5', 'm5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east']
/** 手上两张 m5 → 只能碰，没有杠。 */
const TWO: TileType[] = ['m5', 'm5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'north']

function claimView(hand: TileType[], ownActions: BloodFlowSeatView['ownActions']): BloodFlowSeatView {
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000, hand: index === 0 ? [...hand] : [], discards: [], melds: [], concealedTileCount: 13,
  }))
  return {
    seat: 0, wallCount: 40, flipTile: 'red', jokers: ['white'], version: 1, players,
    public: { seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false })), batches: [] },
    ownActions, actionEvents: [],
    window: { id: 'w', version: 1, kind: 'meld', deadlineAt: 0, opensAt: 0, source: { id: 's', kind: 'discard', tile: 'm5', seat: 3 } },
  } as unknown as BloodFlowSeatView
}

const KONG_OR_PENG: BloodFlowSeatView['ownActions'] = [{ kind: 'pass' }, { kind: 'gang' }, { kind: 'peng' }]

describe('能大明杠时不给碰候选', () => {
  it('手上三张：候选里只有直杠，没有碰（血流候选层）', () => {
    const moves = bloodFlowAiActions(claimView(THREE, KONG_OR_PENG), BLOOD_FLOW_AI)
    expect(moves.some(action => action.kind === 'gang')).toBe(true)
    expect(moves.some(action => action.kind === 'peng')).toBe(false)
  })

  it('本地 AI 仍然开杠（能杠必杠，行为不变）', () => {
    expect(decideBloodFlowActionEv(claimView(THREE, KONG_OR_PENG), BLOOD_FLOW_AI)).toEqual({ kind: 'gang' })
  })

  it('手上两张：只能碰 → 碰候选保留，不受这条约束影响', () => {
    const moves = bloodFlowAiActions(claimView(TWO, [{ kind: 'pass' }, { kind: 'peng' }]), BLOOD_FLOW_AI)
    expect(moves.some(action => action.kind === 'peng')).toBe(true)
  })

  it('血流 LLM 载荷里也不再有"碰"候选（这就是原来那个 bug 的入口）', () => {
    const built = buildBloodFlowDecisionInput(claimView(THREE, KONG_OR_PENG), 'kong-over-peng')
    const labels = built.candidates.map(candidate => candidate.label)
    expect(labels.some(label => label.includes('杠'))).toBe(true)
    expect(labels.some(label => label === '碰')).toBe(false)
  })
})
