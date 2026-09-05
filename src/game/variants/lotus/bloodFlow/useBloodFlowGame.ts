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
import type { AnimeFixedTtsExecutor, AnimeSeat } from '../../../llm/animeFixedTtsExecutor'
import { animeFallbackAudioForAction } from '../../../llm/animeFixedTtsExecutor'
import type { PlayerSeed } from '../../../shared/runtime/localOpening'
import { BLOOD_FLOW_CONFIG } from './config'
import { createBloodFlowWorkerClient } from './workerClient'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import type { BloodFlowAction, BloodFlowOpeningState } from './state'
import type { evaluateWaits } from '../patterns/evaluate'
import { createEvaluatorService } from '../patterns/evaluatorService'

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
}

export function useBloodFlowGame(options: BloodFlowGameOptions = {}) {
  const state = createLotusGameState()
  const common = createCommonGameSelectors(state, MATCH_NAMES)
  const view = shallowRef<BloodFlowSeatView | null>(null)
  const waitScores = shallowRef<ReturnType<typeof evaluateWaits>>([])
  let worker: ReturnType<typeof createBloodFlowWorkerClient> | null = null
  let hintWorker: ReturnType<typeof createEvaluatorService> | null = null
  let generation = 0, busy = false, heardAction = 0, heardDiscard = '', seenWindow = ''
  let ring: TileType[] = [], dealerTile: TileType | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const waiters = new Set<() => void>()
  const sound = options.playSound ?? (() => {})
  function later(callback: () => void, delay: number) {
    const epoch = generation
    const id = setTimeout(() => { timers.delete(id); if (epoch === generation) callback() }, delay)
    timers.add(id)
    return id as unknown as number
  }
  function clear() {
    generation++; busy = false
    timers.forEach(clearTimeout); timers.clear()
    waiters.forEach(resolve => resolve()); waiters.clear()
    worker?.close(); worker = null
    hintWorker?.cancel(); hintWorker = null
    options.animeFixedTts?.cancel()
  }
  const transient = createLocalTransientEventPresenter({ state, later, onTableAction: event => {
    const route = resolveAnimeAudioPolicy({ themeName: options.getThemeName?.(), playerKind: 'unknown' })
    if (route.actionVoice === 'fixed-line' && options.animeFixedTts) {
      const epoch = generation
      void options.animeFixedTts.executeAction({ eventId: `blood-flow:${generation}:${event.id}`,
        seat: event.actorIndex as AnimeSeat, characterId: state.players[event.actorIndex]?.characterId, action: event.type })
        .then(result => { if (epoch === generation && result.fallbackAudioFile) sound(result.fallbackAudioFile) }).catch(() => {})
    } else {
      const audio = animeFallbackAudioForAction(event.type)
      if (audio) sound(audio)
    }
  } })

  function apply(next: BloodFlowSeatView) {
    view.value = next
    const seeds = [options.humanPlayerSeed, ...(options.aiPlayerSeeds ?? [])]
    state.players.splice(0, state.players.length, ...next.players.map((p, i) => ({ ...p,
      name: seeds[i]?.name ?? p.name, avatar: seeds[i]?.avatar ?? p.avatar,
      characterId: seeds[i]?.characterId ?? p.characterId, playerKind: seeds[i]?.playerKind ?? (i === 0 ? 'human' : 'bot') })))
    // Only public count placeholders reach the renderer; the actual wall stays in worker.
    state.wall.value = Array(next.wallCount).fill('east')
    state.wallHeadDrawn.value = next.headDrawn; state.currentPlayer.value = next.currentPlayer
    state.flipTile.value = next.flipTile; state.jokerTiles.value = next.jokers
    state.flipStack.value = next.flipStack; state.flipSeat.value = next.flipSeat; state.wallBreakIndex.value = next.wallBreakIndex
    state.selectedIndex.value = -1
    const w = next.window, moves = next.ownActions
    state.phase.value = next.public.roundResult ? 'settled' : w?.kind === 'turn'
      ? next.currentPlayer === 0 ? 'discard' : 'thinking' : moves.length ? 'prompt' : 'checking'
    state.userDrewThisTurn.value = Boolean(w?.kind === 'turn' && next.currentPlayer === 0)
    state.actionPrompt.value = w && w.kind !== 'turn' && moves.length ? {
      type: moves.some(a => a.kind === 'win') ? w.source.kind === 'added-kong' ? 'rob' : 'hu' : 'response',
      from: w.source.seat, tile: w.source.tile, canHu: moves.some(a => a.kind === 'win'),
      canGang: moves.some(a => a.kind === 'gang'), canPeng: moves.some(a => a.kind === 'peng'),
      chiOptions: moves.flatMap(a => a.kind === 'chi' ? [{ tiles: a.tiles, kind: 'sequence' as const }] : []),
    } : null
    if (next.lastDiscardAction && next.lastDiscardAction.id !== heardDiscard) {
      heardDiscard = next.lastDiscardAction.id
      const d = next.lastDiscardAction, player = state.players[d.seat]
      state.lastDiscard.value = { tile: d.tile, from: d.seat, id: next.version }
      sound('dapai.mp3', 0.8)
      const route = resolveAnimeAudioPolicy({ themeName: options.getThemeName?.(), playerKind: player.playerKind, isLlm: player.isLlm })
      if (!isLocalLlmSeat(d.seat) && route.discard.tileName !== 'suppress') later(() => sound(tileAudioFile(d.tile)), 80)
    }
    for (const action of next.actionEvents) if (action.id > heardAction) {
      heardAction = action.id
      transient.showTableAction(action.type, action.actorIndex, action.sourceIndex, action.tile, action.meldIndex)
    }
    if (next.public.roundResult) {
      const result = next.public.roundResult
      state.revealHands.value = true
      state.result.value = { winner: '本局结束', draw: result.winCounts.every(n => n === 0), roundLabel: common.roundLabel.value,
        scoreChanges: state.players.map((p, i) => ({ playerIndex: i, name: p.name, avatar: p.avatar, delta: result.endingScores[i] - result.openingScores[i], score: p.score })) }
      state.matchFinished.value = state.round.value >= BLOOD_FLOW_CONFIG.rounds[state.matchType.value]
    }
    if (w?.id !== seenWindow) { seenWindow = w?.id ?? ''; waitScores.value = []; if (next.ownActions.length) void refreshWaits() }
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
    const current = view.value, w = current?.window
    if (!current || !w || current.public.status !== 'playing') return
    const epoch = generation
    const bot = current.waitingSeats.find(s => s !== 0 || options.autoplay)
    if (bot !== undefined) later(() => {
      if (epoch === generation && view.value?.window?.id === w.id) void request({ kind: 'bot', seat: bot, windowId: w.id })
    }, options.paceMs ?? 650)
    if (w.deadlineAt < Number.MAX_SAFE_INTEGER) later(() => {
      if (view.value?.window?.id === w.id) void request({ kind: 'expire', windowId: w.id })
    }, Math.max(0, w.deadlineAt - Date.now()))
  }
  function send(action: BloodFlowAction) {
    const current = view.value, w = current?.window
    if (!current || !w) return
    void request({ kind: 'command', command: { authorityEpoch: current.authorityEpoch, roundId: current.roundId,
      stateVersion: w.version, windowId: w.id, seat: 0, action } })
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
      decisionMs: options.countdownEnabled === false ? Infinity : undefined } })
  }
  const opening = createLotusOpening({ state, automaticOpeningWin: false, clearTimers: () => {},
    takeTile: () => { state.wallHeadDrawn.value++; const tile = state.wall.value.shift() ?? null; dealerTile = tile; return tile },
    wait: delay => new Promise(resolve => {
      waiters.add(resolve); later(() => { waiters.delete(resolve); resolve() }, options.paceMs === 0 ? 0 : delay)
    }), later, playSound: sound, playSoundAndWait: options.playSoundAndWait ?? (async () => {}),
    announce: transient.announce, getRoundLabel: () => common.roundLabel.value,
    beginTurn: () => { void beginEngine() }, endGame: () => { throw new Error('Blood-flow cannot enter old endGame') },
    humanPlayerSeed: options.humanPlayerSeed, playerSeeds: options.aiPlayerSeeds,
  })
  function startGame(mode?: MatchType, startOptions: GameStartOptions & { initialWall?: TileType[]; openingDice?: [number, number]; openingSecondDice?: [number, number] } = {}) {
    clear(); opening.cancel(); options.animeFixedTts?.reset()
    view.value = null; waitScores.value = []; heardAction = 0; heardDiscard = ''; seenWindow = ''
    ring = startOptions.initialWall ? [...startOptions.initialWall] : buildRingWall(); dealerTile = null
    return opening.start(mode, { ...startOptions, initialWall: ring })
  }
  function nextRound(startOptions?: Parameters<typeof startGame>[1]) {
    if (state.phase.value !== 'settled' || state.matchFinished.value) return
    state.round.value++; state.dealer.value = (state.dealer.value + 1) % 4
    return startGame(undefined, startOptions)
  }
  function returnToLobby() { clear(); opening.cancel(); view.value = null; state.result.value = null; state.phase.value = 'lobby' }

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
    const hand = current.players[0].hand
    const index = hand.length + 3 * current.players[0].melds.length === 14
      ? (state.selectedIndex.value >= 0 ? state.selectedIndex.value : current.players[0].drawnTileIndex) : null
    if (index !== null && index < 0) return
    try {
      const concealed = [...hand]
      if (index !== null) concealed.splice(index, 1)
      const waits = await active.waits({ concealed, melds: current.players[0].melds, jokers: current.jokers })
      if (epoch === generation && view.value?.window?.id === w.id) waitScores.value = waits
    } catch { /* closed worker has no current hint to publish */ }
  }
  watch(() => state.selectedIndex.value, () => { void refreshWaits() })
  const capabilities = computed(() => ({
    lotusTable: { flipTile: state.flipTile.value, jokerTiles: state.jokerTiles.value, wildcardTiles: ['white' as const],
      wallBreakIndex: state.wallBreakIndex.value, flipStack: state.flipStack.value },
    chi: { choose: (index: number) => { const chi = moves.value.filter(a => a.kind === 'chi')[index]; if (chi) send(chi) } },
    windKong: { available: moves.value.some(a => a.kind === 'wind-kong'), execute: () => send({ kind: 'wind-kong' }) },
    bloodFlow: view.value ? { ...view.value.public, preview: view.value.ownScore, waits: waitScores.value } : null,
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
    }, refreshWaits, view,
  })
}
