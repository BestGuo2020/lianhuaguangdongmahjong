// 共享的「牌面执行」层：用户与 AI 走同一套物理操作（移除手牌、组成副露、
// 消掉弃牌、结算分数、播报动画/音效），避免两处并行实现逐渐漂移。
// 决策（做什么）在 ai.ts，回合编排（谁继续、何时继续）留在 useGame，
// 这里只负责「把某个动作在牌桌上执行掉」。
import { applyKongScore, matchingCount } from './rules'
import type { GamePlayer, ScoreDelta, TableActionType, TileType } from '../contracts/types'
import { isLocalLlmSeat } from '../presentation/localLlmVoiceRegistry'

export function removeMatches(hand: TileType[], tile: TileType, amount: number): TileType[] {
  const next = [...hand]
  for (let count = 0; count < amount; count += 1) {
    const index = next.indexOf(tile)
    // 该牌不足 amount 张（或缺失）：停止移除，绝不 splice(-1) 误删手牌末张
    if (index < 0) break
    next.splice(index, 1)
  }
  return next
}

export function removeLastDiscard(discards: TileType[], tile: TileType): void {
  if (discards[discards.length - 1] === tile) discards.pop()
}

/** 执行层依赖的最小上下文：由 useGame 注入其可变状态与表现副作用。 */
export interface ActionContext {
  players: GamePlayer[]
  currentPlayer: { value: number }
  sortHand?: (hand: TileType[]) => TileType[]
  showTableAction: (type: TableActionType, actorIndex: number, sourceIndex: number | null, tile: TileType, meldIndex: number) => void
  showScoreFlow: (deltas: ScoreDelta[]) => void
  playSound: (name: string, volume?: number) => void
}

/**
 * 碰：拿掉弃牌、手牌移除 2 张、组成碰副露，轮到本家，播报动画与音效。
 * 后续回合（用户出牌 / AI 出牌）由调用方负责。
 */
export function performPeng(ctx: ActionContext, playerIndex: number, tile: TileType, from: number): void {
  const player = ctx.players[playerIndex]
  const source = ctx.players[from]
  if (!player || !source || matchingCount(player.hand, tile) < 2 || source.discards.at(-1) !== tile) return
  player.drawnTileIndex = -1
  removeLastDiscard(ctx.players[from].discards, tile)
  player.hand = removeMatches(player.hand, tile, 2)
  if (ctx.sortHand) player.hand = ctx.sortHand(player.hand)
  player.melds.push({ type: 'peng', tile, from, tiles: [tile, tile, tile] })
  ctx.currentPlayer.value = playerIndex
  ctx.showTableAction('peng', playerIndex, from, tile, player.melds.length - 1)
  if (!isLocalLlmSeat(playerIndex)) ctx.playSound('peng.mp3')
}

/**
 * 点杠（吃他家弃牌的杠）：拿掉弃牌、手牌移除 3 张、组成杠副露、
 * 结算杠分，轮到本家，播报动画与音效。后续补摸由调用方负责。
 */
export function performDiscardGang(ctx: ActionContext, playerIndex: number, tile: TileType, from: number): void {
  const player = ctx.players[playerIndex]
  const source = ctx.players[from]
  if (!player || !source || matchingCount(player.hand, tile) < 3 || source.discards.at(-1) !== tile) return
  player.drawnTileIndex = -1
  removeLastDiscard(ctx.players[from].discards, tile)
  player.hand = removeMatches(player.hand, tile, 3)
  if (ctx.sortHand) player.hand = ctx.sortHand(player.hand)
  player.melds.push({ type: 'gang', tile, from, tiles: [tile, tile, tile, tile] })
  const scoreDeltas = applyKongScore(ctx.players, playerIndex, 'discard', from)
  ctx.currentPlayer.value = playerIndex
  ctx.showTableAction('discard-gang', playerIndex, from, tile, player.melds.length - 1)
  ctx.showScoreFlow(scoreDeltas)
  if (!isLocalLlmSeat(playerIndex)) ctx.playSound('gang.mp3')
}
