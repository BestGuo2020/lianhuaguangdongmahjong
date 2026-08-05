// AI 玩家的纯决策层：只负责「看状态 → 给出动作命令」，不修改任何游戏状态、
// 不触发表现副作用，因此可以独立单元测试。动作的「执行」仍由 useGame 完成。
import { concealedKongs, isWinningHand, matchingCount } from './rules'
import type { GamePlayer, Meld, TileType } from './types'

/** AI 回合内的动作命令 */
export type TurnDecision =
  | { kind: 'win' }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'discard'; handIndex: number }

/** 面对他家弃牌时的响应 */
export type ClaimDecision = 'gang' | 'peng' | 'pass'

/** 面对加杠时的抢杠响应 */
export type RobKongDecision = 'win' | 'pass'

/** 抢杠决策输入（供未来风险权衡扩展） */
export interface RobKongView {
  hand: TileType[]
  exposedMelds: number
  tile: TileType
  from: number
}

/** 回合决策输入：只暴露 AI 决策需要的只读信息 */
export interface AITurnView {
  hand: TileType[]
  melds: Meld[]
  /** 公开副露数（structuralMeldCount），用于胡牌判断 */
  exposedMelds: number
  /** 是否从牌墙尾补摸（杠后），用于杠上开花判断 */
  kongBloom: boolean
}

/** 吃碰杠响应输入 */
export interface AIClaimView {
  hand: TileType[]
  /** 手牌中是否已凑齐 3 张可杠 */
  canGang: boolean
}

/**
 * 决策当前 AI 回合的动作，优先级与原 playAI 一致：
 * 自摸胡 → 补杠 → 暗杠 → 弃牌。
 */
export function decideTurn(view: AITurnView): TurnDecision {
  if (isWinningHand(view.hand, view.exposedMelds)) return { kind: 'win' }

  const meldIndex = view.melds.findIndex(
    (meld) => meld.type === 'peng' && view.hand.includes(meld.tile),
  )
  if (meldIndex >= 0) return { kind: 'added-kong', meldIndex }

  const kong = concealedKongs(view.hand)[0]
  if (kong) return { kind: 'concealed-kong', tile: kong }

  return { kind: 'discard', handIndex: chooseDiscardIndex(view.hand, Math.random) }
}

/** 面对弃牌：能杠必杠，否则能碰必碰（与原 aiClaim 行为一致）。 */
export function decideClaim(view: AIClaimView): ClaimDecision {
  if (view.canGang) return 'gang'
  return 'peng'
}

/** 面对加杠：当前 AI 能抢必抢；未来可按听牌风险权衡后返回 'pass'。 */
export function decideRobKong(_view: RobKongView): RobKongDecision {
  return 'win'
}

/**
 * 弃牌启发式：优先打掉「孤张」——同牌少、无相邻靠张的牌；
 * 白板（癞子）加罚分保手。random 注入以便测试确定化。
 */
export function chooseDiscardIndex(hand: TileType[], random: () => number = Math.random): number {
  const scored = hand.map((tile, index) => {
    const same = matchingCount(hand, tile) - 1
    const suitMatch = /^([mps])([1-9])$/.exec(tile)
    let neighbors = 0
    if (suitMatch) {
      const number = Number(suitMatch[2])
      neighbors += hand.includes(`${suitMatch[1]}${number - 1}` as TileType) ? 1 : 0
      neighbors += hand.includes(`${suitMatch[1]}${number + 1}` as TileType) ? 1 : 0
    }
    const penalty = tile === 'white' ? 10 : 0
    return { index, score: same * 4 + neighbors * 2 + penalty + random() }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored[0]?.index ?? 0
}

// 供 useGame 构造决策快照的辅助函数，避免各调用点重复拼装视图。
export function makeTurnView(player: GamePlayer, exposedMelds: number, kongBloom: boolean): AITurnView {
  return { hand: player.hand, melds: player.melds, exposedMelds, kongBloom }
}
