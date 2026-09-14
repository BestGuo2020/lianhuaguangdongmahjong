import type { MatchType } from '../../../../core/contracts/types'
import type { BloodFlowEngineOptions } from '../engine'
import type { BloodFlowSeatView } from '../seatView'
import type { EngineCommand, BloodFlowAction } from '../state'
import { vector } from '../state'
import { sameAction } from '../claimWindow'
import type { Seat } from '../types'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_TIMING } from '../config'
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
  decide?(view: BloodFlowSeatView, isCurrent: () => boolean): Promise<BloodFlowAction | null>
  cancelDecisions?(): void
  /** 机器人/大模型决策上限（毫秒）；缺省用 BLOOD_FLOW_TIMING.authorityBotDecisionTimeoutMs。 */
  botDecisionTimeoutMs?: number
  /** 引擎/传输调用上限（毫秒）；缺省用 BLOOD_FLOW_TIMING.authorityWorkerTimeoutMs。 */
  workerTimeoutMs?: number
  /**
   * 停滞取证（2026-09-14，仅 `?bfdiag=1` 时传入）：把 tick 内每个提前 return 的原因、
   * 机器人分支的进出与座位打出来。线上实测"权威在等一个未绑定座位、却不推进"时，
   * 只有这条 trace 能区分是"等窗口开启""非进行中状态"还是"机器人分支没进/没生效"。
   */
  trace?(message: string): void
}

/** Transport-independent coordinator. Serializes mutations, broadcasts private snapshots,
 * and preserves verified seat identity across transient peer changes. */
export class BloodFlowAuthority {
  readonly compatible = new Set<string>()
  readonly aiSeats = new Set<Seat>()
  readonly autoSeats = new Set<Seat>()
  readonly disconnected = new Map<string, number>()
  readonly settledRounds = new Set<string>()
  /**
   * 自愈诊断（2026-09-14）：机器人/大模型决策超时次数。> 0 说明有过"决策挂住"，
   * 那时权威链靠超时回落才继续推进（否则窗口过期/发快照全部排不上队，双方卡死）。
   */
  botDecisionTimeouts = 0
  /** 自愈诊断：引擎/传输调用超时次数（view/expire/command/bot/publish 路径）。 */
  workerCallTimeouts = 0
  /**
   * 停滞取证（2026-09-14）：tick 链的活性。
   * `tickRuns` 只在链体真正执行时自增；调用方（房间 450ms 定时器）的调用次数记在房间侧。
   * 卡住时"调用在涨、执行不涨"＝链被某个 await 堵住；两者都不涨＝调用方停了。
   * `chainBusySince` 记录当前链体开始时间，供 `chainBusyMs` 判断堵塞时长。
   */
  tickRuns = 0
  private chainBusySince = 0
  get chainBusyMs() { return this.chainBusySince ? this.now() - this.chainBusySince : 0 }
  private confirmed = new Set<Seat>()
  private publishedBatches = new Set<string>()
  private chain = Promise.resolve()
  private stopped = false
  private current: BloodFlowSeatView | null = null
  private sequence = 0
  private openingGate = false
  private openingReady = new Set<Seat>()
  private openingData: NetworkOpening | null = null
  private publishedOpenWindow = ''
  round = 0
  dealer: Seat = 0
  readonly bindings: Map<string, Seat>
  /** 只读视图出口（2026-09-14 追加）：线上停滞取证要看到权威此刻认定的窗口归属与等待座位。 */
  get currentView(): BloodFlowSeatView | null { return this.current }
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
      if (message.kind === 'blood_flow_auto' && message.authorityEpoch === this.options.authorityEpoch) {
        const seat = this.bindings.get(peer)!
        if (message.enabled) this.autoSeats.add(seat); else this.autoSeats.delete(seat)
        if (this.current) await this.publish()
        return
      }
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
        const view = await this.viewBounded(seat)
        // 读视图超时：丢弃这一条命令（客户端可重发），但绝不阻塞链。
        if (!view) return
        if (!view.window || view.roundId !== c.roundId || view.window.id !== c.windowId || view.window.version !== c.stateVersion
          || !view.ownActions.some(a => sameAction(a, c.action))) return
        await this.opBounded('command', () => this.options.backend.command(c))
        await this.publish()
      } else if (message.kind === 'blood_flow_continue') {
        if (message.authorityEpoch !== this.options.authorityEpoch || message.round !== this.round || !this.current?.public.roundResult) return
        this.confirmed.add(this.bindings.get(peer)!)
        await this.maybeAdvance()
        if(this.current?.public.roundResult) await this.publish()
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
      dealer: this.dealer, scores, decisionMs: BLOOD_FLOW_TIMING.remoteDecisionMs })
    await this.options.backend.pause()
    this.openingData = { firstDice: opening.firstDice, secondDice: opening.secondDice }
    this.openingGate = true; this.openingReady.clear()
    await this.publish()
  }
  private async sendSnapshot(peer: string) {
    const seat = this.bindings.get(peer)
    if (seat === undefined || !this.compatible.has(peer)) return
    const projected = await this.viewBounded(seat)
    if (!projected) return
    // Additional public receipts travel in the envelope; older v1 view decoders keep their shape.
    const {kongEvents,...view}=projected
    const requiredSeats=[...this.bindings.values()].filter(s=>!this.aiSeats.has(s))
    const base = { ...this.envelope(), authorityEpoch: this.options.authorityEpoch, sequence: this.sequence, round: this.round,
      mode: this.options.mode, dealer: this.dealer, view, ...(kongEvents?.length?{kongEvents}:{}),
      ...(view.public.roundResult?{continuation:{requiredSeats,readySeats:requiredSeats.filter(s=>this.confirmed.has(s))}}:{}) }
    this.safeSend(peer, view.public.roundResult ? { ...base, kind: 'round_settled' }
      : { ...base, kind: 'blood_flow_snapshot', autoPlay: this.autoSeats.has(seat), ...(this.openingGate ? { opening: this.openingData! } : {}) })
  }
  private async publish() {
    if (this.stopped) return
    const view = await this.viewBounded(0)
    // 读视图超时/失败：跳过本次发布（下一次 tick 会重试）。绝不把链挂在这里——
    // 线上实测正是"某次广播不返回 → 窗口过期与机器人推进全部排不上队"（房间 G626L9）。
    if (!view) { this.options.trace?.('publish 跳过：view(0) 超时或失败'); return }
    this.current = view
    if (this.current.window && this.now() >= this.current.window.opensAt) this.publishedOpenWindow = this.current.window.id
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
    await this.opBounded('resume', () => this.options.backend.resume())
    await this.publish()
  }
  /** One authority tick. The caller owns scheduling; UI/TTS completion never calls this. */
  tick(): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.tickRuns += 1
      this.chainBusySince = this.now()
      const trace = this.options.trace
      if (this.stopped || !this.current) { trace?.('tick 跳过：stopped 或无当前视图'); return }
      for (const [peer, since] of this.disconnected) {
        const seat = this.bindings.get(peer)
        if (seat !== undefined && this.now() - since >= BLOOD_FLOW_TIMING.recoveryGraceMs) this.aiSeats.add(seat)
      }
      if (this.current.public.status !== 'playing') {
        trace?.(`tick 非进行中状态=${this.current.public.status}（尝试开局闸门/推进下一局）`)
        await this.releaseOpening(); await this.maybeAdvance(); return
      }
      if (this.current.window && this.now() < this.current.window.opensAt) {
        trace?.(`tick 等待窗口开启 window=${this.current.window.id} 还有 ${Math.round(this.current.window.opensAt - this.now())}ms`)
        return
      }
      if (this.current.window && this.current.window.id !== this.publishedOpenWindow) await this.publish()
      if (this.current.window && this.now() >= this.current.window.deadlineAt) {
        trace?.(`tick 窗口过期 window=${this.current.window.id} 到期 ${Math.round(this.now() - this.current.window.deadlineAt)}ms 前，执行 expire`)
        await this.opBounded('expire', () => this.options.backend.expire(this.current!.window!.id))
        await this.publish(); return
      }
      const bots = this.current.waitingSeats.filter(s => this.aiSeats.has(s) || this.autoSeats.has(s) || ![...this.bindings.values()].includes(s))
      trace?.(`tick window=${this.current.window?.id ?? '-'} 等待=${JSON.stringify(this.current.waitingSeats)} `
        + `已绑定=${JSON.stringify([...this.bindings.values()])} 机器人=${JSON.stringify(bots)} 到期还有=${this.current.window ? Math.round(this.current.window.deadlineAt - this.now()) : '-'}ms`)
      if (bots.length && this.current.window) {
        const windowId = this.current.window.id
        // Each seat requests once; a multi-win window never waits through full budgets serially.
        const choices = await Promise.all(bots.map(async seat => {
          const own = await this.viewBounded(seat)
          const current = () => !this.stopped && this.current?.window?.id === windowId && !!this.current?.waitingSeats.includes(seat)
          // 读不到该座位视图（超时/失败）时不发决策请求：直接回落引擎自己的机器人策略。
          const action = own ? await this.decideBounded(own, current) : null
          return { seat, own, action, current }
        }))
        for (const choice of choices) {
          if (!choice.current()) continue
          if (this.current.window && this.now() >= this.current.window.deadlineAt) {
            await this.opBounded('expire', () => this.options.backend.expire(this.current!.window!.id))
            await this.publish(); break
          }
          if (choice.action && choice.own?.window) {
            await this.opBounded('command', () => this.options.backend.command({ authorityEpoch: choice.own!.authorityEpoch,
              roundId: choice.own!.roundId, windowId, stateVersion: choice.own!.window!.version, seat: choice.seat, action: choice.action! }))
          }
          else await this.opBounded('bot', () => this.options.backend.bot(choice.seat, windowId))
          await this.publish()
          // 停滞取证（2026-09-14）：机器人动作"执行了"不等于"局面推进了"。
          // 这里记录动作后的窗口，若窗口没变，就是引擎把这一手吞了（而不是链被堵住）。
          trace?.(`机器人动作后 seat=${choice.seat} 原窗口=${windowId} 现窗口=${this.current?.window?.id ?? '(无)'} `
            + `等待=${JSON.stringify(this.current?.waitingSeats ?? [])}`)
        }
      }
    }).catch(() => { this.interrupt() }).finally(() => { this.chainBusySince = 0 })
    return this.chain
  }

  /**
   * 有界读取某座位的权威视图（2026-09-14 第二轮自愈）。超时/抛错返回 null 并计数，
   * 调用方据此跳过本次操作（tick/publish 每 450ms 会重试），而不是把整条链挂住。
   */
  private async viewBounded(seat: Seat): Promise<BloodFlowSeatView | null> {
    return this.callBounded(`view(${seat})`, () => this.options.backend.view(seat), null)
  }

  /** 有界执行一个引擎/传输操作；返回 false 表示超时或失败（调用方应跳过本次并等下轮重试）。 */
  private async opBounded(label: string, run: () => Promise<void>): Promise<boolean> {
    return this.callBounded(label, async () => { await run(); return true }, false)
  }

  /**
   * 通用有界调用：`Promise.race` + 硬上限。迟到的结果被安全丢弃（值或 rejection 都吞掉），
   * 这样"某次引擎/传输调用不返回"就只会让本次操作被跳过，不会冻结权威链。
   */
  private async callBounded<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
    const budget = this.options.workerTimeoutMs ?? BLOOD_FLOW_TIMING.authorityWorkerTimeoutMs
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        Promise.resolve(run()).catch(error => {
          this.options.trace?.(`${label} 抛错：${String(error).slice(0, 80)}`)
          return fallback
        }),
        new Promise<T>(resolve => {
          timer = setTimeout(() => {
            this.workerCallTimeouts += 1
            this.options.trace?.(`${label} 超时 ${budget}ms（第 ${this.workerCallTimeouts} 次），跳过本次操作`)
            resolve(fallback)
          }, budget)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 有界机器人/大模型决策（2026-09-14 自愈）。
   *
   * `decide` 是权威链里唯一等外部的 await（大模型请求可能很慢甚至不返回）。它一旦挂住，
   * 同一条串行链上的窗口过期、快照广播与命令校验全部排不上队：双方都停在等待、只剩托管按钮，
   * 表现为线上那种"5 分钟不推进"。这里给它一个硬上限，超时就返回 null，
   * 调用方随即回落到引擎自己的机器人策略（`backend.bot`），保证每轮 tick 都有界推进。
   */
  private async decideBounded(
    view: BloodFlowSeatView,
    isCurrent: () => boolean,
  ): Promise<BloodFlowAction | null> {
    const decide = this.options.decide
    if (!decide) return null
    const budget = this.options.botDecisionTimeoutMs ?? BLOOD_FLOW_TIMING.authorityBotDecisionTimeoutMs
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        // 迟到的决策结果无人接收，这里兜住 rejection，避免 unhandled rejection。
        Promise.resolve(decide(view, isCurrent)).catch(() => null),
        new Promise<null>(resolve => { timer = setTimeout(() => { this.botDecisionTimeouts += 1; resolve(null) }, budget) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  peerDisconnected(peer: string) { if (peer !== this.options.hostPeer && this.bindings.has(peer) && !this.disconnected.has(peer)) this.disconnected.set(peer, this.now()) }
  /** Only call after the existing lobby has verified its stable seat token. */
  replaceVerifiedBindings(bindings: Map<string, Seat>) {
    if (new Set(bindings.values()).size !== bindings.size || bindings.get(this.options.hostPeer) !== 0) throw new Error('Invalid verified roster')
    this.bindings.clear(); bindings.forEach((s, p) => this.bindings.set(p, s))
  }
  async pause() { await this.opBounded('pause', () => this.options.backend.pause()); await this.publish() }
  async resume() { await this.opBounded('resume', () => this.options.backend.resume()); await this.publish() }
  interrupt() {
    if (this.stopped) return
    for (const peer of this.bindings.keys()) this.safeSend(peer, { ...this.envelope(), kind: 'blood_flow_error', code: 'INTERRUPTED' })
    this.stop()
  }
  stop() { this.stopped = true; this.options.cancelDecisions?.(); this.options.backend.close() }
}
