import { computed, getCurrentInstance, onBeforeUnmount, shallowRef, toRaw, watch } from 'vue'
import { defineGamePort } from '../../../core/contracts/gamePort'
import type { GameStartOptions, WaitInfo } from '../../../core/contracts/gamePort'
import type { MatchType, TileType } from '../../../core/contracts/types'
import { createLotusGameState } from '../lotusState'
import { createLotusOpening } from '../lotusOpening'
import { buildRingWall } from '../lotusWall'
import { createCommonGameSelectors } from '../../../shared/selectors/gameSelectors'
import { MATCH_NAMES } from '../../../core/local/localGameConfig'
import { tileAudioFile, tileName } from '../../../core/rules/tiles'
import { createLocalTransientEventPresenter } from '../../../core/local/localTransientEventPresenter'
import { resolveAnimeAudioPolicy } from '../../../core/presentation/animeAudioPolicy'
import { isLocalLlmSeat } from '../../../core/presentation/localLlmVoiceRegistry'
import type { AnimeFixedTtsExecutor } from '../../../llm/animeFixedTtsExecutor'
import type { PlayerSeed } from '../../../shared/runtime/localOpening'
import { BLOOD_FLOW_CONFIG } from './config'
import { createBloodFlowWorkerClient } from './workerClient'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import type { BloodFlowAction, BloodFlowOpeningState } from './state'
import type { EngineCommand } from './state'
import type { NetworkOpening } from './network/protocol'
import type { evaluateWaits } from '../patterns/evaluate'
import { createEvaluatorService } from '../patterns/evaluatorService'
import { createBloodFlowAudioBridge } from './audioBridge'
import { createBloodFlowDecisions, createBloodFlowReactions, bloodFlowReactionsAllowed, type BloodFlowReaction } from '../../../llm/bloodFlowRuntime'
import { getLocalTtsClient } from '../../../llm/localTtsClient'
import { canPlayLocalLlmAudio } from '../../../core/presentation/llmAudioBus'

export interface BloodFlowGameOptions {
  playSound?: (name: string, volume?: number) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  getThemeName?: () => string
  animeFixedTts?: AnimeFixedTtsExecutor
  humanPlayerSeed?: PlayerSeed
  aiPlayerSeeds?: PlayerSeed[]
  /** Explicit test option: authority still uses the actual worker and rules engine. */
  autoplay?: boolean
  paceMs?: number
  countdownEnabled?: boolean
  externalAuthority?: {
    send(command: EngineCommand): void
    nextRound(): void
    leave(): void
    openingDone(round: number): void
  }
}
type RemoteViewMeta = { round: number; dealer: number; mode: MatchType; opening?: NetworkOpening; replay?: boolean }

export function useBloodFlowGame(options: BloodFlowGameOptions = {}) {
  const state = createLotusGameState()
  const common = createCommonGameSelectors(state, MATCH_NAMES)
  const view = shallowRef<BloodFlowSeatView | null>(null)
  const waitScores = shallowRef<ReturnType<typeof evaluateWaits>>([])
  const presentationSerial = shallowRef(0)
  const roundBubbles = shallowRef<Record<number, { text: string; id: number; persistent: boolean }>>({})
  const decisions = createBloodFlowDecisions()
  const pendingBots = new Set<string>(), spoken = new Set<string>(), speechControllers = new Set<AbortController>()
  let speechChain = Promise.resolve(), bubbleSerial = 0
  const reactions = createBloodFlowReactions({ theme: () => options.getThemeName?.() ?? 'jade',
    current: current => view.value?.authorityEpoch === current.authorityEpoch && view.value?.roundId === current.roundId && !!view.value?.public.roundResult,
    emit: (line, signal) => presentRoundReaction(line, signal),
  })
  let worker: ReturnType<typeof createBloodFlowWorkerClient> | null = null
  let hintWorker: ReturnType<typeof createEvaluatorService> | null = null
  let generation = 0, busy = false, heardAction = 0, heardDiscard = '', seenWindow = ''
  let ring: TileType[] = [], dealerTile: TileType | null = null
  let remoteOpeningId = '', countdownTicket = 0
  const completedRemoteOpenings = new Set<string>()
  let pendingRemote: { view: BloodFlowSeatView; meta: RemoteViewMeta } | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const waiters = new Set<() => void>()
  const sound = (name: string, volume?: number) => { try { return options.playSound?.(name, volume) } catch { return undefined } }
  const safeSoundAndWait = async (name: string, volume?: number) => { try { await options.playSoundAndWait?.(name, volume) } catch { /* decorative */ } }
  function later(callback: () => void, delay: number) {
    const epoch = generation
    const id = setTimeout(() => { timers.delete(id); if (epoch === generation) callback() }, delay)
    timers.add(id)
    return id as unknown as number
  }
  function clear() {
    generation++; busy = false
    presentationSerial.value++
    remoteOpeningId = ''; countdownTicket++
    completedRemoteOpenings.clear(); pendingRemote = null
    timers.forEach(clearTimeout); timers.clear()
    waiters.forEach(resolve => resolve()); waiters.clear()
    worker?.close(); worker = null
    hintWorker?.cancel(); hintWorker = null
    actionAudio.reset()
    decisions.cancel(); pendingBots.clear(); reactions.cancel(); cancelReactionSpeech(); spoken.clear()
  }
  const actionAudio = createBloodFlowAudioBridge({ epoch: () => `blood-flow:${generation}`, theme: () => options.getThemeName?.() ?? 'jade',
    player: index => state.players[index], fixed: options.animeFixedTts, play: sound })
  const transient = createLocalTransientEventPresenter({ state, later, onTableAction: actionAudio.present })
  watch(() => options.getThemeName?.(), () => { if (view.value) { actionAudio.reset(); presentationSerial.value++; reactions.cancel(); cancelReactionSpeech() } })

  function apply(next: BloodFlowSeatView) {
    const previous = view.value
    view.value = next
    decisions.cancelStale()
    const toLocal = (seat: number) => (seat - next.seat + 4) % 4
    const seeds = [options.humanPlayerSeed, ...(options.aiPlayerSeeds ?? [])]
    state.players.splice(0, state.players.length, ...next.players.map((_, i) => {
      const p = next.players[(next.seat + i) % 4], seed = options.externalAuthority ? undefined : seeds[i]
      return { ...p, name: seed?.name ?? p.name, avatar: seed?.avatar ?? p.avatar,
        characterId: seed?.characterId ?? p.characterId, playerKind: seed?.playerKind ?? p.playerKind ?? (i === 0 ? 'human' as const : 'bot' as const) }
    }))
    // Only public count placeholders reach the renderer; the actual wall stays in worker.
    state.wall.value = Array(next.wallCount).fill('east')
    state.wallHeadDrawn.value = next.headDrawn; state.currentPlayer.value = toLocal(next.currentPlayer)
    state.flipTile.value = next.flipTile; state.jokerTiles.value = next.jokers
    state.flipStack.value = next.flipStack; state.flipSeat.value = next.flipSeat; state.wallBreakIndex.value = next.wallBreakIndex
    state.selectedIndex.value = -1
    const w = next.window, moves = next.ownActions
    state.phase.value = next.public.roundResult ? 'settled' : next.public.status !== 'playing' ? 'checking'
      : w && Date.now() < w.opensAt ? 'drawing' : w?.kind === 'turn'
      ? next.currentPlayer === next.seat ? 'discard' : 'thinking' : moves.length ? 'prompt' : 'checking'
    state.userDrewThisTurn.value = Boolean(w?.kind === 'turn' && next.currentPlayer === next.seat && next.public.status === 'playing')
    state.actionPrompt.value = w && w.kind !== 'turn' && moves.length ? {
      type: moves.some(a => a.kind === 'win') ? w.source.kind === 'added-kong' ? 'rob' : 'hu' : 'response',
      from: toLocal(w.source.seat), tile: w.source.tile, canHu: moves.some(a => a.kind === 'win'),
      canGang: moves.some(a => a.kind === 'gang'), canPeng: moves.some(a => a.kind === 'peng'),
      chiOptions: moves.flatMap(a => a.kind === 'chi' ? [{ tiles: a.tiles, kind: 'sequence' as const }] : []),
    } : null
    if (next.lastDiscardAction && next.lastDiscardAction.id !== heardDiscard) {
      heardDiscard = next.lastDiscardAction.id
      const d = next.lastDiscardAction, player = state.players[toLocal(d.seat)]
      state.lastDiscard.value = { tile: d.tile, from: toLocal(d.seat), id: next.version }
      sound('dapai.mp3', 0.8)
      const route = resolveAnimeAudioPolicy({ themeName: options.getThemeName?.(), playerKind: player.playerKind, isLlm: player.isLlm })
      const llmSeat = options.externalAuthority ? player.playerKind === 'llm' || player.isLlm : isLocalLlmSeat(d.seat)
      if (!llmSeat && route.discard.tileName !== 'suppress') later(() => sound(tileAudioFile(d.tile)), 80)
    }
    for (const action of next.actionEvents) if (action.id > heardAction) {
      heardAction = action.id
      transient.showTableAction(action.type, toLocal(action.actorIndex), action.sourceIndex === null ? null : toLocal(action.sourceIndex), action.tile, action.meldIndex)
    }
    if (next.public.roundResult) {
      const result = next.public.roundResult
      state.revealHands.value = true
      state.result.value = { winner: '本局结束', draw: result.winCounts.every(n => n === 0), roundLabel: common.roundLabel.value,
        scoreChanges: state.players.map((p, i) => ({ playerIndex: i, name: p.name, avatar: p.avatar, delta: result.endingScores[p.seat] - result.openingScores[p.seat], score: p.score })) }
      state.matchFinished.value = state.round.value >= BLOOD_FLOW_CONFIG.rounds[state.matchType.value]
      if (!options.externalAuthority) void reactions.run(next)
    }
    if (w?.id !== seenWindow) { seenWindow = w?.id ?? ''; waitScores.value = []; if (next.ownActions.length) void refreshWaits() }
    if (previous && w?.kind === 'turn' && w.source.id !== previous.window?.source.id
      && next.players[next.currentPlayer].drawnTileIndex >= 0) sound('give.mp3', .7)
    const ticket = ++countdownTicket
    const updateCountdown = () => {
      if (ticket !== countdownTicket) return
      state.turnSeconds.value = w && moves.length && options.countdownEnabled !== false && Number.isFinite(w.deadlineAt)
        ? Math.max(0, Math.ceil((w.deadlineAt - Date.now()) / 1000)) : 0
      if (state.turnSeconds.value > 0) later(updateCountdown, 1000)
    }
    updateCountdown()
    schedule()
  }
  async function request(body: Parameters<NonNullable<typeof worker>['request']>[0]) {
    if (!worker || busy) return
    busy = true
    const epoch = generation
    try {
      const next = await worker.request<BloodFlowSeatView>(body)
      if (epoch !== generation) return
      busy = false; apply(next)
    } catch (error) {
      if (epoch !== generation) return
      clear()
      transient.announce('对局已中断，请返回大厅重开', 'red')
      state.actionPrompt.value = null
      if (view.value) view.value = { ...view.value, ownActions: [], public: { ...view.value.public, status: 'interrupted' } }
    }
  }
  function schedule() {
    if (options.externalAuthority) return
    const current = view.value, w = current?.window
    if (!current || !w || current.public.status !== 'playing') return
    if (Date.now() < w.opensAt) {
      later(() => { if (view.value?.window?.id === w.id) void request({ kind: 'view', seat: 0 }) }, w.opensAt - Date.now())
      return
    }
    const epoch = generation
    for (const bot of current.waitingSeats.filter(s => s !== 0 || options.autoplay)) later(() => {
      if (epoch === generation && view.value?.window?.id === w.id) void actBot(bot, w.id, epoch)
    }, options.paceMs ?? 650)
    if (w.deadlineAt < Number.MAX_SAFE_INTEGER) later(() => {
      if (view.value?.window?.id === w.id) void request({ kind: 'expire', windowId: w.id })
    }, Math.max(0, w.deadlineAt - Date.now()))
  }
  async function actBot(seat: 0 | 1 | 2 | 3, windowId: string, epoch: number) {
    const active = worker, key = `${epoch}/${windowId}/${seat}`
    if (!active || pendingBots.has(key)) return
    pendingBots.add(key)
    const current = () => epoch === generation && view.value?.window?.id === windowId && !!view.value?.waitingSeats.includes(seat)
    try {
      const own = await active.request<BloodFlowSeatView>({ kind: 'view', seat })
      if (!current() || own.window?.id !== windowId) return
      const action = await decisions.decide(own, current)
      if (!current()) return
      const next = await active.request<BloodFlowSeatView>(action ? { kind: 'command', command: {
        authorityEpoch: own.authorityEpoch, roundId: own.roundId, windowId, stateVersion: own.window.version, seat, action,
      } } : { kind: 'bot', seat, windowId })
      if (epoch === generation && (!view.value || next.version >= view.value.version)) apply(next)
    } catch {
      if (epoch === generation) {
        clear(); transient.announce('对局已中断，请返回大厅重开', 'red')
        if (view.value) view.value = { ...view.value, ownActions: [], public: { ...view.value.public, status: 'interrupted' } }
      }
    }
    finally { pendingBots.delete(key) }
  }
  function send(action: BloodFlowAction) {
    const current = view.value, w = current?.window
    if (!current || !w) return
    const command: EngineCommand = { authorityEpoch: current.authorityEpoch, roundId: current.roundId,
      stateVersion: w.version, windowId: w.id, seat: current.seat, action }
    if (options.externalAuthority) options.externalAuthority.send(command)
    else void request({ kind: 'command', command })
  }
  async function beginEngine() {
    if (!dealerTile || !state.players.length) return
    const dealer = state.players[state.dealer.value]
    const dealerDrawnIndex = dealer.hand.lastIndexOf(dealerTile)
    const opening: BloodFlowOpeningState = {
      players: state.players.map(p => structuredClone(toRaw(p))), wall: [...state.wall.value],
      flipTiles: [state.flipTile.value!, ring[state.flipStack.value! * 2 + 1]], jokers: [...state.jokerTiles.value],
      headDrawn: state.wallHeadDrawn.value, dealerDrawnIndex, flipStack: state.flipStack.value!,
      flipSeat: state.flipSeat.value!, wallBreakIndex: state.wallBreakIndex.value,
    }
    worker = createBloodFlowWorkerClient()
    hintWorker = createEvaluatorService()
    await request({ kind: 'start', options: { authorityEpoch: `local-${generation}`, roundId: `round-${state.round.value}`,
      dealer: state.dealer.value as 0 | 1 | 2 | 3, opening,
      winBeatMs: options.paceMs === 0 ? 0 : undefined,
      decisionMs: options.countdownEnabled === false ? Infinity : undefined } })
  }
  const opening = createLotusOpening({ state, automaticOpeningWin: false, clearTimers: () => {},
    takeTile: () => { state.wallHeadDrawn.value++; const tile = state.wall.value.shift() ?? null; dealerTile = tile; return tile },
    wait: delay => new Promise(resolve => {
      waiters.add(resolve); later(() => { waiters.delete(resolve); resolve() }, options.paceMs === 0 ? 0 : delay)
    }), later, playSound: sound, playSoundAndWait: safeSoundAndWait,
    announce: transient.announce, getRoundLabel: () => common.roundLabel.value,
    beginTurn: () => { void beginEngine() }, endGame: () => { throw new Error('Blood-flow cannot enter old endGame') },
    humanPlayerSeed: options.humanPlayerSeed, playerSeeds: options.aiPlayerSeeds,
  })
  function startGame(mode?: MatchType, startOptions: GameStartOptions & { initialWall?: TileType[]; openingDice?: [number, number]; openingSecondDice?: [number, number] } = {}) {
    if (options.externalAuthority) throw new Error('Only the room authority can start this game')
    clear(); opening.cancel(); options.animeFixedTts?.reset()
    view.value = null; waitScores.value = []; heardAction = 0; heardDiscard = ''; seenWindow = ''
    ring = startOptions.initialWall ? [...startOptions.initialWall] : buildRingWall(); dealerTile = null
    return opening.start(mode, { ...startOptions, initialWall: ring })
  }
  function nextRound(startOptions?: Parameters<typeof startGame>[1]) {
    if (state.phase.value !== 'settled' || state.matchFinished.value) return
    reactions.cancel(); cancelReactionSpeech()
    if (options.externalAuthority) return options.externalAuthority.nextRound()
    state.round.value++; state.dealer.value = (state.dealer.value + 1) % 4
    return startGame(undefined, startOptions)
  }
  function returnToLobby() { clear(); opening.cancel(); remoteOpeningId = ''; view.value = null; state.result.value = null; state.phase.value = 'lobby'; options.externalAuthority?.leave() }

  const moves = computed(() => view.value?.ownActions ?? [])
  const currentWaitInfo = computed<WaitInfo | null>(() => {
    if (!view.value || !waitScores.value.length) return null
    const visible = visibleTiles(view.value)
    const tiles = waitScores.value.map(w => ({ tile: w.tile, remaining: Math.max(0, 4 - visible.filter(t => t === w.tile).length) }))
    return { discard: null, tiles, any: tiles.length === 34, remaining: tiles.reduce((n, t) => n + t.remaining, 0) }
  })
  async function refreshWaits() {
    const current = view.value, w = current?.window, active = hintWorker, epoch = generation
    if (!active || !current || !w) return
    const player = current.players[current.seat], hand = player.hand
    const index = hand.length + 3 * player.melds.length === 14
      ? (state.selectedIndex.value >= 0 ? state.selectedIndex.value : player.drawnTileIndex) : null
    if (index !== null && index < 0) return
    try {
      const concealed = [...hand]
      if (index !== null) concealed.splice(index, 1)
      const waits = await active.waits({ concealed, melds: player.melds, jokers: current.jokers })
      if (epoch === generation && view.value?.window?.id === w.id) waitScores.value = waits
    } catch { /* closed worker has no current hint to publish */ }
  }
  function cancelReactionSpeech() {
    speechControllers.forEach(c => c.abort()); speechControllers.clear()
    roundBubbles.value = {}; speechChain = Promise.resolve()
  }
  function presentRoundReaction(line: BloodFlowReaction, signal?: AbortSignal): Promise<void> {
    const current = view.value, theme = options.getThemeName?.() ?? 'jade'
    if (!current?.public.roundResult || current.authorityEpoch !== line.authorityEpoch || current.roundId !== line.roundId
      || !bloodFlowReactionsAllowed(theme) || theme !== line.theme || spoken.has(line.id) || signal?.aborted) return Promise.resolve()
    spoken.add(line.id)
    const epoch = generation, controller = new AbortController()
    speechControllers.add(controller)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const isCurrent = () => epoch === generation && view.value?.roundId === line.roundId && !!view.value?.public.roundResult
      && options.getThemeName?.() === line.theme && !controller.signal.aborted
    const operation = speechChain.then(async () => {
      if (!isCurrent()) return
      const seat = (line.seat - current.seat + 4) % 4
      roundBubbles.value = { ...roundBubbles.value, [seat]: { text: line.text, id: ++bubbleSerial, persistent: true } }
      if (canPlayLocalLlmAudio()) await getLocalTtsClient().speak(seat, line.text, line.voiceKey, line.style, 'important',
        { isCurrent, signal: controller.signal, cacheIdentity: line.id, waitForCompletion: true })
    }).catch(() => {}).finally(() => { signal?.removeEventListener('abort', abort); speechControllers.delete(controller) })
    speechChain = operation
    return operation
  }
  async function acceptRemoteView(next: BloodFlowSeatView, meta: RemoteViewMeta) {
    if (!options.externalAuthority) throw new Error('This port owns a local authority')
    if (remoteOpeningId === next.roundId && next.public.status !== 'interrupted') {
      if (!meta.opening) pendingRemote = { view: next, meta }
      return
    }
    const changedRound = view.value?.roundId !== next.roundId || view.value?.authorityEpoch !== next.authorityEpoch
    if (changedRound || next.public.status === 'interrupted') {
      clear(); remoteOpeningId = ''; view.value = null; seenWindow = ''; waitScores.value = []
      state.revealHands.value = false; state.result.value = null
      hintWorker = next.public.status === 'interrupted' ? null : createEvaluatorService()
    }
    state.round.value = meta.round; state.matchType.value = meta.mode
    state.dealer.value = (meta.dealer - next.seat + 4) % 4
    if (changedRound || meta.replay) {
      presentationSerial.value++
      heardAction = next.actionEvents.at(-1)?.id ?? 0
      heardDiscard = next.lastDiscardAction?.id ?? ''
    }
    apply(next)
    if (!meta.opening || completedRemoteOpenings.has(next.roundId) || (!changedRound && !meta.replay) || next.public.status === 'interrupted') return
    remoteOpeningId = next.roundId
    const epoch = generation
    const finalPlayers = state.players.map(p => structuredClone(toRaw(p)))
    const wait = (ms: number) => new Promise<void>(resolve => {
      waiters.add(resolve); later(() => { waiters.delete(resolve); resolve() }, options.paceMs === 0 ? 0 : ms)
    })
    state.phase.value = 'dealing'; state.openingStage.value = 'start'
    state.wall.value = Array(136).fill('east'); state.wallHeadDrawn.value = 0
    state.flipStack.value = null; state.flipTile.value = null; state.jokerTiles.value = []
    state.players.forEach(p => { p.hand = []; p.concealedTileCount = 0; p.drawnTileIndex = -1 })
    sound('game_start.mp3'); await wait(1250); if (epoch !== generation) return
    state.diceThrowerIndex.value = state.dealer.value
    state.firstDice.value = meta.opening.firstDice; state.diceValues.value = meta.opening.firstDice
    state.openingStage.value = 'dice'; sound('dice.mp3'); await wait(1600); if (epoch !== generation) return
    state.flipStack.value = next.flipStack; state.flipTile.value = next.flipTile; state.jokerTiles.value = next.jokers
    state.wall.value = Array(134).fill('east'); state.openingStage.value = 'flip'
    await wait(1200); if (epoch !== generation) return
    state.diceThrowerIndex.value = (next.flipSeat - next.seat + 4) % 4
    state.secondDice.value = meta.opening.secondDice; state.diceValues.value = meta.opening.secondDice
    state.openingStage.value = 'dice'; sound('dice.mp3'); await wait(1600); if (epoch !== generation) return
    state.openingStage.value = 'deal'
    let dealt = 0
    const order = [0, 1, 2, 3].map(n => (state.dealer.value + n) % 4)
    const deal = async (seat: number, count: number) => {
      const player = state.players[seat], size = player.concealedTileCount! + count
      player.concealedTileCount = size
      if (seat === 0) player.hand = finalPlayers[0].hand.slice(0, size)
      dealt += count
      state.wall.value = Array(134 - dealt).fill('east'); state.wallHeadDrawn.value = dealt
      state.dealAnimation.value = { playerIndex: seat, count, serial: state.dealAnimation.value.serial + 1 }
      if (count === 4) sound('deal.mp3', .72)
      await wait(count === 4 ? 260 : 150)
    }
    for (let batch = 0; batch < 3; batch++) for (const seat of order) { await deal(seat, 4); if (epoch !== generation) return }
    for (const seat of order) { await deal(seat, seat === state.dealer.value ? 2 : 1); if (epoch !== generation) return }
    remoteOpeningId = ''; state.openingStage.value = null
    completedRemoteOpenings.add(next.roundId)
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: state.dealAnimation.value.serial + 1 }
    const buffered = pendingRemote; pendingRemote = null
    if (buffered) await acceptRemoteView(buffered.view, buffered.meta)
    else apply(next)
    options.externalAuthority.openingDone(meta.round)
  }
  watch(() => state.selectedIndex.value, () => { void refreshWaits() })
  const capabilities = computed(() => ({
    lotusTable: { flipTile: state.flipTile.value, jokerTiles: state.jokerTiles.value, wildcardTiles: ['white' as const],
      wallBreakIndex: state.wallBreakIndex.value, flipStack: state.flipStack.value },
    chi: { choose: (index: number) => { const chi = moves.value.filter(a => a.kind === 'chi')[index]; if (chi) send(chi) } },
    windKong: { available: moves.value.some(a => a.kind === 'wind-kong'), execute: () => send({ kind: 'wind-kong' }) },
    bloodFlow: view.value ? { ...view.value.public, preview: view.value.ownScore, waits: waitScores.value, presentationKey: String(presentationSerial.value), roundBubbles: roundBubbles.value } : null,
  }))
  if (getCurrentInstance()) onBeforeUnmount(returnToLobby)
  return defineGamePort({ ...state, ...common, capabilities,
    userCanHu: computed(() => moves.value.some(a => a.kind === 'win')),
    userKongs: computed(() => moves.value.flatMap(a => a.kind === 'concealed-kong' ? [a.tile]
      : a.kind === 'added-kong' ? [state.players[0].melds[a.meldIndex].tile] : [])),
    userCurrentWaits: currentWaitInfo, userDiscardWaits: currentWaitInfo, userTingOptions: computed(() => []),
    startGame, nextRound, returnToLobby, tileName,
    selectTile: (index: number) => { state.selectedIndex.value = index }, clearUserSelection: () => { state.selectedIndex.value = -1 },
    userDiscard: (index = state.selectedIndex.value) => send({ kind: 'discard', index }),
    userPass: () => send({ kind: 'pass' }), userHu: () => send({ kind: 'win' }), userPeng: () => send({ kind: 'peng' }),
    userGangFromDiscard: () => send({ kind: 'gang' }), userGang: (tile?: TileType) => {
      const action = moves.value.find(a => a.kind === 'concealed-kong' && a.tile === tile
        || a.kind === 'added-kong' && state.players[0].melds[a.meldIndex].tile === tile)
      if (action) send(action)
    }, refreshWaits, view, acceptRemoteView, presentRoundReaction, llmStats: decisions.stats, dispose: clear,
  })
}
