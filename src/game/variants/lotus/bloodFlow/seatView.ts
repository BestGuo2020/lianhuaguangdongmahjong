import type { BloodFlowEngine } from './engine'
import type { Seat, KongLedgerEntry, SourceTileEvent } from './types'
import { SEATS } from './state'

/** The only authority projection accepted by UI or decision code. No wall order,
 * bottom flip tile, opponent concealed hand or private decomposition leaves here.
 *
 * `options` 仅供**本地**用途（对局回放录制）：`revealAll` 打开四家明牌、`includeDiscards`
 * 附上本局累计弃牌流水。默认调用（联机下发）输出保持原样，不带这两个可选字段 ——
 * 网络侧 `isSeatView` 用白名单校验字段，旁观视角永远不上网。 */
export interface SeatViewOptions {
  /** 本地旁观：四家手牌全部可见（回放用）。 */
  revealAll?: boolean
  /** 本地旁观：附带本局累计弃牌流水，避免采样漏掉中间弃牌。 */
  includeDiscards?: boolean
}

export function bloodFlowSeatView(engine: BloodFlowEngine, seat: Seat, options: SeatViewOptions = {}) {
  if (!SEATS.includes(seat)) throw new Error('Invalid viewer seat')
  const players = engine.players.map((p, s) => ({ ...structuredClone(p),
    hand: options.revealAll || seat === s || engine.result ? [...p.hand] : [], concealedTileCount: p.hand.length }))
  const window = engine.window
  const payments:{kongEvents?:readonly KongLedgerEntry[]}={kongEvents:engine.ledger.filter((entry):entry is KongLedgerEntry=>entry.kind==='kong').map(entry=>structuredClone(entry))}
  const pacing: { transition?: NonNullable<BloodFlowEngine['transition']> } = engine.transition ? { transition: { ...engine.transition } } : {}
  const discards: { discardActions?: readonly SourceTileEvent[] } = options.includeDiscards
    ? { discardActions: engine.discardActions.map(action => ({ ...action })) }
    : {}
  return {
    ...payments,
    ...pacing,
    ...discards,
    authorityEpoch: engine.options.authorityEpoch, roundId: engine.options.roundId, version: engine.version, seat,
    players, currentPlayer: engine.currentPlayer, wallCount: engine.wall.length, headDrawn: engine.headDrawn,
    flipTile: engine.flipTiles[0], jokers: [...engine.jokers], flipStack: engine.flipStack,
    flipSeat: engine.flipSeat, wallBreakIndex: engine.wallBreakIndex,
    window: window ? { id: window.id, version: window.version, kind: window.kind, deadlineAt: window.deadlineAt, opensAt: window.opensAt, source: { ...window.source } } : null,
    ownActions: window && engine.windowIsOpen() && !window.decisions[seat] ? structuredClone(window.options[seat]) : [],
    ownScore: window && engine.windowIsOpen() && !window.decisions[seat] ? engine.currentScore(seat) : null,
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
