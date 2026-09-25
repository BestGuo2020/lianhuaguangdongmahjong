import type { TileType } from '../core/contracts/types'
import { waitingTiles, type ChiMeld } from '../variants/lotus/lotusRules'

interface ChiGuardInput {
  hand: TileType[]
  exposedMelds: number
  claimedTile: TileType
  chiOptions: ChiMeld[]
  jokers: TileType[]
}

/**
 * 只拦已经听牌时确定不会增加听口的吃。吃没有即时得分，还会跳过本次摸牌；
 * 若吃后无论打哪张都没有新增可胡牌面，就没有手牌进展。
 * 未听牌的向听/进张估值、精牌参与的吃法留给模型，避免近似估值误拦。
 */
export function keepUsefulLotusChiOptions(input: ChiGuardInput): ChiMeld[] {
  if (!input.chiOptions.length) return input.chiOptions
  const baseline = waitingTiles(input.hand, input.exposedMelds, input.jokers)
  if (!baseline.length) return input.chiOptions
  const baselineWaits = new Set(baseline)

  return input.chiOptions.filter((meld) => {
    if (meld.tiles.some((tile) => input.jokers.includes(tile) || tile === 'white')) return true

    const afterChi = [...input.hand]
    let usedClaimedTile = false
    for (const tile of meld.tiles) {
      if (tile === input.claimedTile && !usedClaimedTile) {
        usedClaimedTile = true
        continue
      }
      const index = afterChi.indexOf(tile)
      if (index < 0) return true // 防御性处理：不确定的组合交回原有合法性校验
      afterChi.splice(index, 1)
    }
    if (!usedClaimedTile || !afterChi.length) return true

    // 吃完必须再弃一张；只要存在一种弃法能拓宽听口，就保留该吃法。
    const checked = new Set<TileType>()
    for (const tile of afterChi) {
      if (checked.has(tile)) continue
      checked.add(tile)
      const afterDiscard = [...afterChi]
      afterDiscard.splice(afterDiscard.indexOf(tile), 1)
      const waits = waitingTiles(afterDiscard, input.exposedMelds + 1, input.jokers)
      if (waits.some((wait) => !baselineWaits.has(wait))) return true
    }
    return false
  })
}
