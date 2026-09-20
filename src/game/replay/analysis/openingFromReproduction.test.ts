import { describe, expect, it } from 'vitest'
import { openingFromReproduction, tileFromName } from './openingFromReproduction'
import type { AnalysisReproduction } from './types'

// 复现数据 → 引擎 opening（§6、§10.6）：
// 字段齐了要能逐项还原；**缺任何一项都必须明确失败**，不许用默认值凑出另一个局面。

function fullRecord(): AnalysisReproduction {
  return {
    roundIndex: 1,
    available: true,
    initialWall: ['m1', 'm2', 'm3', 'p1', 's1', 'east', 'white'],
    initialHands: [
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 'p4', 's1'],
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 'p4'],
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 'p4'],
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 'p4'],
    ],
    dealer: 0,
    dealerDrawnIndex: 13,
    flipTiles: ['p9', 'white'],
    jokers: ['red', 'green'],
    flipStack: 3,
    flipSeat: 2,
    wallBreakIndex: 6,
  }
}

describe('复现数据还原成引擎开局', () => {
  it('牌名与牌型互认，未知牌名必须抛错而不是静默跳过', () => {
    expect(tileFromName('m5')).toBe('m5')
    expect(tileFromName('east')).toBe('east')
    expect(() => tileFromName('m9x')).toThrow(/未知牌名/)
  })

  it('字段齐全时逐项还原，headDrawn 由牌墙长度推出', () => {
    const result = openingFromReproduction(fullRecord())
    expect(result.reason).toBeNull()
    const opening = result.opening!
    expect(opening.wall).toEqual(['m1', 'm2', 'm3', 'p1', 's1', 'east', 'white'])
    expect(opening.headDrawn).toBe(134 - 7)
    expect(opening.flipTiles).toEqual(['p9', 'white'])
    expect(opening.jokers).toEqual(['red', 'green'])
    expect(opening.dealerDrawnIndex).toBe(13)
    expect(opening.flipStack).toBe(3)
    expect(opening.flipSeat).toBe(2)
    expect(opening.wallBreakIndex).toBe(6)
    // 四家手牌：庄家 14 张、其余 13 张；新开局没有副露/弃牌、摸牌下标为 -1
    expect(opening.players).toHaveLength(4)
    expect(opening.players[0].hand).toHaveLength(14)
    expect(opening.players[1].hand).toHaveLength(13)
    expect(opening.players.map(player => player.melds.length)).toEqual([0, 0, 0, 0])
    expect(opening.players.every(player => player.drawnTileIndex === -1)).toBe(true)
  })

  it('缺任一必需字段都必须明确失败（不许用默认值凑局面）', () => {
    const cases: Array<[string, (record: AnalysisReproduction) => void]> = [
      ['initialWall', record => { delete record.initialWall }],
      ['initialHands', record => { record.initialHands = [[], [], []] }],
      ['dealer', record => { delete record.dealer }],
      ['dealerDrawnIndex', record => { delete record.dealerDrawnIndex }],
      ['flipTiles', record => { record.flipTiles = ['p9'] }],
      ['jokers', record => { delete record.jokers }],
      ['flipStack', record => { delete record.flipStack }],
      ['flipSeat', record => { delete record.flipSeat }],
      ['wallBreakIndex', record => { delete record.wallBreakIndex }],
    ]
    for (const [label, mutate] of cases) {
      const record = fullRecord()
      mutate(record)
      const result = openingFromReproduction(record)
      expect(result.opening, `${label} 缺失时应失败`).toBeNull()
      expect(result.reason, `${label} 缺失时应说明缺什么`).toContain(label.split('(')[0])
    }
  })

  it('牌名非法时失败并说明原因，而不是给一个残缺开局', () => {
    const record = fullRecord()
    record.initialWall = ['m1', 'not-a-tile']
    const result = openingFromReproduction(record)
    expect(result.opening).toBeNull()
    expect(result.reason).toContain('未知牌名')
  })

  it('开局分数可用记录值或调用方给定值，不参与牌流', () => {
    const record = fullRecord()
    ;(record as { openingScores?: number[] }).openingScores = [2500, 2400, 2300, 2200]
    expect(openingFromReproduction(record).opening!.players.map(player => player.score))
      .toEqual([2500, 2400, 2300, 2200])
    expect(openingFromReproduction(record, { baseScores: [1, 2, 3, 4] }).opening!.players.map(player => player.score))
      .toEqual([1, 2, 3, 4])
  })
})
