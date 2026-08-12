// 「莲花麻将」AI 决策层（纯函数）：看手牌/局面 → 给出动作命令，不改任何状态。
// 决策与执行分离，可独立单元测试。
import type { Meld, TileType } from '../../core/contracts/types'
import { removeMatches } from '../../core/rules/actions'
import { canPeng, concealedKongs, isWinningHand, matchingCount, windKong, type ChiMeld } from './lotusRules'

export type LotusTurnDecision =
  | { kind: 'win' }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'wind-kong' }
  | { kind: 'discard'; handIndex: number }

export type LotusClaimAction =
  | { kind: 'gang' }
  | { kind: 'peng'; discardIndex?: number }
  | { kind: 'chi'; meld: ChiMeld }
  | { kind: 'pass' }

export type LotusRobKongAction = 'win' | 'pass'

export interface LotusTurnView {
  hand: TileType[]
  melds: Meld[]
  exposedMelds: number
  kongBloom: boolean
  jokers: TileType[]
}

export interface LotusClaimView {
  hand: TileType[]
  tile: TileType
  from: number
  /** 手牌中是否已有 3 张可直杠（由回合层预计算） */
  canGang: boolean
  chiOptions: ChiMeld[]
  jokers: TileType[]
}

export interface LotusRobKongView {
  hand: TileType[]
  exposedMelds: number
  tile: TileType
  from: number
  jokers: TileType[]
}

/** 回合决策：自摸胡 → 补杠 → 暗杠 → 乱风杠 → 弃牌。 */
export function decideTurn(view: LotusTurnView): LotusTurnDecision {
  if (isWinningHand(view.hand, view.exposedMelds, view.jokers)) return { kind: 'win' }

  const meldIndex = view.melds.findIndex(
    (meld) => meld.type === 'peng'
      && view.hand.includes(meld.tile),
  )
  if (meldIndex >= 0) return { kind: 'added-kong', meldIndex }

  const kong = concealedKongs(view.hand, view.jokers)[0]
  if (kong) return { kind: 'concealed-kong', tile: kong }

  if (windKong(view.hand, view.jokers)) return { kind: 'wind-kong' }

  return { kind: 'discard', handIndex: chooseDiscardIndex(view.hand, view.jokers) }
}

/** 面对弃牌：能杠必杠 → 能碰必碰 → 能吃则吃 → 过。 */
export function decideClaim(view: LotusClaimView): LotusClaimAction {
  if (view.canGang) return { kind: 'gang' }
  if (canPeng(view.hand, view.tile, view.jokers)) {
    const afterPeng = removeMatches(view.hand, view.tile, 2)
    if (!afterPeng.length) return { kind: 'pass' }
    return { kind: 'peng', discardIndex: chooseDiscardIndex(afterPeng, view.jokers) }
  }
  if (view.chiOptions.length) return { kind: 'chi', meld: view.chiOptions[0] }
  return { kind: 'pass' }
}

/** 面对加杠：能抢必抢。 */
export function decideRobKong(_view: LotusRobKongView): LotusRobKongAction {
  return 'win'
}

/**
 * 弃牌启发式：优先打出孤张/字牌；精牌作为普通牌参与出牌评分。
 * 评分越低越先打：同牌多 +4、有相邻靠张 +2、字牌 +6。
 */
export function chooseDiscardIndex(hand: TileType[], _jokers: TileType[], random: () => number = Math.random): number {
  const scored = hand.map((tile, index) => {
    const same = matchingCount(hand, tile) - 1
    const suited = /^([mps])([1-9])$/.exec(tile)
    let neighbors = 0
    if (suited) {
      const rank = Number(suited[2])
      neighbors += hand.includes(`${suited[1]}${rank - 1}` as TileType) ? 1 : 0
      neighbors += hand.includes(`${suited[1]}${rank + 1}` as TileType) ? 1 : 0
    }
    const honor = suited ? 0 : 6
    return { index, score: same * 4 + neighbors * 2 + honor + random() }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored[0]?.index ?? 0
}
