// 血流 LLM prompt 接线：局面带对手风险档、候选带风险赔付、规则摘要补上赔付口径。
import { expect, it } from 'vitest'
import type { Meld, TileType } from '../core/contracts/types'
import { BloodFlowEngine } from '../variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import type { BloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import { seededRandom } from '../variants/lotus/bloodFlow/simulation'
import { bloodFlowDecisionPrompt } from './bloodFlowRuntime'

const peng = (tile: TileType): Meld => ({ type: 'peng', tile, from: 0, tiles: [tile, tile, tile] })
const HAND: TileType[] = ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north']

function view(options: { opponentMelds?: Meld[]; opponentDiscards?: TileType[]; winCount?: number; locked?: boolean } = {}): BloodFlowSeatView {
  const engine = new BloodFlowEngine({ authorityEpoch: 'risk-llm', roundId: '1', random: seededRandom(5), now: () => 0 })
  const seatView = bloodFlowSeatView(engine, 0)
  seatView.players[0].hand = [...HAND]
  seatView.players[0].drawnTileIndex = HAND.length - 1
  seatView.players[0].discards = []
  seatView.players[1].melds = options.opponentMelds ?? []
  seatView.players[1].discards = options.opponentDiscards ?? []
  seatView.jokers = ['white']
  seatView.wallCount = 60
  seatView.ownActions = [{ kind: 'pass' }, ...HAND.map((_, index) => ({ kind: 'discard', index }) as const)]
  seatView.window = {
    id: 'w', version: 1, kind: 'turn', deadlineAt: 0, opensAt: 0,
    source: { id: 's', kind: 'draw', tile: HAND[HAND.length - 1], seat: 0 },
  }
  const seats = seatView.public.seats
  seatView.public = {
    ...seatView.public,
    seats: [
      seats[0],
      { ...seats[1], winCount: options.winCount ?? 0, locked: options.locked ?? false },
      seats[2],
      seats[3],
    ],
  }
  return seatView
}

const paymentOf = (payload: { candidates: Array<{ label: string; features: { opponentRisk?: { payment: number } } }> }, label: string) =>
  payload.candidates.find(candidate => candidate.label === label)?.features.opponentRisk?.payment ?? null

it('局面与候选都带上对手风险档，规则摘要写明赔付口径', () => {
  const prompt = bloodFlowDecisionPrompt(view({ opponentMelds: [peng('p4'), peng('p7')] }), [], 'risk')
  const payload = JSON.parse(prompt.messages.user)
  expect(payload.ruleSummary).toContain('点炮赔付')
  // 2026-09-15 番表变更后鸡胡降到 0.5 番（支付减半），"大牌 vs 鸡胡"的倍数区间随之上移。
  expect(payload.ruleSummary).toContain('16~64倍')
  // 新的门清/平胡/鸡胡语义必须在规则摘要里写明，否则模型会按旧口径算番。
  expect(payload.ruleSummary).toContain('门清（1番')
  expect(payload.ruleSummary).toContain('平胡（1番')
  expect(payload.ruleSummary).toContain('鸡胡（0.5番、支付减半）')
  const risk = payload.opponentRisk.find((profile: { seat: number }) => profile.seat === 1)
  expect(risk).toMatchObject({ tier: 2, signals: expect.arrayContaining(['副露染手嫌疑']) })
  expect(paymentOf(payload, '打出二筒')).toBeGreaterThan(0)
  expect(paymentOf(payload, '打出二筒')!).toBeGreaterThan(paymentOf(payload, '打出一万')!)
})

it('已锁手且已胡过的家：候选里现物不再便宜，且信号可读', () => {
  const prompt = bloodFlowDecisionPrompt(view({ opponentMelds: [peng('p4'), peng('p7')], winCount: 9, locked: true }), [], 'risk-locked')
  const payload = JSON.parse(prompt.messages.user)
  expect(payload.opponentRisk.find((profile: { seat: number }) => profile.seat === 1).signals).toContain('已胡9次仍听')
  expect(paymentOf(payload, '打出二筒')).toBe(paymentOf(payload, '打出一万'))
  expect(paymentOf(payload, '打出二筒')!).toBeGreaterThan(0)
})

it('对手没有大牌信号时不注入该字段（保持旧 prompt 形状）', () => {
  const prompt = bloodFlowDecisionPrompt(view(), [], 'quiet')
  const payload = JSON.parse(prompt.messages.user)
  expect(payload.opponentRisk).toEqual([])
  expect(payload.candidates.every((candidate: { features: { opponentRisk?: unknown } }) => candidate.features.opponentRisk === undefined)).toBe(true)
})

it('prompt 载荷带兜/弃政策与对手公开番型字段（v3）', () => {
  const river: TileType[] = ['m2', 'm3', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 'p6', 'p7', 's2', 's3']
  const prompt = bloodFlowDecisionPrompt(view({ opponentDiscards: river }), [], 'defense')
  const payload = JSON.parse(prompt.messages.user)
  expect(payload.ruleSummary).toContain('兜/弃政策')
  expect(payload.defense).toMatchObject({
    mode: expect.stringMatching(/^(push|fold|normal)$/),
    ownShanten: expect.any(Number),
    ownBestWait: expect.any(Number),
    ownAnyWaitReachable: expect.any(Boolean),
    ownCeiling: expect.any(Number),
  })
  expect(Array.isArray(payload.opponentPatterns)).toBe(true)
})

it('门清十三幺嫌疑也进 prompt：信号 + 赔付档 + 规则摘要里的读牌说明', () => {
  const river: TileType[] = ['m2', 'm3', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 'p6', 'p7', 's2', 's3']
  const prompt = bloodFlowDecisionPrompt(view({ opponentDiscards: river }), [], 'concealed')
  const payload = JSON.parse(prompt.messages.user)
  expect(payload.ruleSummary).toContain('整局不打字牌与幺九')
  const risk = payload.opponentRisk.find((profile: { seat: number }) => profile.seat === 1)
  expect(risk).toMatchObject({ tier: 3, signals: expect.arrayContaining(['牌河零字牌幺九']) })
  // 注意：prompt 载荷里的候选只有 id/label/features/summary（不含 action），所以按 features 取。
  const risky = payload.candidates.map((candidate: { features: { opponentRisk?: { payment: number } } }) =>
    candidate.features.opponentRisk?.payment ?? 0)
  // 该局面触发兜牌 → (c) 硬约束已在候选层撤掉高危张，因此可见的赔付档只剩安全档（0 点）。
  expect(payload.defense.restricted).toBe(true)
  expect(payload.defense.mode).toBe('fold')
  expect(Math.max(...risky)).toBe(0)
  expect(payload.candidates.some((candidate: { features: { opponentRisk?: unknown } }) => candidate.features.opponentRisk)).toBe(true)
})
