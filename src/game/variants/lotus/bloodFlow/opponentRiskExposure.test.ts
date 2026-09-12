// 血流接线测试：默认档位版生效，'off' 时与旧口径逐位一致。
import { describe, expect, it } from 'vitest'
import { bloodFlowOpponentRisk, bloodFlowSafetyExposure } from './ai'
import { BLOOD_FLOW_AI, type BloodFlowAiConfig } from './config'
import type { BloodFlowSeatView } from './seatView'
import type { TileType } from '../../../core/contracts/types'

const peng = (tile: TileType) => ({ type: 'peng', tile, tiles: [tile, tile, tile] as TileType[], from: 1 })

interface SeatSeed { discards?: TileType[]; melds?: ReturnType<typeof peng>[]; winCount?: number; locked?: boolean }

function view(opponent: SeatSeed = {}, wallCount = 40): BloodFlowSeatView {
  const seat = (index: number): SeatSeed => index === 1 ? opponent : {}
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000, hand: index === 0 ? ['s9'] : [], discards: seat(index).discards ?? [],
    melds: seat(index).melds ?? [], concealedTileCount: index === 0 ? 1 : 13,
  }))
  return {
    seat: 0, wallCount, flipTile: 'east', jokers: ['white'], version: 1,
    players, public: { seats: [0, 1, 2, 3].map(index => ({
      winCount: seat(index).winCount ?? 0, locked: seat(index).locked ?? false,
    })), batches: [] },
  } as unknown as BloodFlowSeatView
}

const off: BloodFlowAiConfig = { ...BLOOD_FLOW_AI, opponentPatternRisk: 'off' }

describe('血流对手牌型风险定价', () => {
  it("'off' 时与旧口径（公开张数档位 × 40）完全一致，且不产出风险档", () => {
    const seatView = view()
    expect(bloodFlowOpponentRisk(seatView, off)).toEqual([])
    const exposure = bloodFlowSafetyExposure(seatView, off)
    expect(exposure('m3')).toBe(10)   // 生张
    expect(exposure('east')).toBe(4)  // 翻精牌公开 1 张
    expect(exposure('s9')).toBe(4)    // 本家手上 1 张
  })

  it('默认档位版：对手副露两组同花色时，嫌疑花色生张显著变贵', () => {
    const quiet = bloodFlowSafetyExposure(view())
    const risky = bloodFlowSafetyExposure(view({ melds: [peng('p4'), peng('p7')] }))
    expect(quiet('p3')).toBe(10)
    expect(risky('p3')).toBe(160)     // 40 × 16 × 0.25
    expect(risky('m3')).toBe(80)      // 非嫌疑花色 × 0.5
    expect(bloodFlowOpponentRisk(view({ melds: [peng('p4'), peng('p7')] }))[0]).toMatchObject({
      seat: 1, tier: 2, signals: expect.arrayContaining(['副露染手嫌疑']),
    })
  })

  it('已锁手且已胡过的家：现物不再享受折扣', () => {
    const seatView = view({ melds: [peng('p4'), peng('p7')], winCount: 23, locked: true })
    const exposure = bloodFlowSafetyExposure(seatView, BLOOD_FLOW_AI, ['m3', 'm3'])
    expect(exposure('m3')).toBeGreaterThan(0)
    expect(exposure('m3')).toBe(exposure('p3'))
  })

  it('风险档只让"打出这一张"变贵，不改变胡牌/锁手的既有行为', () => {
    const exposure = bloodFlowSafetyExposure(view({ melds: [peng('p4'), peng('p7')] }))
    expect(exposure('p3')).toBe(160)
    expect(exposure('p3')).toBeGreaterThan(exposure('m3'))
  })
})
