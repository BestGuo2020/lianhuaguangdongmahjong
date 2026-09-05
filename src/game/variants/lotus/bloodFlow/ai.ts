import { chooseDiscardIndex } from '../lotusAi'
import type { BloodFlowAction } from './state'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'

export function decideBloodFlowAction(view: BloodFlowSeatView, minimumFirstPayment = 0): BloodFlowAction | null {
  const moves = view.ownActions
  if (!moves.length) return null
  if (moves.length === 1) return moves[0]
  const locked = view.public.seats[view.seat].locked
  const win = moves.find(a => a.kind === 'win')
  if (win) return locked || (view.ownScore?.paymentPerPayer ?? 0) >= minimumFirstPayment
    ? win : moves.find(a => a.kind === 'pass')!
  const discards = moves.filter(a => a.kind === 'discard')
  if (discards.length) {
    if (locked) return discards[0]
    const player = view.players[view.seat]
    try {
      const index = chooseDiscardIndex(player.hand, view.jokers, () => 0, {
        exposedMelds: player.melds.length, visibleTiles: visibleTiles(view), wallCount: view.wallCount,
        publicTiles: [view.flipTile, ...view.players.flatMap(p => [...p.discards, ...p.melds.flatMap(m => m.tiles)]),
          ...view.public.batches.map(b => b.source.tile)],
      })
      return discards.find(a => a.index === index) ?? discards.at(-1)!
    } catch { return discards.at(-1)! }
  }
  return moves.find(a => a.kind === 'gang') ?? moves.find(a => a.kind === 'peng')
    ?? moves.find(a => a.kind === 'chi') ?? moves.find(a => a.kind === 'pass') ?? moves[0]
}
