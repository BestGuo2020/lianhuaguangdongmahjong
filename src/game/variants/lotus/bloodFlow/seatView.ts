import type { BloodFlowEngine } from './engine'
import type { Seat } from './types'
import { SEATS } from './state'

/** The only authority projection accepted by UI or decision code. No wall order,
 * bottom flip tile, opponent concealed hand or private decomposition leaves here. */
export function bloodFlowSeatView(engine: BloodFlowEngine, seat: Seat) {
  if (!SEATS.includes(seat)) throw new Error('Invalid viewer seat')
  const players = engine.players.map((p, s) => ({ ...structuredClone(p),
    hand: seat === s || engine.result ? [...p.hand] : [], concealedTileCount: p.hand.length }))
  const window = engine.window
  return {
    authorityEpoch: engine.options.authorityEpoch, roundId: engine.options.roundId, version: engine.version, seat,
    players, currentPlayer: engine.currentPlayer, wallCount: engine.wall.length, headDrawn: engine.headDrawn,
    flipTile: engine.flipTiles[0], jokers: [...engine.jokers], flipStack: engine.flipStack,
    flipSeat: engine.flipSeat, wallBreakIndex: engine.wallBreakIndex,
    window: window ? { id: window.id, version: window.version, kind: window.kind, deadlineAt: window.deadlineAt, source: { ...window.source } } : null,
    ownActions: window && !window.decisions[seat] ? structuredClone(window.options[seat]) : [],
    ownScore: window && !window.decisions[seat] ? engine.currentScore(seat) : null,
    waitingSeats: window ? SEATS.filter(s => window.options[s].length && !window.decisions[s]) : [],
    public: engine.publicState(), actionEvents: structuredClone(engine.actions),
    lastDiscardAction: engine.discardActions.length ? { ...engine.discardActions.at(-1)! } : null,
  }
}
export type BloodFlowSeatView = ReturnType<typeof bloodFlowSeatView>

export function visibleTiles(view: BloodFlowSeatView) {
  return [view.flipTile, ...view.players[view.seat].hand,
    ...view.players.flatMap(p => [...p.discards, ...p.melds.flatMap(m => m.tiles)]),
    // A batch carries one source irrespective of winner count.
    ...view.public.batches.map(b => b.source.tile)]
}
