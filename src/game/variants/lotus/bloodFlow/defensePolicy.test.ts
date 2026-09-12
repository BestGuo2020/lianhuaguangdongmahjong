// 兜/弃政策（v3）单元测试：规则来自用户定稿的两条兜牌法 + 一条"我方更大就赌"。
import { describe, expect, it } from 'vitest'
import {
  BLOOD_FLOW_DEFENSE, decideDefensePolicy, multiplierOfTier, ownHandFacts, type OpponentThreatFacts,
} from './defensePolicy'
import type { TileType } from '../../../core/contracts/types'

const threat = (over: Partial<OpponentThreatFacts> = {}): OpponentThreatFacts => ({
  tier: 3, locked: true, knownMultiplier: 16, signals: ['已胡十三幺', '已胡3次仍听'], ...over,
})

const own = (over: Partial<Parameters<typeof decideDefensePolicy>[0]['own']> = {}) => ({
  canTenpai: false, bestWaitRemaining: 0, anyWaitReachable: false, ceilingMultiplier: 1, ceilingLabel: null, ...over,
})

describe('兜/弃政策', () => {
  it('规则①：打一张即精吊任意听 → 继续走（哪怕对上是十六倍级）', () => {
    const result = decideDefensePolicy({ own: own({ anyWaitReachable: true, canTenpai: true }), opponents: [threat()] })
    expect(result.mode).toBe('push')
    expect(result.reasons[0]).toContain('任意听')
  })

  it('规则③：我方上限不低于对手 → 可以赌', () => {
    const result = decideDefensePolicy({
      own: own({ ceilingMultiplier: 16, ceilingLabel: '九莲宝灯' }),
      opponents: [threat()],
    })
    expect(result.mode).toBe('push')
    expect(result.reasons[0]).toContain('可以赌')
  })

  it('规则②：未听牌（打任何一张都听不上）+ 对手十六倍级 → 弃胡兜安全张', () => {
    const result = decideDefensePolicy({ own: own({ canTenpai: false }), opponents: [threat()] })
    expect(result.mode).toBe('fold')
    expect(result.reasons.join()).toContain('弃胡')
  })

  it('能听牌就不弃胡（窄听也一样）：遵守"未听牌才弃"的前提', () => {
    const result = decideDefensePolicy({ own: own({ canTenpai: true, bestWaitRemaining: 1 }), opponents: [threat()] })
    expect(result.mode).toBe('normal')
  })

  it('威胁不到门槛（tier 1/2）不兜：不因为对手胡过就乱防', () => {
    const weak = decideDefensePolicy({ own: own(), opponents: [threat({ tier: 2, knownMultiplier: 4, signals: ['副露染手嫌疑'] })] })
    expect(weak.mode).toBe('normal')
    expect(BLOOD_FLOW_DEFENSE.foldThreatTier).toBe(3)
  })

  it('没有对手威胁时永远是 normal', () => {
    expect(decideDefensePolicy({ own: own(), opponents: [] }).mode).toBe('normal')
  })

  it('ownHandFacts：4 面子 + 单张精 → 打一张即任意听可及', () => {
    const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p1', 'p1', 's7', 'white']
    const facts = ownHandFacts(hand, [], ['white'], hand, {})
    expect(facts.anyWaitReachable).toBe(true)
    expect(facts.canTenpai).toBe(true)
  })

  it('ownHandFacts：单骑听牌 → 可达听口只有 1 种、任意听不可及', () => {
    const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p1', 'p1', 's7', 's9']
    const facts = ownHandFacts(hand, [], [], hand, {})
    expect(facts.anyWaitReachable).toBe(false)
    expect(facts.canTenpai).toBe(true)              // 打掉 s9 就是单骑听牌
    expect(facts.bestWaitRemaining).toBeLessThanOrEqual(4)
  })

  it('ownHandFacts：散手（打任何一张都听不上）→ canTenpai=false', () => {
    const hand: TileType[] = ['m1', 'm1', 'm4', 'm4', 'm7', 'm7', 'p2', 'p2', 'p5', 'p8', 's3', 's9', 'east', 'red']
    const facts = ownHandFacts(hand, [], [], hand, {})
    expect(facts.canTenpai).toBe(false)
    expect(facts.bestWaitRemaining).toBe(0)
  })

  it('ownHandFacts：上限取"真有机会做成"的番型方向（接近度门槛生效）', () => {
    const hand: TileType[] = ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north', 'red']
    const facts = ownHandFacts(hand, [], [], hand, {
      directions: [{ weight: 16, progress: 0.4, label: '十三幺' }, { weight: 2, progress: 0.9, label: '七对' }],
    })
    expect(facts.ceilingMultiplier).toBe(16)   // 接近度 0.4 ≥ 0.35
    expect(facts.ceilingLabel).toBe('十三幺')
    const conservative = ownHandFacts(hand, [], [], hand, {
      directions: [{ weight: 16, progress: 0.2, label: '十三幺' }, { weight: 2, progress: 0.9, label: '七对' }],
    })
    expect(conservative.ceilingMultiplier).toBe(2)
  })

  it('档位 → 倍率映射与 opponentPatternRisk 的 ×1/4/16/32 对齐', () => {
    expect([0, 1, 2, 3].map(multiplierOfTier)).toEqual([1, 4, 8, 16])
  })
})
