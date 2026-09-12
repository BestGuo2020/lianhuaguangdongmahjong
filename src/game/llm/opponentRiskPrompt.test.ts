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

function view(options: { opponentMelds?: Meld[]; winCount?: number; locked?: boolean } = {}): BloodFlowSeatView {
  const engine = new BloodFlowEngine({ authorityEpoch: 'risk-llm', roundId: '1', random: seededRandom(5), now: () => 0 })
  const seatView = bloodFlowSeatView(engine, 0)
  seatView.players[0].hand = [...HAND]
  seatView.players[0].drawnTileIndex = HAND.length - 1
  seatView.players[0].discards = []
  seatView.players[1].melds = options.opponentMelds ?? []
  seatView.players[1].discards = []
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
  expect(payload.ruleSummary).toContain('8~32倍')
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
