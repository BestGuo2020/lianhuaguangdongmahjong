// 「莲花麻将」结算：杠分与胡牌收付。杠分表与现行广麻相同（加杠 +3B / 明杠 +1B /
// 暗杠 +6B / 风杠 +6B，B=100），直接复用 rules.applyKongScore；胡牌按 lotusRules 的
// 收付表结算（未胡三家都要支付，庄家双倍）。
import type { GamePlayer } from '../core/contracts/types'
import { applyKongScore } from '../core/rules/rules'
import type { WinSettlement } from './lotusRules'

export { applyKongScore }

/**
 * 按收付表向未胡三家收款并计入赢家。
 * settlement 已按赢家身份（庄/闲、自摸/点炮）编码了庄支付额与非庄支付额，
 * 这里只需按 dealerIndex 识别庄家身份分别收款。
 */
export function applyWinScore(
  players: GamePlayer[],
  winnerIndex: number,
  settlement: WinSettlement,
  dealerIndex: number,
): number {
  let totalWon = 0
  players.forEach((player, index) => {
    if (index === winnerIndex) return
    const payment = index === dealerIndex ? settlement.dealerPays : settlement.nonDealerPays
    if (payment <= 0) return
    player.score -= payment
    totalWon += payment
  })
  players[winnerIndex].score += totalWon
  return totalWon
}
