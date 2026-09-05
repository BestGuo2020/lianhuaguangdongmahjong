import type { GamePlayer, TileType, TableActionEvent, TableActionType } from '../../../core/contracts/types'
import { sortTilesWithJokers, TILE_TYPES } from '../../../core/rules/tiles'
import { canChi, concealedKongs, windKong } from '../lotusRules'
import { buildRingWall, resolveFlip, resolveOpeningStack, buildDrawOrderWall, wallBreakIndexForOpeningStack, takeLotusTailTile } from '../lotusWall'
import { evaluateWin } from '../patterns/evaluate'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_TIMING } from './config'
import type { BloodFlowLedgerEntry, BloodFlowPublicState, BloodFlowRoundResult, Seat, SourceTileEvent, WinEvaluation, WinSource } from './types'
import { SEATS, vector, nextSeat, newSeatStates } from './state'
import type { BloodFlowAction, BloodFlowOpeningState, EngineCommand, EngineWindow } from './state'
import { acceptWindowDecision, windowComplete } from './claimWindow'
import { assertZeroSum } from './ledger'
import { resolveWinBatch } from './winBatch'
import { summarizeRound } from './roundLifecycle'

export interface BloodFlowEngineOptions {
  authorityEpoch: string
  roundId: string
  dealer?: Seat
  scores?: readonly [number, number, number, number]
  initialWall?: TileType[]
  firstDice?: [number, number]
  secondDice?: [number, number]
  random?: () => number
  now?: () => number
  decisionMs?: number
  winBeatMs?: number
  opening?: BloodFlowOpeningState
}

/** Deterministic authority, with no timers, audio, Vue, reveal-hand or old endGame side effects.
 * Browser assembly runs this entire engine in a worker, including exhaustive scoring.
 */
export class BloodFlowEngine {
  readonly players: GamePlayer[]
  readonly wall: TileType[]
  readonly flipTiles: [TileType, TileType]
  readonly jokers: TileType[]
  readonly flipStack: number
  readonly flipSeat: number
  readonly wallBreakIndex: number
  readonly dealer: Seat
  readonly openingScores: [number, number, number, number]
  readonly seats = newSeatStates()
  readonly archives: SourceTileEvent[] = []
  readonly ledger: BloodFlowLedgerEntry[] = []
  readonly actions: TableActionEvent[] = []
  readonly discardActions: SourceTileEvent[] = []
  readonly privateEvidence = new Map<string, WinEvaluation>()
  window: EngineWindow | null = null
  result: BloodFlowRoundResult | null = null
  currentPlayer: Seat
  headDrawn: number
  version = 0
  sequence = 0
  interrupted = false
  paused = false
  private remainingDeadline = 0
  private remainingOpenDelay = 0
  private winBeatUntil = 0
  private sourceSerial = 0
  private actionSerial = 0
  private evaluation = new Map<Seat, WinEvaluation>()
  private pendingKong: { seat: Seat; meldIndex: number; source: SourceTileEvent } | null = null
  private drawSource: SourceTileEvent | null = null
  private openingBonus = true
  private firstDiscard = true
  private selfPassed = false
  private kongBloom = false

  constructor(readonly options: BloodFlowEngineOptions) {
    this.dealer = options.dealer ?? 0
    this.currentPlayer = this.dealer
    const opening = options.opening ?? this.deal()
    this.players = structuredClone(opening.players)
    this.wall = [...opening.wall]; this.flipTiles = [...opening.flipTiles]; this.jokers = [...opening.jokers]
    this.flipStack = opening.flipStack; this.flipSeat = opening.flipSeat; this.wallBreakIndex = opening.wallBreakIndex
    this.headDrawn = opening.headDrawn
    this.players[this.dealer].drawnTileIndex = opening.dealerDrawnIndex
    this.openingScores = vector(s => this.players[s].score)
    this.assertConservation()
    const tile = this.players[this.dealer].hand[opening.dealerDrawnIndex]
    if (!tile) throw new Error('Opening must identify dealer fourteenth tile')
    this.drawSource = this.source('draw', this.dealer, tile)
    this.openTurn()
  }

  private deal(): BloodFlowOpeningState {
    const random = this.options.random ?? Math.random
    const ring = this.options.initialWall ? [...this.options.initialWall] : buildRingWall(random)
    if (ring.length !== 136 || TILE_TYPES.some(t => ring.filter(p => p === t).length !== 4)) throw new Error('Invalid physical wall')
    const roll = () => Math.floor(random() * 6) + 1
    const firstDice = this.options.firstDice ?? [roll(), roll()]
    const secondDice = this.options.secondDice ?? [roll(), roll()]
    for (const n of [...firstDice, ...secondDice]) if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error('Invalid dice')
    const flip = resolveFlip(ring, this.dealer, firstDice)
    const openingStack = resolveOpeningStack(flip.flipStack, secondDice)
    const wall = buildDrawOrderWall(ring, openingStack, flip.flipStack)
    const players = SEATS.map((seat): GamePlayer => ({ name: `玩家${seat + 1}`, avatar: '', seat,
      score: this.options.scores?.[seat] ?? BLOOD_FLOW_CONFIG.initialScore, hand: [], melds: [], discards: [], redCount: 0, drawnTileIndex: -1 }))
    const order = SEATS.map(s => ((this.dealer + s) % 4) as Seat)
    for (let batch = 0; batch < 3; batch++) for (const seat of order) players[seat].hand.push(...wall.splice(0, 4))
    for (const seat of [...order, this.dealer]) players[seat].hand.push(wall.shift()!)
    const last = players[this.dealer].hand.pop()!
    for (const player of players) player.hand = sortTilesWithJokers(player.hand, flip.jokers)
    players[this.dealer].hand.push(last)
    return { players, wall, flipTiles: [flip.flipTile, ring[flip.flipStack * 2 + 1]], jokers: flip.jokers, headDrawn: 53,
      dealerDrawnIndex: 13, flipStack: flip.flipStack, flipSeat: flip.flipSeat, wallBreakIndex: wallBreakIndexForOpeningStack(openingStack, flip.flipStack) }
  }

  private source(kind: SourceTileEvent['kind'], seat: Seat, tile: TileType): SourceTileEvent {
    return { kind, seat, tile, id: `${this.options.authorityEpoch}/${this.options.roundId}/tile/${++this.sourceSerial}` }
  }
  private now() { return this.options.now?.() ?? Date.now() }
  private event(type: TableActionType, actor: Seat, tile: TileType, from: Seat | null = null, meldIndex = -1) {
    this.actions.push({ id: ++this.actionSerial, type, actorIndex: actor, sourceIndex: from, tile, meldIndex })
  }
  private open(kind: EngineWindow['kind'], source: SourceTileEvent, options: EngineWindow['options']) {
    this.version++
    const opensAt = Math.max(this.now(), this.winBeatUntil)
    this.window = { id: `${this.options.roundId}/window/${this.version}`, version: this.version, kind, source,
      opensAt, deadlineAt: opensAt + (this.options.decisionMs ?? BLOOD_FLOW_TIMING.normalDecisionMs), options, decisions: vector(() => null) }
  }
  private evaluate(seat: Seat, tile: TileType, source: WinSource, opening: 'heaven' | 'earth' | null = null) {
    const player = this.players[seat]
    const concealed = [...player.hand]
    if (source === 'self-draw' || source === 'kong-bloom') concealed.splice(player.drawnTileIndex, 1)
    return evaluateWin({ concealed, melds: player.melds, winningTile: tile, source, jokers: this.jokers, opening })
  }
  private openTurn() {
    const seat = this.currentPlayer, player = this.players[seat]
    const moves: BloodFlowAction[] = []
    this.evaluation.clear()
    if (this.drawSource && !this.selfPassed) {
      const win = this.evaluate(seat, this.drawSource.tile, this.kongBloom ? 'kong-bloom' : 'self-draw',
        this.openingBonus && this.firstDiscard && seat === this.dealer ? 'heaven' : null)
      if (win) { this.evaluation.set(seat, win); moves.push({ kind: 'win' }, { kind: 'pass' }) }
    }
    if (!this.seats[seat].locked && this.wall.length) {
      for (const tile of concealedKongs(player.hand, this.jokers)) moves.push({ kind: 'concealed-kong', tile })
      if (windKong(player.hand, this.jokers)) moves.push({ kind: 'wind-kong' })
      player.melds.forEach((m, meldIndex) => { if (m.type === 'peng' && player.hand.includes(m.tile)) moves.push({ kind: 'added-kong', meldIndex }) })
    }
    player.hand.forEach((_, index) => { if (!this.seats[seat].locked || index === player.drawnTileIndex) moves.push({ kind: 'discard', index }) })
    this.open('turn', this.drawSource ?? this.source('draw', seat, player.hand.at(-1)!), vector(s => s === seat ? moves : []))
  }

  command(seat: Seat, action: BloodFlowAction): EngineCommand {
    if (!this.window) throw new Error('No active action window')
    return { authorityEpoch: this.options.authorityEpoch, roundId: this.options.roundId, windowId: this.window.id,
      stateVersion: this.window.version, seat, action }
  }
  submit(command: EngineCommand): boolean {
    if (this.paused || this.interrupted || this.result || !this.window || command.authorityEpoch !== this.options.authorityEpoch
      || command.roundId !== this.options.roundId || !acceptWindowDecision(this.window, command, this.now())) return false
    if (windowComplete(this.window)) this.resolveWindow()
    this.assertConservation()
    return true
  }
  expire(now = this.now(), expectedWindowId = this.window?.id): void {
    const window = this.window
    if (this.paused || this.interrupted || !window || window.id !== expectedWindowId || now < window.deadlineAt) return
    for (const seat of SEATS) if (window.options[seat].length && !window.decisions[seat]) {
      window.decisions[seat] = window.kind === 'turn'
        ? window.options[seat].filter(a => a.kind === 'discard').at(-1)!
        : { kind: 'pass' }
    }
    this.resolveWindow()
    this.assertConservation()
  }

  private resolveWindow() {
    const window = this.window!
    const winners = SEATS.filter(s => window.decisions[s]?.kind === 'win')
    if (winners.length) return this.applyWinBatch(window, winners)
    if (window.kind === 'turn') {
      const action = window.decisions[this.currentPlayer]!
      if (action.kind === 'pass') {
        if (this.seats[this.currentPlayer].locked) return this.discard(this.players[this.currentPlayer].drawnTileIndex)
        this.selfPassed = true; return this.openTurn()
      }
      if (action.kind === 'discard') return this.discard(action.index)
      return this.performKong(action)
    }
    if (window.kind === 'win') {
      if (this.pendingKong) return this.completeAddedKong()
      return this.openMeldClaims(window.source)
    }
    const claimants = SEATS.filter(s => window.decisions[s] && window.decisions[s]!.kind !== 'pass')
      .sort((a, b) => {
        const rank = (s: Seat) => window.decisions[s]!.kind === 'gang' ? 0 : window.decisions[s]!.kind === 'peng' ? 1 : 2
        return rank(a) - rank(b) || ((a - window.source.seat + 4) % 4) - ((b - window.source.seat + 4) % 4)
      })
    if (!claimants.length) return this.draw(nextSeat(window.source.seat))
    this.claimMeld(claimants[0], window.decisions[claimants[0]]!, window.source)
  }

  private discard(index: number) {
    const seat = this.currentPlayer, player = this.players[seat]
    const tile = player.hand.splice(index, 1)[0]
    player.drawnTileIndex = -1
    player.discards.push(tile)
    if (!this.seats[seat].locked) player.hand = sortTilesWithJokers(player.hand, this.jokers)
    this.drawSource = null
    const source = this.source('discard', seat, tile)
    this.discardActions.push(source)
    const opening = this.firstDiscard && seat === this.dealer && this.openingBonus ? 'earth' : null
    this.firstDiscard = false
    this.openWinClaims(source, 'discard', opening)
  }
  private openWinClaims(source: SourceTileEvent, winSource: WinSource, opening: 'earth' | null = null) {
    this.evaluation.clear()
    const options = vector<readonly BloodFlowAction[]>(seat => {
      if (seat === source.seat) return []
      const win = this.evaluate(seat, source.tile, winSource, opening)
      if (!win) return []
      this.evaluation.set(seat, win)
      return [{ kind: 'win' }, { kind: 'pass' }]
    })
    if (options.some(o => o.length)) this.open('win', source, options)
    else if (this.pendingKong) this.completeAddedKong()
    else this.openMeldClaims(source)
  }
  private openMeldClaims(source: SourceTileEvent) {
    if (!this.wall.length) return this.finishRound()
    const options = vector<readonly BloodFlowAction[]>(seat => {
      if (seat === source.seat || this.seats[seat].locked) return []
      const hand = this.players[seat].hand, count = hand.filter(t => t === source.tile).length
      const actions: BloodFlowAction[] = []
      if (count >= 3) actions.push({ kind: 'gang' })
      if (count >= 2) actions.push({ kind: 'peng' })
      if (seat === nextSeat(source.seat)) for (const chi of canChi(hand, source.tile, this.jokers)) actions.push({ kind: 'chi', tiles: chi.tiles })
      if (actions.length) actions.push({ kind: 'pass' })
      return actions
    })
    if (options.some(o => o.length)) this.open('meld', source, options)
    else this.draw(nextSeat(source.seat))
  }
  private take(hand: TileType[], tile: TileType) {
    const index = hand.indexOf(tile)
    if (index < 0) throw new Error('Missing physical tile')
    hand.splice(index, 1)
  }
  private claimMeld(seat: Seat, action: BloodFlowAction, source: SourceTileEvent) {
    const player = this.players[seat]
    this.players[source.seat].discards.pop()
    const tiles = action.kind === 'chi' ? [...action.tiles] : Array(action.kind === 'gang' ? 4 : 3).fill(source.tile) as TileType[]
    const take = [...tiles]; take.splice(take.indexOf(source.tile), 1)
    for (const tile of take) this.take(player.hand, tile)
    const type = action.kind === 'chi' ? 'chi' : action.kind === 'gang' ? 'gang' : 'peng'
    player.melds.push({ type, tile: source.tile, tiles, from: source.seat })
    this.event(type === 'gang' ? 'discard-gang' : type, seat, source.tile, source.seat, player.melds.length - 1)
    this.openingBonus = false
    this.currentPlayer = seat; this.drawSource = null; this.selfPassed = false; player.drawnTileIndex = -1
    if (type === 'gang') { this.payKong(seat, 'discard', source.seat); this.draw(seat, true) }
    else { player.hand = sortTilesWithJokers(player.hand, this.jokers); this.openTurn() }
  }

  private performKong(action: BloodFlowAction) {
    const seat = this.currentPlayer, player = this.players[seat]
    if (action.kind === 'added-kong') {
      const tile = player.melds[action.meldIndex].tile
      this.take(player.hand, tile)
      player.drawnTileIndex = -1
      const source = this.source('added-kong', seat, tile)
      this.pendingKong = { seat, meldIndex: action.meldIndex, source }
      this.drawSource = null
      return this.openWinClaims(source, 'robbed-kong')
    }
    const wind = action.kind === 'wind-kong'
    if (!wind && action.kind !== 'concealed-kong') throw new Error('Invalid kong action')
    const tiles: TileType[] = wind ? ['east', 'south', 'west', 'north'] : Array(4).fill((action as { tile: TileType }).tile)
    for (const tile of tiles) this.take(player.hand, tile)
    player.melds.push({ type: 'angang', tile: tiles[0], tiles, ...(wind ? { windKong: true } : {}) })
    this.event(wind ? 'wind-kong' : 'concealed-gang', seat, tiles[0], null, player.melds.length - 1)
    this.openingBonus = false
    this.payKong(seat, wind ? 'wind' : 'concealed')
    this.draw(seat, true)
  }
  private completeAddedKong() {
    const pending = this.pendingKong!
    const m = this.players[pending.seat].melds[pending.meldIndex]
    this.players[pending.seat].melds[pending.meldIndex] = { ...m, type: 'gang', added: true, tiles: [...m.tiles, pending.source.tile] }
    this.pendingKong = null
    this.event('added-gang', pending.seat, pending.source.tile, null, pending.meldIndex)
    this.openingBonus = false
    this.payKong(pending.seat, 'added')
    this.draw(pending.seat, true)
  }
  private payKong(actor: Seat, kongKind: 'discard' | 'added' | 'concealed' | 'wind', sourceSeat: Seat | null = null) {
    const deltas = vector(() => 0)
    for (const payer of kongKind === 'discard' ? [sourceSeat!] : SEATS.filter(s => s !== actor)) {
      const amount = BLOOD_FLOW_CONFIG.basePoints * BLOOD_FLOW_CONFIG.kongPayments[kongKind]
      deltas[payer] -= amount; deltas[actor] += amount
    }
    assertZeroSum(deltas)
    this.players.forEach((p, i) => { p.score += deltas[i] })
    this.ledger.push({ kind: 'kong', authorityEpoch: this.options.authorityEpoch, roundId: this.options.roundId, sequence: ++this.sequence,
      id: `${this.options.roundId}/kong/${this.sequence}`, actor, kongKind, sourceSeat, deltas, scoresAfter: vector(s => this.players[s].score) })
  }
  private applyWinBatch(window: EngineWindow, winners: Seat[]) {
    if (this.archives.some(a => a.id === window.source.id)) throw new Error('Source already archived')
    const batch = resolveWinBatch({ authorityEpoch: this.options.authorityEpoch, roundId: this.options.roundId, sequence: ++this.sequence,
      ruleVersion: BLOOD_FLOW_CONFIG.version, windowId: window.id, source: window.source,
      winners: winners.map(seat => ({ seat, evaluation: this.evaluation.get(seat)!, ordinal: this.seats[seat].winCount + 1 })),
      scores: vector(s => this.players[s].score), wallEmpty: !this.wall.length })
    if (window.source.kind === 'draw') this.players[window.source.seat].hand.splice(this.players[window.source.seat].drawnTileIndex, 1)
    else if (window.source.kind === 'discard') this.players[window.source.seat].discards.pop()
    else this.pendingKong = null // original peng was never replaced before success
    this.players[window.source.seat].drawnTileIndex = -1
    this.archives.push({ ...window.source })
    for (const record of batch.winners) {
      const previous = this.seats[record.winner]
      this.seats[record.winner] = { winCount: record.ordinal, locked: true,
        firstWinSequence: previous.firstWinSequence ?? batch.sequence, recordIds: [...previous.recordIds, record.id] }
      this.privateEvidence.set(record.id, this.evaluation.get(record.winner)!)
      this.event(record.score.source === 'self-draw' || record.score.source === 'kong-bloom' ? 'self-draw'
        : record.score.source === 'robbed-kong' ? 'robbed-kong-win' : 'discard-win', record.winner, window.source.tile,
      window.source.kind === 'draw' ? null : window.source.seat)
    }
    this.players.forEach((p, s) => { p.score = batch.scoresAfter[s] })
    this.ledger.push({ kind: 'win', batch })
    this.openingBonus = false; this.drawSource = null
    this.winBeatUntil = this.now() + (this.options.winBeatMs ?? BLOOD_FLOW_TIMING.winBeatMs)
    if (batch.nextAction.kind === 'finish-round') this.finishRound()
    else this.draw(batch.nextAction.seat)
  }
  private draw(seat: Seat, tail = false) {
    if (!this.wall.length) return this.finishRound()
    const tile = tail ? takeLotusTailTile(this.wall, this.headDrawn)! : this.wall.shift()!
    if (!tail) this.headDrawn++
    const player = this.players[seat]
    if (!this.seats[seat].locked) player.hand = sortTilesWithJokers(player.hand, this.jokers)
    player.hand.push(tile); player.drawnTileIndex = player.hand.length - 1
    this.currentPlayer = seat; this.kongBloom = tail; this.selfPassed = false
    this.drawSource = this.source('draw', seat, tile)
    this.openTurn()
  }
  private finishRound() {
    if (this.result) return
    this.window = null; this.version++
    this.result = summarizeRound(BLOOD_FLOW_CONFIG.version, this.options.roundId, this.openingScores,
      vector(s => this.players[s].score), vector(s => this.seats[s].winCount), this.ledger)
  }
  publicState(): BloodFlowPublicState {
    return { ruleVersion: BLOOD_FLOW_CONFIG.version, roundId: this.options.roundId,
      status: this.result ? 'settled' : this.interrupted ? 'interrupted' : this.paused ? 'paused' : 'playing',
      seats: structuredClone(this.seats), batches: this.ledger.flatMap(e => e.kind === 'win' ? [structuredClone(e.batch)] : []),
      roundResult: this.result ? structuredClone(this.result) : null }
  }
  currentScore(seat: Seat) { return this.evaluation.has(seat) ? structuredClone(this.evaluation.get(seat)!.score) : null }
  windowIsOpen() { return !!this.window && !this.paused && !this.interrupted && this.now() >= this.window.opensAt }
  pause() {
    if (this.paused || this.result) return
    this.remainingDeadline = Math.max(0, (this.window?.deadlineAt ?? this.now()) - this.now())
    this.remainingOpenDelay = Math.max(0, (this.window?.opensAt ?? this.now()) - this.now())
    this.paused = true
  }
  resume() {
    if (!this.paused || this.interrupted) return
    if (this.window) this.window.deadlineAt = this.now() + this.remainingDeadline
    if (this.window) this.window.opensAt = this.now() + this.remainingOpenDelay
    this.paused = false
  }
  assertConservation() {
    const physical = [...this.wall, ...this.flipTiles, ...this.archives.map(a => a.tile),
      ...this.players.flatMap(p => [...p.hand, ...p.discards, ...p.melds.flatMap(m => m.tiles)]),
      ...(this.pendingKong ? [this.pendingKong.source.tile] : [])]
    if (physical.length !== 136 || TILE_TYPES.some(t => physical.filter(p => p === t).length !== 4)) throw new Error('136-tile conservation failed')
    if (this.players.some(p => !Number.isSafeInteger(p.score))) throw new Error('Invalid score')
    if (this.window || this.result) for (const seat of SEATS) {
      const effective = this.players[seat].hand.length + 3 * this.players[seat].melds.length
      const expected = this.window?.kind === 'turn' && seat === this.currentPlayer ? 14 : 13
      if (effective !== expected) throw new Error(`Seat ${seat} has ${effective} effective tiles, expected ${expected}`)
    }
    if (this.openingScores && this.players.reduce((n, p) => n + p.score, 0) !== this.openingScores.reduce((a, b) => a + b, 0)) throw new Error('Score conservation failed')
  }
}
