// 广麻补杠 gate：残局 + 该牌完全未现 + 对手疑似大牌时不补杠（抢杠是广麻唯一的"放炮"）。
// 对手牌河/副露是唯一的输入，暗手不可见。
import { describe, expect, it } from 'vitest'
import { decideTurn } from './ai'
import type { AITurnView } from './ai'
import type { Meld, TileType } from '../contracts/types'
import { DEFAULT_RULESET } from '../rules/ruleset'

const peng = (tile: TileType): Meld => ({ type: 'peng', tile, from: 1, tiles: [tile, tile, tile] })
const flush = [peng('p4'), peng('p7')]
/** 均衡牌河：三种花色各打过 3 张 → 不产生"牌河未见某花色"弱信号。 */
const balanced: TileType[] = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3']
/** 门清染手弱信号：整局没打过筒子。 */
const missingPins: TileType[] = ['m1', 'm2', 'm3', 's1', 's2', 's3', 's4', 'east', 'east']

interface Options {
  opponentMelds?: Meld[]
  opponentDiscards?: TileType[]
  wallCount?: number
  publicTiles?: TileType[]
}

function view({ opponentMelds = [], opponentDiscards = balanced, wallCount = 12, publicTiles = [] }: Options = {}): AITurnView {
  return {
    hand: ['east', 'm1', 'm2'], melds: [peng('east')], exposedMelds: 1, kongBloom: false,
    playerIndex: 0, wallCount, publicTiles, ruleset: DEFAULT_RULESET,
    peers: [
      { discards: [], melds: [] },
      { discards: opponentDiscards, melds: opponentMelds },
      { discards: balanced, melds: [] },
      { discards: balanced, melds: [] },
    ],
  }
}

describe('广麻补杠的抢杠风险 gate', () => {
  it('残局 + 该牌未现 + 对手门清染手弱信号 → 不补杠（旧规则不会拦）', () => {
    expect(decideTurn(view({ opponentDiscards: missingPins })).kind).not.toBe('added-kong')
  })

  it('残局 + 该牌未现 + 对手副露染手 → 不补杠', () => {
    expect(decideTurn(view({ opponentMelds: flush })).kind).not.toBe('added-kong')
  })

  it('残局但对手没有任何大牌信号 → 照常补杠', () => {
    expect(decideTurn(view()).kind).toBe('added-kong')
  })

  it('该牌已在公开牌池出现（有人打过 / 已见）→ 照常补杠', () => {
    expect(decideTurn(view({ opponentDiscards: missingPins, publicTiles: ['east'] })).kind).toBe('added-kong')
  })

  it('早局（墙余充足）不受该 gate 影响', () => {
    expect(decideTurn(view({ opponentMelds: flush, wallCount: 60 })).kind).toBe('added-kong')
  })
})
