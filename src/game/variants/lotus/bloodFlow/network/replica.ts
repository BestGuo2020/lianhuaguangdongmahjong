import { BLOOD_FLOW_CONFIG } from '../config'
import type { BloodFlowSeatView } from '../seatView'
import type { Seat } from '../types'
import { vector } from '../state'
import { decodeBloodFlowPacket } from './protocol'

/**
 * 瘦身帧合并（2026-09-15）：瘦身帧只带最近 2 条胡牌与最近 4 条结算流水，
 * 这里把上一份视图里的历史并集补回，得到与全量帧等价的视图（历史不丢）。
 */
function mergeDietView(incoming: BloodFlowSeatView, previous: BloodFlowSeatView | null): BloodFlowSeatView {
  if (!previous || previous.roundId !== incoming.roundId) return incoming
  const merged = new Map<string, BloodFlowSeatView['public']['batches'][number]>()
  for (const batch of previous.public.batches) merged.set(batch.batchId, batch)
  for (const batch of incoming.public.batches) merged.set(batch.batchId, batch)
  const batches = [...merged.values()].sort((a, b) => a.sequence - b.sequence)
  const sameRoundLedger = previous.public.roundResult?.roundId === incoming.public.roundResult?.roundId
  const ledger = incoming.public.roundResult?.ledger
  const roundResult = incoming.public.roundResult && ledger && sameRoundLedger
    && ledger.length < (previous.public.roundResult?.ledger.length ?? 0)
    ? { ...incoming.public.roundResult, ledger: previous.public.roundResult!.ledger }
    : incoming.public.roundResult
  return { ...incoming, public: { ...incoming.public, batches, roundResult } }
}

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
  /**
   * 房主 peer 需可变：P2P 下对端 id 可能变化（SDK 修复连接/中继切换），replica 若把它冻结在
   * 构造时，之后所有帧都会被 `receive` 以「非房主」拒收 —— 表现为客机一直收帧但视图永不更新
   * （2026-09-10 线上验收实测：HUD 停在 checking、结算面板不出现）。
   */
  constructor(readonly roomId: string, public hostPeer: string, readonly seat: Seat,
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
      // 快照瘦身（2026-09-15）：瘦身帧与上一份视图并集合并，历史（胡牌/结算流水）不会丢。
      const incoming = message.kind === 'blood_flow_snapshot' && (message as { diet?: true }).diet === true
        ? mergeDietView(message.view, this.view)
        : message.view
      this.view = structuredClone(incoming)
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
