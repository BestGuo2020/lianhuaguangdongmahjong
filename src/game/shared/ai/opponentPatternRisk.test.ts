// 对手牌型风险（档位版）单元测试：只用公共信息，且无信号时必须与旧口径逐位一致。
import { describe, expect, it } from 'vitest'
import {
  maxOpponentRiskTier, opponentPatternExposure, opponentPatternFeature, opponentRiskProfiles,
  opponentThreatScore, OPPONENT_RISK, type OpponentPublicView,
} from './opponentPatternRisk'
import type { TileType } from '../../core/contracts/types'

const meld = (tile: TileType, type = 'peng') => ({ type, tile, tiles: [tile, tile, tile] as TileType[] })
const quiet: OpponentPublicView = { discards: [], melds: [] }
const discards = (count: number, tile: TileType): TileType[] => Array.from({ length: count }, () => tile)

describe('对手牌型风险档', () => {
  it('没有任何公共信号时 tier=0，赔付与旧口径（公开张数档位 × 40）逐位一致', () => {
    const profiles = opponentRiskProfiles({ wallCount: 60, opponents: [quiet, quiet, quiet] })
    expect(profiles.map(profile => profile.tier)).toEqual([0, 0, 0])
    expect(profiles.every(profile => profile.factor === 1 && profile.signals.length === 0)).toBe(true)
    const exposure = opponentPatternExposure(profiles, ['p3', 'p3', 's1'])
    expect(exposure('p3')).toBe(0)          // 公开 ≥2 张
    expect(exposure('s1')).toBe(4)          // 公开 1 张
    expect(exposure('m5')).toBe(10)         // 生张
  })

  it('空档位表（关闭开关）与旧口径完全一致', () => {
    const exposure = opponentPatternExposure([], ['p3', 'p3', 's1'])
    expect(exposure('p3')).toBe(0)
    expect(exposure('s1')).toBe(4)
    expect(exposure('m5')).toBe(10)
  })

  it('副露两组同花色 → 染手嫌疑（tier 2），嫌疑花色贵 2 倍，现物仍然安全', () => {
    const opponent: OpponentPublicView = { discards: ['m1', 'm2'], melds: [meld('p4'), meld('p7')] }
    const profiles = opponentRiskProfiles({ wallCount: 60, opponents: [opponent] })
    expect(profiles[0].tier).toBe(2)
    expect(profiles[0].signals).toContain('副露染手嫌疑')
    expect(profiles[0].suspectSuit).toBe('p')
    const exposure = opponentPatternExposure(profiles, [])
    expect(exposure('p3')).toBe(160)        // 40 × 16 × 0.25
    expect(exposure('m5')).toBe(80)         // 非嫌疑花色 × 0.5
    const safe = opponentPatternExposure(profiles, ['p3', 'p3'])
    expect(safe('p3')).toBe(0)              // 现物 / 公开 ≥2 张仍是 0
  })

  it('三副露 / 三元两组 / 三组箭牌 → 档位逐级提升到 3', () => {
    const threeMelds = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: [], melds: [meld('m2'), meld('p3'), meld('s4')] }] })
    expect(threeMelds[0].tier).toBe(2)
    expect(threeMelds[0].signals).toContain('副露3组')
    const twoDragons = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: [], melds: [meld('red'), meld('green')] }] })
    expect(twoDragons[0].tier).toBe(2)
    const threeDragons = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: [], melds: [meld('red'), meld('green'), meld('white')] }] })
    expect(threeDragons[0].tier).toBe(3)
    expect(threeDragons[0].factor).toBe(OPPONENT_RISK.factorTier3)
    const threeWinds = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: [], melds: [meld('east'), meld('south'), meld('west')] }] })
    expect(threeWinds[0].tier).toBe(3)
  })

  it('门清大牌无法识别，只用牌河弱信号（tier 1）', () => {
    const opponent: OpponentPublicView = { discards: [...discards(6, 'm1'), 'p2', 'p3', 'white', 'east'], melds: [] }
    const profiles = opponentRiskProfiles({ wallCount: 60, opponents: [opponent] })
    expect(profiles[0].tier).toBe(1)
    expect(profiles[0].signals.some(signal => signal.startsWith('牌河未见'))).toBe(true)
    expect(opponentPatternExposure(profiles, [])('s5')).toBe(40)  // 40 × 4 × 0.25
  })

  it('已锁手且已胡过的家：现物不再享受折扣', () => {
    const opponent: OpponentPublicView = { discards: ['m1'], melds: [meld('p4'), meld('p7')], winCount: 12, locked: true }
    const profiles = opponentRiskProfiles({ wallCount: 40, opponents: [opponent] })
    expect(profiles[0].tier).toBe(2)
    expect(profiles[0].locked).toBe(true)
    expect(profiles[0].signals).toContain('已胡12次仍听')
    const exposure = opponentPatternExposure(profiles, ['p4', 'p4'])
    expect(exposure('p4')).toBeGreaterThan(0)
    expect(exposure('p4')).toBe(exposure('m9'))
  })

  it('取权重最高的一家，而不是各家相加', () => {
    const flush: OpponentPublicView = { discards: [], melds: [meld('p4'), meld('p7')] }
    const profiles = opponentRiskProfiles({ wallCount: 60, opponents: [flush, flush, flush] })
    expect(maxOpponentRiskTier(profiles)).toBe(2)
    expect(opponentPatternExposure(profiles, [])('p3')).toBe(160)
  })

  it('只用公共信息：对手没有暗手字段也能出档位', () => {
    const opponent = { discards: ['m1', 'm2'], melds: [meld('s5'), meld('s8')] } as OpponentPublicView
    expect(opponentRiskProfiles({ wallCount: 60, opponents: [opponent] })[0].tier).toBe(2)
  })

  it('候选特征与深思威胁分', () => {
    const quietProfiles = opponentRiskProfiles({ wallCount: 60, opponents: [quiet] })
    expect(opponentPatternFeature(quietProfiles, [], 'm5')).toBeUndefined()
    const flushProfiles = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: [], melds: [meld('p4'), meld('p7')] }] })
    expect(opponentPatternFeature(flushProfiles, [], 'p3')).toEqual({ tier: '中', payment: 160, signals: ['副露染手嫌疑'] })
    expect(opponentPatternFeature(flushProfiles, [], 'm3')?.payment).toBe(80)
    expect(opponentThreatScore(quietProfiles, 60)).toBe(0)
    expect(opponentThreatScore(flushProfiles, 60)).toBe(70)
    expect(opponentThreatScore(flushProfiles, 20)).toBe(80)
    const dragons = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: [], melds: [meld('red'), meld('green'), meld('white')] }] })
    expect(opponentThreatScore(dragons, 60)).toBe(90)
  })
})
