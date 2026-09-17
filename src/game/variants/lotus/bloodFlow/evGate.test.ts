// ε-容忍约束（任务 ε，2026-09-17）单测：闸门判定必须"只读、可关、口径一致"。
import { expect, it } from 'vitest'
import type { Meld, TileType } from '../../../core/contracts/types'
import { BloodFlowEngine } from './engine'
import { bloodFlowSeatView, type BloodFlowSeatView } from './seatView'
import { seededRandom } from './simulation'
import { BLOOD_FLOW_AI } from './config'
import { bloodFlowAiActions } from './ai'
import { decideBloodFlowActionEv } from './ai'
import type { BloodFlowAction } from './state'
import type { SourceTileEvent, WinSource } from './types'
import {
  BLOOD_FLOW_EV_GATE_OFF, bloodFlowEvGateEnabled, evaluateEvGate, type BloodFlowEvGateConfig,
} from './evGate'
import { actionValue } from './evValue'

function view(overrides: {
  hand?: TileType[]; jokers?: TileType[]; melds?: Meld[]; wallCount?: number;
  drawnTileIndex?: number; locked?: boolean; ownActions?: BloodFlowAction[];
  ownScore?: { paymentPerPayer: number; source: WinSource } | null;
  windowKind?: 'turn' | 'win' | 'meld'; sourceKind?: SourceTileEvent['kind'];
} = {}): BloodFlowSeatView {
  const engine = new BloodFlowEngine({ authorityEpoch: 'ev-gate', roundId: '1', random: seededRandom(5), now: () => 0 })
  const v = bloodFlowSeatView(engine, 0)
  const hand = overrides.hand ?? ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north']
  v.players[0].hand = [...hand]
  v.players[0].melds = overrides.melds ?? []
  v.players[0].drawnTileIndex = overrides.drawnTileIndex ?? hand.length - 1
  v.players[0].discards = []
  v.jokers = overrides.jokers ?? ['white']
  v.wallCount = overrides.wallCount ?? 60
  v.ownScore = (overrides.ownScore ? { items: [], ...overrides.ownScore } : null) as unknown as BloodFlowSeatView['ownScore']
  v.ownActions = overrides.ownActions ?? [
    { kind: 'win' }, { kind: 'pass' },
    ...hand.map((_, index) => ({ kind: 'discard', index }) as const),
  ]
  v.window = {
    id: 'w', version: 1,
    kind: overrides.windowKind ?? 'turn',
    deadlineAt: 0, opensAt: 0,
    source: { id: 's', kind: overrides.sourceKind ?? 'draw', tile: hand[hand.length - 1], seat: 0 },
  }
  if (overrides.locked) {
    v.public = {
      ...v.public,
      seats: [{ ...v.public.seats[0], locked: true }, v.public.seats[1], v.public.seats[2], v.public.seats[3]],
    }
  }
  return v
}

/** 本地 EV 建议（`decideBloodFlowActionEv` 用的候选集 = `bloodFlowAiActions`）。 */
const offered = (v: BloodFlowSeatView) => bloodFlowAiActions(v, BLOOD_FLOW_AI)

/** 找一个"确实有决策自由度"（top-2 差 > 0）的真实局面：从真实对局里扫，
 *  比手搓一副牌更能代表闸门实际面对的分布。 */
function findChosenView() {
  for (let seed = 1; seed <= 30; seed += 1) {
    const engine = new BloodFlowEngine({
      authorityEpoch: 'ev-gate', roundId: `seed-${seed}`, random: seededRandom(seed), now: () => 0, winBeatMs: 0,
    })
    let steps = 0
    while (!engine.result && steps < 400) {
      steps += 1
      const window = engine.window!
      const seat = ([0, 1, 2, 3] as const).find(candidate => window.options[candidate].length && !window.decisions[candidate])!
      const v = bloodFlowSeatView(engine, seat)
      const actions = offered(v)
      if (actions.length >= 2) {
        const decision = evaluateEvGate(v, actions, BLOOD_FLOW_AI, BLOOD_FLOW_EV_GATE_OFF)
        if (decision.topTwoGap > 0) return { view: v, actions, decision }
      }
      const action = decideBloodFlowActionEv(v, BLOOD_FLOW_AI)
      if (!action) break
      engine.submit(engine.command(seat, action))
    }
  }
  throw new Error('没找到 top-2 差 > 0 的局面（真实对局分布变了？）')
}

const CHOSEN = findChosenView()

it('enabled=false 时闸门完全关闭：不跳过任何窗口（默认行为与既有版本一致）', () => {
  const v = view()
  const actions = offered(v)
  const decision = evaluateEvGate(v, actions, BLOOD_FLOW_AI, BLOOD_FLOW_EV_GATE_OFF)
  expect(bloodFlowEvGateEnabled(BLOOD_FLOW_EV_GATE_OFF)).toBe(false)
  expect(decision.skipModel).toBe(false)
  // 即便"本地完全等价"（gap=0）也不跳：关闭就是关闭，避免默认行为漂移。
  const degenerate: BloodFlowAction[] = [{ kind: 'pass' }, { kind: 'pass' }]
  expect(evaluateEvGate(v, degenerate, BLOOD_FLOW_AI, BLOOD_FLOW_EV_GATE_OFF).skipModel).toBe(false)
})

it('enabled=true + epsilon=0 是"只跳过本地完全等价窗口"的正式实验臂（不是关闭）', () => {
  const v = view()
  // 同一动作的两份副本价值完全相同 → gap = 0 → ε=0 也应跳过。
  const duplicate: BloodFlowAction[] = [{ kind: 'pass' }, { kind: 'pass' }]
  const zero: BloodFlowEvGateConfig = { enabled: true, epsilon: 0, mode: 'top-two' }
  expect(bloodFlowEvGateEnabled(zero)).toBe(true)
  const decision = evaluateEvGate(v, duplicate, BLOOD_FLOW_AI, zero)
  expect(decision.topTwoGap).toBe(0)
  expect(decision.spread).toBe(0)
  expect(decision.skipModel).toBe(true)
  // 而"有真实分歧"（gap > 0）的窗口在 ε=0 下不跳过。
  const chosen = evaluateEvGate(CHOSEN.view, CHOSEN.actions, BLOOD_FLOW_AI, zero)
  expect(chosen.topTwoGap).toBeGreaterThan(0)
  expect(chosen.skipModel).toBe(false)
})

it('价值向量与 actionValue 一致，并按降序给出 top-2 差与 spread', () => {
  const { view: v, actions } = CHOSEN
  const decision = evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon: 0, mode: 'top-two' })
  expect(decision.values.length).toBe(actions.length)
  for (let index = 1; index < decision.values.length; index += 1) {
    expect(decision.values[index - 1]).toBeGreaterThanOrEqual(decision.values[index])
  }
  const expected = actions.map(action => actionValue(v, action, BLOOD_FLOW_AI)).sort((a, b) => b - a)
  expect(decision.values).toEqual(expected)
  expect(decision.topTwoGap).toBeCloseTo(decision.values[0] - decision.values[1], 9)
  expect(decision.spread).toBeCloseTo(decision.values[0] - decision.values[decision.values.length - 1], 9)
  expect(decision.spread).toBeGreaterThanOrEqual(decision.topTwoGap)
})

it('gap ≤ ε 才跳过；ε 越大跳过越多（单调）', () => {
  const { view: v, actions, decision: reference } = CHOSEN
  const gap = reference.topTwoGap
  expect(gap).toBeGreaterThan(0)
  const expected = (epsilon: number) => gap <= epsilon
  const thresholds = [0, gap / 2, gap, gap * 10]
  const skips = thresholds.map(epsilon => evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon, mode: 'top-two' }).skipModel)
  // 判定必须严格是 "gap ≤ ε"：ε=0 且 gap>0 → 不跳；ε=gap → 跳；ε≫gap → 跳。
  expect(skips).toEqual(thresholds.map(expected))
  expect(skips[0]).toBe(false)
  expect(skips[1]).toBe(false)
  expect(skips[2]).toBe(true)
  expect(skips[3]).toBe(true)
})

it('本地完全等价（gap=0）的窗口在 ε=0 下也跳过（这正是"明显该打哪张不用问模型"的那一类）', () => {
  const v = view()
  // 同一动作的两份副本价值完全相同 → gap=0，任何 ε ≥ 0 都应跳过。
  const duplicate: BloodFlowAction[] = [{ kind: 'pass' }, { kind: 'pass' }]
  const zero = evaluateEvGate(v, duplicate, BLOOD_FLOW_AI, { enabled: true, epsilon: 0, mode: 'top-two' })
  expect(zero.topTwoGap).toBe(0)
  expect(zero.spread).toBe(0)
  expect(zero.skipModel).toBe(true)
  expect(evaluateEvGate(v, duplicate, BLOOD_FLOW_AI, { enabled: true, epsilon: 0.5, mode: 'top-two' }).skipModel).toBe(true)
  expect(evaluateEvGate(v, duplicate, BLOOD_FLOW_AI, { enabled: true, epsilon: 100, mode: 'spread' }).skipModel).toBe(true)
  // 但闸门关闭时（enabled=false）一个都不跳。
  expect(evaluateEvGate(v, duplicate, BLOOD_FLOW_AI, BLOOD_FLOW_EV_GATE_OFF).skipModel).toBe(false)
})

it('spread 口径的跳过集是 top-two 口径的子集（同样阈值下 spread 更保守）', () => {
  const { view: v, actions } = CHOSEN
  const topTwo = evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon: 0, mode: 'top-two' })
  const spread = evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon: 0, mode: 'spread' })
  expect(spread.spread).toBeGreaterThanOrEqual(topTwo.topTwoGap)
  expect(spread.gap).toBe(spread.spread)
  /**
   * 口径语义（容易搞反）：spread 的 gap 更大 ⇒ 达到"gap ≤ ε"更难 ⇒
   * 同一阈值下 **spread 跳过的是子集**（更保守）：
   *   · top-two 跳过"最优≈次优"的窗口（哪怕最差那张很亏）；
   *   · spread 额外要求"最差那张也不亏多少"，因此跳得更少。
   * 这点对实验选臂很重要：ε 相同时 spread 的调用次数**更高**。
   */
  for (const ratio of [0.25, 0.5, 1, 2, 4]) {
    const epsilon = Math.max(1e-9, topTwo.topTwoGap * ratio)
    const a = evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon, mode: 'top-two' }).skipModel
    const b = evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon, mode: 'spread' }).skipModel
    expect(Number(b)).toBeLessThanOrEqual(Number(a))
  }
  // 阈值足够大时两个口径都会跳过（ε ≥ spread 必然跳）。
  const big = spread.spread + 1
  expect(evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon: big, mode: 'top-two' }).skipModel).toBe(true)
  expect(evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon: big, mode: 'spread' }).skipModel).toBe(true)
})

it('候选 ≤ 1 个时不构成"跳过"（这种窗口本来就不调用模型）', () => {
  const v = view({ ownActions: [{ kind: 'pass' }] })
  const decision = evaluateEvGate(v, [{ kind: 'pass' }], BLOOD_FLOW_AI, { enabled: true, epsilon: 1000, mode: 'top-two' })
  expect(decision.values.length).toBe(1)
  expect(decision.topTwoGap).toBe(0)
  expect(decision.skipModel).toBe(false)
})

it('闸门是纯函数：反复求值不改变局面（只读）', () => {
  const { view: v, actions } = CHOSEN
  const before = JSON.stringify({ hand: v.players[0].hand, melds: v.players[0].melds, version: v.version })
  evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon: 5, mode: 'top-two' })
  evaluateEvGate(v, actions, BLOOD_FLOW_AI, { enabled: true, epsilon: 50, mode: 'spread' })
  const after = JSON.stringify({ hand: v.players[0].hand, melds: v.players[0].melds, version: v.version })
  expect(after).toBe(before)
})
