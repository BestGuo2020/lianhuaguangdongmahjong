import { decideTurn, decideClaim, lotusDiscardCandidates, chooseFallbackDiscardIndex } from '../lotusAi'
import { canChi } from '../lotusRules'
import type { BloodFlowAction } from './state'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'

/** Only adapt blood-flow legal/locked actions. Tile strategy belongs to lotusAi. */
export function bloodFlowAiActions(view: BloodFlowSeatView): readonly BloodFlowAction[] {
  if (view.public.seats[view.seat].locked) return view.ownActions
  const indices = view.ownActions.filter(a => a.kind === 'discard').map(a => a.index)
  const allowed = new Set(lotusDiscardCandidates(view.players[view.seat].hand, view.jokers, indices).map(c => c.index))
  return view.ownActions.filter(a => a.kind !== 'discard' || allowed.has(a.index))
}

export function decideBloodFlowAction(view: BloodFlowSeatView, minimumFirstPayment = 0): BloodFlowAction | null {
  const player = view.players[view.seat]
  const moves = bloodFlowAiActions(view)
  if (!moves.length) return null
  if (moves.length === 1) return moves[0]
  const locked = view.public.seats[view.seat].locked
  const win = moves.find(a => a.kind === 'win')
  if (win) return locked || (view.ownScore?.paymentPerPayer ?? 0) >= minimumFirstPayment
    ? win : moves.find(a => a.kind === 'pass')!
  const context = { hand: player.hand, jokers: view.jokers, exposedMelds: player.melds.length,
    visibleTiles: visibleTiles(view), wallCount: view.wallCount,
    upperLastDiscard: view.players[(view.seat + 3) % 4]?.discards.at(-1), earlyRound: player.discards.length < 2,
    publicTiles: [view.flipTile, ...view.players.flatMap(p => [...p.discards, ...p.melds.flatMap(m => m.tiles)]),
      ...view.public.batches.map(b => b.source.tile)],
  }
  const offered = (action: BloodFlowAction) => moves.find(a => JSON.stringify(a) === JSON.stringify(action))
  const discards = moves.filter(a => a.kind === 'discard')
  const fallback = () => {
    const index = chooseFallbackDiscardIndex(player.hand, view.jokers, discards.map(d => d.index))
    return discards.find(a => a.index === index) ?? null
  }
  if (discards.length) {
    if (locked) return discards[0]
    try {
      const decision = decideTurn({ ...context, melds: player.melds, kongBloom: false }, () => 0)
      const action: BloodFlowAction = decision.kind === 'discard' ? { kind: 'discard', index: decision.handIndex } : decision
      return offered(action) ?? fallback()
    } catch { return fallback() }
  }
  const pass = moves.find(a => a.kind === 'pass') ?? null
  if (view.window?.kind !== 'meld') return pass
  try {
    const source = view.window.source
    const decision = decideClaim({ ...context, tile: source.tile, from: source.seat,
      canGang: moves.some(a => a.kind === 'gang'), canPeng: moves.some(a => a.kind === 'peng'),
      chiOptions: canChi(player.hand, source.tile, view.jokers).filter(m => offered({ kind: 'chi', tiles: m.tiles })),
    })
    return offered(decision.kind === 'chi' ? { kind: 'chi', tiles: decision.meld.tiles }
      : decision.kind === 'peng' ? { kind: 'peng' } : decision) ?? pass
  } catch { return pass }
}
