import type { MatchType } from '../../../../core/contracts/types'
import type { BloodFlowEngineOptions } from '../engine'
import type { BloodFlowSeatView } from '../seatView'
import type { EngineCommand } from '../state'
import { vector } from '../state'
import { sameAction } from '../claimWindow'
import type { Seat } from '../types'
import { BLOOD_FLOW_CONFIG } from '../config'
import type { BloodFlowPacket, NetworkOpening } from './protocol'
import { decodeBloodFlowPacket } from './protocol'

export interface BloodFlowAuthorityBackend {
  start(options: Omit<BloodFlowEngineOptions, 'random' | 'now'>): Promise<void>
  view(seat: Seat): Promise<BloodFlowSeatView>
  command(command: EngineCommand): Promise<void>
  bot(seat: Seat, windowId: string): Promise<void>
  expire(windowId: string): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  close(): void
}
export interface BloodFlowAuthorityOptions {
  roomId: string
  authorityEpoch: string
  hostPeer: string
  /** Verified lobby identities, including host seat 0. Never accept claimed message seats. */
  seatByPeer: Map<string, Seat>
  mode: MatchType
  backend: BloodFlowAuthorityBackend
  send(peerId: string, message: BloodFlowPacket): void
  now?: () => number
  /** Uses the existing committed shuffle in the SDK adapter. */
  prepareOpening(round: number): Promise<Pick<BloodFlowEngineOptions, 'initialWall' | 'firstDice' | 'secondDice'>>
  onRoundSettled?(view: BloodFlowSeatView, round: number): void
}

/** Transport-independent coordinator. Serializes mutations, broadcasts private snapshots,
 * and preserves verified seat identity across transient peer changes. */
export class BloodFlowAuthority {
  readonly compatible = new Set<string>()
  readonly aiSeats = new Set<Seat>()
  readonly disconnected = new Map<string, number>()
  readonly settledRounds = new Set<string>()
  private confirmed = new Set<Seat>()
  private publishedBatches = new Set<string>()
  private chain = Promise.resolve()
  private stopped = false
  private current: BloodFlowSeatView | null = null
  private sequence = 0
  private openingGate = false
  private openingReady = new Set<Seat>()
  private openingData: NetworkOpening | null = null
  round = 0
  dealer: Seat = 0
  readonly bindings: Map<string, Seat>
  constructor(readonly options: BloodFlowAuthorityOptions) {
    this.bindings = new Map(options.seatByPeer)
    this.compatible.add(options.hostPeer)
  }
  private now() { return this.options.now?.() ?? Date.now() }
  private envelope() { return { roomId: this.options.roomId, ruleVersion: BLOOD_FLOW_CONFIG.version } }
  private safeSend(peer: string, message: BloodFlowPacket) {
    if (this.stopped) return
    try { this.options.send(peer, message) } catch { /* reconnect requests the complete confirmed state */ }
  }
  receive(raw: unknown, peer: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.stopped || !this.bindings.has(peer)) return
      const message = decodeBloodFlowPacket(raw)
      if (!message || message.roomId !== this.options.roomId) return
      if (message.kind === 'blood_flow_hello') {
        if (message.ruleVersion !== BLOOD_FLOW_CONFIG.version) {
          this.safeSend(peer, { ...this.envelope(), kind: 'blood_flow_error', code: 'INCOMPATIBLE_RULE_VERSION' }); return
        }
        this.compatible.add(peer); this.disconnected.delete(peer); this.aiSeats.delete(this.bindings.get(peer)!)
        if (this.current) await this.sendSnapshot(peer)
        return
      }
      if (!this.compatible.has(peer)) return
      if (message.kind === 'blood_flow_opening_done') {
        if (message.authorityEpoch === this.options.authorityEpoch && message.round === this.round && this.openingGate) {
          this.openingReady.add(this.bindings.get(peer)!); await this.releaseOpening()
        }
        return
      }
      if (message.kind === 'blood_flow_sync') { if (this.current) await this.sendSnapshot(peer); return }
      if (message.kind === 'blood_flow_command') {
        const seat = this.bindings.get(peer)!, c = message.command
        if (c.seat !== seat || c.authorityEpoch !== this.options.authorityEpoch) return
        const view = await this.options.backend.view(seat)
        if (!view.window || view.roundId !== c.roundId || view.window.id !== c.windowId || view.window.version !== c.stateVersion
          || !view.ownActions.some(a => sameAction(a, c.action))) return
        await this.options.backend.command(c)
        await this.publish()
      } else if (message.kind === 'blood_flow_continue') {
        if (message.authorityEpoch !== this.options.authorityEpoch || message.round !== this.round || !this.current?.public.roundResult) return
        this.confirmed.add(this.bindings.get(peer)!)
        await this.maybeAdvance()
      }
    }).catch(() => { this.interrupt() })
    return this.chain
  }
  async start(): Promise<void> {
    if ([...this.bindings.keys()].some(peer => !this.compatible.has(peer))) throw new Error('INCOMPATIBLE_RULE_VERSION')
    await this.startRound(1, [2000, 2000, 2000, 2000])
  }
  private async startRound(round: number, scores: readonly [number, number, number, number]) {
    const opening = await this.options.prepareOpening(round)
    if (this.stopped) return
    if (!opening.firstDice || !opening.secondDice) throw new Error('Both committed dice pairs are required')
    this.round = round; this.dealer = ((round - 1) % 4) as Seat
    this.confirmed.clear()
    await this.options.backend.start({ ...opening, authorityEpoch: this.options.authorityEpoch, roundId: `${this.options.authorityEpoch}/round/${round}`,
      dealer: this.dealer, scores, decisionMs: 25_000 })
    await this.options.backend.pause()
    this.openingData = { firstDice: opening.firstDice, secondDice: opening.secondDice }
    this.openingGate = true; this.openingReady.clear()
    await this.publish()
  }
  private async sendSnapshot(peer: string) {
    const seat = this.bindings.get(peer)
    if (seat === undefined || !this.compatible.has(peer)) return
    const view = await this.options.backend.view(seat)
    const base = { ...this.envelope(), authorityEpoch: this.options.authorityEpoch, sequence: this.sequence, round: this.round,
      mode: this.options.mode, dealer: this.dealer, view }
    this.safeSend(peer, view.public.roundResult ? { ...base, kind: 'round_settled' }
      : { ...base, kind: 'blood_flow_snapshot', ...(this.openingGate ? { opening: this.openingData! } : {}) })
  }
  private async publish() {
    if (this.stopped) return
    this.current = await this.options.backend.view(0)
    this.sequence++
    for (const batch of this.current.public.batches) {
      if (this.publishedBatches.has(batch.batchId)) continue
      this.publishedBatches.add(batch.batchId)
      for (const peer of this.bindings.keys()) if (this.compatible.has(peer)) {
        this.safeSend(peer, { ...this.envelope(), authorityEpoch: this.options.authorityEpoch, sequence: this.sequence,
          round: this.round, kind: 'win_batch', batch })
      }
    }
    for (const peer of this.bindings.keys()) await this.sendSnapshot(peer)
    if (this.current.public.roundResult && !this.settledRounds.has(this.current.roundId)) {
      this.settledRounds.add(this.current.roundId)
      try { this.options.onRoundSettled?.(this.current, this.round) } catch { /* statistics cannot roll back a committed round */ }
    }
  }
  private async maybeAdvance() {
    if (!this.current?.public.roundResult || this.round >= BLOOD_FLOW_CONFIG.rounds[this.options.mode]) return
    const humans = [...this.bindings.values()].filter(s => !this.aiSeats.has(s))
    if (humans.some(s => !this.confirmed.has(s))) return
    await this.startRound(this.round + 1, vector(s => this.current!.players[s].score))
  }
  private async releaseOpening() {
    if (!this.openingGate) return
    if ([...this.bindings.values()].some(s => !this.aiSeats.has(s) && !this.openingReady.has(s))) return
    this.openingGate = false
    await this.options.backend.resume()
    await this.publish()
  }
  /** One authority tick. The caller owns scheduling; UI/TTS completion never calls this. */
  tick(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.stopped || !this.current) return
      for (const [peer, since] of this.disconnected) {
        const seat = this.bindings.get(peer)
        if (seat !== undefined && this.now() - since >= 12_000) this.aiSeats.add(seat)
      }
      if (this.current.public.status !== 'playing') { await this.releaseOpening(); await this.maybeAdvance(); return }
      const bot = this.current.waitingSeats.find(s => this.aiSeats.has(s) || ![...this.bindings.values()].includes(s))
      if (bot !== undefined && this.current.window) {
        await this.options.backend.bot(bot, this.current.window.id); await this.publish()
      } else if (this.current.window && this.now() >= this.current.window.deadlineAt) {
        await this.options.backend.expire(this.current.window.id); await this.publish()
      }
    }).catch(() => { this.interrupt() })
    return this.chain
  }
  peerDisconnected(peer: string) { if (peer !== this.options.hostPeer && this.bindings.has(peer) && !this.disconnected.has(peer)) this.disconnected.set(peer, this.now()) }
  /** Only call after the existing lobby has verified its stable seat token. */
  replaceVerifiedBindings(bindings: Map<string, Seat>) {
    if (new Set(bindings.values()).size !== bindings.size || bindings.get(this.options.hostPeer) !== 0) throw new Error('Invalid verified roster')
    this.bindings.clear(); bindings.forEach((s, p) => this.bindings.set(p, s))
  }
  async pause() { await this.options.backend.pause(); await this.publish() }
  async resume() { await this.options.backend.resume(); await this.publish() }
  interrupt() {
    if (this.stopped) return
    for (const peer of this.bindings.keys()) this.safeSend(peer, { ...this.envelope(), kind: 'blood_flow_error', code: 'INTERRUPTED' })
    this.stop()
  }
  stop() { this.stopped = true; this.options.backend.close() }
}
