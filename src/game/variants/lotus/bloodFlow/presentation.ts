import { BLOOD_FLOW_TIMING } from './config'
import type { Seat, WinBatch, WinRecord } from './types'

export type WinTier = 0 | 1 | 2 | 3
export function winTier(record: WinRecord): WinTier {
  const weight = Math.max(...record.score.items.map(p => p.weight), 1)
  return weight >= 16 ? 3 : weight >= 8 ? 2 : weight >= 4 ? 1 : 0
}
export interface BloodFlowCue {
  id: string
  title: string
  tier: WinTier
  duration: number
  compact: boolean
  batchIds: string[]
  seats: { seat: Seat; record: WinRecord; mergedCount: number }[]
}

/** Pure visual queue. It has no score/hand/turn/audio APIs. */
export class BloodFlowPresentationQueue {
  private seen = new Set<string>()
  private pending: { batch: WinBatch; at: number }[] = []
  private lastFull = -Infinity
  private lastFullTier: WinTier = 0
  reset(batches: readonly WinBatch[] = []) {
    this.seen = new Set(batches.map(b => b.batchId)); this.pending = []; this.lastFull = -Infinity; this.lastFullTier = 0
  }
  enqueue(batch: WinBatch, at: number) {
    if (this.seen.has(batch.batchId)) return
    this.seen.add(batch.batchId); this.pending.push({ batch, at })
  }
  next(now: number): BloodFlowCue | null {
    if (!this.pending.length) return null
    const merge = this.pending.length > 3 || now - this.pending[0].at > BLOOD_FLOW_TIMING.visualBacklogMs
    const taken = this.pending.splice(0, merge ? this.pending.length : 1)
    const bySeat = new Map<Seat, { seat: Seat; record: WinRecord; mergedCount: number }>()
    for (const { batch } of taken) for (const record of batch.winners) {
      const old = bySeat.get(record.winner)
      bySeat.set(record.winner, { seat: record.winner, record, mergedCount: (old?.mergedCount ?? 0) + 1 })
    }
    const seats = [...bySeat.values()].sort((a, b) => a.seat - b.seat)
    const strongest = [...seats].sort((a, b) => winTier(b.record) - winTier(a.record) || b.record.score.paymentPerPayer - a.record.score.paymentPerPayer || a.seat - b.seat)[0]
    const tier = winTier(strongest.record)
    const full = !merge && tier >= 2 && (now - this.lastFull >= BLOOD_FLOW_TIMING.fullEffectCooldownMs || tier > this.lastFullTier)
    if (full) { this.lastFull = now; this.lastFullTier = tier }
    const main = [...strongest.record.score.items].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))[0]
    const multi = taken.length === 1 && taken[0].batch.winners.length > 1
    const batchIds = taken.map(t => t.batch.batchId)
    return { id: batchIds.join('|'), batchIds, tier, seats, compact: !full,
      title: merge ? `${taken.length}次胡牌` : `${multi ? `${taken[0].batch.winners.length}响 · ` : ''}${main?.label ?? '胡牌'}`,
      duration: full ? tier === 3 ? BLOOD_FLOW_TIMING.topWinMs : BLOOD_FLOW_TIMING.largeWinMs : BLOOD_FLOW_TIMING.compactWinMs }
  }
}
