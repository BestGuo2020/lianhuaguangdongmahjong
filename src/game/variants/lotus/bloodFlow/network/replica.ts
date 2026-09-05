import { BLOOD_FLOW_CONFIG } from '../config'
import type { BloodFlowSeatView } from '../seatView'
import type { Seat } from '../types'
import { vector } from '../state'
import { decodeBloodFlowPacket } from './protocol'

/** Absolute-score replica: deltas are explanatory data, never applied a second time. */
export class BloodFlowReplica {
  view: BloodFlowSeatView | null = null
  round = 0
  sequence = 0
  private snapshotSequence = 0
  private epoch: string | null = null
  readonly seenBatches = new Set<string>()
  readonly completedRounds = new Set<string>()
  error = ''
  constructor(readonly roomId: string, readonly hostPeer: string, readonly seat: Seat,
    readonly requestSync: () => void = () => {}) {}

  receive(raw: unknown, fromPeer: string): boolean {
    if (fromPeer !== this.hostPeer) return false
    const message = decodeBloodFlowPacket(raw)
    if (!message || message.roomId !== this.roomId) return false
    if (message.kind === 'blood_flow_error') { if (message.code === 'INTERRUPTED') this.interrupt(); else this.error = message.code; return true }
    if (!('authorityEpoch' in message) || !('sequence' in message)) return false
    if (this.epoch && message.authorityEpoch !== this.epoch) return false
    if (message.round < this.round) return false
    if (message.kind === 'blood_flow_snapshot' || message.kind === 'round_settled') {
      if (message.view.seat !== this.seat || message.sequence < this.snapshotSequence || message.sequence < this.sequence) return false
      if (message.sequence === this.snapshotSequence && this.view?.public.status !== 'paused') return false
      this.epoch = message.authorityEpoch
      this.round = message.round; this.snapshotSequence = message.sequence; this.sequence = message.sequence
      this.view = structuredClone(message.view)
      this.view.kongEvents=structuredClone(message.kongEvents??message.view.kongEvents??[])
      for (const batch of this.view.public.batches) this.seenBatches.add(batch.batchId)
      if (this.view.public.roundResult) this.completedRounds.add(this.view.roundId)
      this.error = ''
      return true
    }
    if (message.kind !== 'win_batch') return false
    if (!this.view || message.round !== this.round || message.batch.roundId !== this.view.roundId) { this.requestSync(); return false }
    if (this.seenBatches.has(message.batch.batchId) || message.sequence < this.sequence) return false
    if (message.sequence > this.sequence + 1) { this.requestSync(); return false }
    this.sequence = message.sequence
    this.seenBatches.add(message.batch.batchId)
    const batch = structuredClone(message.batch)
    const seats = vector(s => this.view!.public.seats[s])
    for (const record of batch.winners) {
      const previous = seats[record.winner]
      seats[record.winner] = { winCount: record.ordinal, locked: true, firstWinSequence: previous.firstWinSequence ?? batch.sequence,
        recordIds: [...previous.recordIds, record.id] }
    }
    const players = this.view.players.map((p, s) => ({ ...p, hand: [...p.hand], discards: [...p.discards], score: batch.scoresAfter[s] }))
    const source = players[batch.source.seat]
    if (batch.source.kind === 'draw') {
      if (batch.source.seat === this.seat && source.drawnTileIndex >= 0) source.hand.splice(source.drawnTileIndex, 1)
      source.concealedTileCount = Math.max(0, source.concealedTileCount - 1)
      source.drawnTileIndex = -1
    } else if (batch.source.kind === 'discard' && source.discards.at(-1) === batch.source.tile) source.discards.pop()
    this.view = { ...this.view, players,
      // Actions await the matching private snapshot; no speculative move can leak through.
      ownActions: [], public: { ...this.view.public, seats, batches: [...this.view.public.batches, batch] } }
    return true
  }
  pause() { if (this.view && !this.view.public.roundResult) this.view = { ...this.view, ownActions: [], public: { ...this.view.public, status: 'paused' } } }
  interrupt() { this.pause(); if (this.view && !this.view.public.roundResult) this.view = { ...this.view, public: { ...this.view.public, status: 'interrupted' } }; this.error = 'INTERRUPTED' }
  hello() { return { kind: 'blood_flow_hello' as const, roomId: this.roomId, ruleVersion: BLOOD_FLOW_CONFIG.version } }
}
