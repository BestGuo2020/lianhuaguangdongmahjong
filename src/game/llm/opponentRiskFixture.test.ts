// 前后端 golden fixture：对手牌型风险定价的公共信息黄金输入。
// 同一份 JSON 必须被 TS（本文件）与 Python（backend/tests/test_opponent_pattern_risk.py）产出完全一致的结果。
import { describe, expect, it } from 'vitest'
import fixture from './fixtures/opponent-risk.json'
import {
  opponentPatternExposure, opponentPatternFeature, opponentRiskProfiles,
  type OpponentPublicView,
} from '../shared/ai/opponentPatternRisk'
import type { TileType } from '../core/contracts/types'

interface FixtureCase {
  id: string
  note: string
  wallCount: number
  visibleTiles: string[]
  opponents: Array<{ seat: number } & OpponentPublicView>
  expectedProfiles: Array<{ tier: number; factor: number; signals: string[]; suspectSuit: string | null; locked: boolean }>
  expectedExposure: Record<string, number>
  expectedFeature: Record<string, { tier: string; payment: number; signals: string[] } | null>
}

const cases = (fixture as { cases: FixtureCase[] }).cases

describe('对手风险定价 golden fixture（TS ↔ Python 同源）', () => {
  it.each(cases)('$id', (item) => {
    const profiles = opponentRiskProfiles({
      wallCount: item.wallCount,
      opponents: item.opponents.map((opponent) => ({
        discards: opponent.discards, melds: opponent.melds,
        winCount: opponent.winCount, locked: opponent.locked,
      })),
    })
    const summary = profiles.map((profile) => ({
      tier: profile.tier, factor: profile.factor, signals: [...profile.signals],
      suspectSuit: profile.suspectSuit, locked: profile.locked,
    }))
    expect(summary).toEqual(item.expectedProfiles)

    const visible = item.visibleTiles as TileType[]
    const exposure = opponentPatternExposure(profiles, visible)
    for (const [tile, expected] of Object.entries(item.expectedExposure)) {
      expect(exposure(tile as TileType), `${item.id} 赔付 ${tile}`).toBeCloseTo(expected, 6)
    }
    for (const [tile, expected] of Object.entries(item.expectedFeature)) {
      const actual = opponentPatternFeature(profiles, visible, tile as TileType)
      if (expected === null) expect(actual, `${item.id} 特征 ${tile}`).toBeUndefined()
      else expect(actual, `${item.id} 特征 ${tile}`).toEqual(expected)
    }
  })
})
