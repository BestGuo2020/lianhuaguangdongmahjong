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
/** 十三幺 / 字一色教科书牌河：只打中张，一张字牌与幺九都没打。 */
const THIRTEEN_ORPHANS_RIVER: TileType[] = ['m3', 'm4', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 'p6', 'p7', 's3', 's4']

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

  it('门清花色回避：整局几乎不打某花色 → 九莲/清一色嫌疑（tier 2），嫌疑花色更贵', () => {
    const opponent: OpponentPublicView = { discards: [...discards(6, 'm1'), 'p2', 'p3', 'white', 'east'], melds: [] }
    const profiles = opponentRiskProfiles({ wallCount: 60, opponents: [opponent] })
    expect(profiles[0].tier).toBe(2)
    expect(profiles[0].signals).toContain('牌河几乎未打条')
    expect(profiles[0].suspectSuit).toBe('s')
    const exposure = opponentPatternExposure(profiles, [])
    expect(exposure('s5')).toBe(160)   // 40 × 16 × 0.25
    expect(exposure('m5')).toBe(80)    // 非嫌疑花色 × 0.5
  })

  it('十三幺/字一色读牌：牌河零字牌幺九 → tier 3，字牌幺九照价 320、中张只要 80', () => {
    const opponent: OpponentPublicView = { discards: [...THIRTEEN_ORPHANS_RIVER], melds: [] }
    const profiles = opponentRiskProfiles({ wallCount: 30, opponents: [opponent] })
    expect(profiles[0].tier).toBe(3)
    expect(profiles[0].factor).toBe(OPPONENT_RISK.factorTier3)
    expect(profiles[0].avoidsHonorTerminals).toBe(true)
    expect(profiles[0].signals).toEqual(expect.arrayContaining(['牌河零字牌幺九', '牌河中张密集']))
    const exposure = opponentPatternExposure(profiles, [])
    expect(exposure('north')).toBe(320)   // 字牌：真实十六倍级硬胡点炮量级
    expect(exposure('east')).toBe(320)
    expect(exposure('m1')).toBe(320)      // 幺九
    expect(exposure('p5')).toBe(80)       // 中张：十三幺几乎不需要 → 损失最小化的落点
  })

  it('门清单花色零牌河 → tier 3（九莲/清一色量级）', () => {
    const river: TileType[] = ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'p2', 'p3', 'p4', 'p5', 'p6']
    const profiles = opponentRiskProfiles({ wallCount: 30, opponents: [{ discards: river, melds: [] }] })
    expect(profiles[0].tier).toBe(3)
    expect(profiles[0].signals).toContain('牌河未打条')
    expect(profiles[0].suspectSuit).toBe('s')
    expect(opponentPatternExposure(profiles, [])('s5')).toBe(320)
  })

  it('十三幺轴：手里两张字牌也不算安全（多现 ≠ 安全，保留下限）', () => {
    const profiles = opponentRiskProfiles({ wallCount: 30, opponents: [{ discards: [...THIRTEEN_ORPHANS_RIVER], melds: [] }] })
    const exposure = opponentPatternExposure(profiles, ['east', 'east'])
    expect(exposure('east')).toBe(128)   // 40 × 32 × 0.1（下限），不是 0
    expect(exposure('north')).toBe(320)
  })

  it('短牌河兜底：某花色只有 1 张仍给弱信号 tier1（不丢 v1 灵敏度）', () => {
    const river: TileType[] = ['m1', 'p9', 'm2', 'm3', 'p2', 'p3', 's2', 'east']
    const profiles = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: river, melds: [] }] })
    expect(profiles[0].tier).toBe(1)
    expect(profiles[0].signals).toContain('牌河少打条')
    expect(profiles[0].suspectSuit).toBe('s')
    const exposure = opponentPatternExposure(profiles, [])
    expect(exposure('s5')).toBe(40)   // 40 × 4 × 0.25（嫌疑花色）
    expect(exposure('m5')).toBe(20)   // 非嫌疑花色 ×0.5
  })

  it('门清短牌河不误判：长度不足只给弱信号，且不产生危险轴', () => {
    const profiles = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: ['m2', 'm3', 'm4'], melds: [] }] })
    expect(profiles[0].tier).toBe(0)
    expect(profiles[0].avoidsHonorTerminals).toBe(false)
  })

  it('七对嫌疑（牌河中张密集）只是弱信号 tier 1', () => {
    const river: TileType[] = ['m2', 'm3', 'm4', 'p3', 'p4', 'p5', 's3', 's4', 's5', 'east', 'south', 'north']
    const profiles = opponentRiskProfiles({ wallCount: 60, opponents: [{ discards: river, melds: [] }] })
    expect(profiles[0].signals).toContain('牌河中张密集')
    expect(profiles[0].tier).toBe(1)
    expect(profiles[0].avoidsHonorTerminals).toBe(false)
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
