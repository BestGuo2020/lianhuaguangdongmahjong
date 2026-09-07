import { computed, getCurrentInstance, onBeforeUnmount, shallowRef, toRaw, watch } from 'vue'
import { defineGamePort } from '../../../core/contracts/gamePort'
import type { GameStartOptions, WaitInfo } from '../../../core/contracts/gamePort'
import type { MatchType, TableActionEvent, TileType } from '../../../core/contracts/types'
import { createLotusGameState } from '../lotusState'
import { createLotusOpening } from '../lotusOpening'
import { buildRingWall } from '../lotusWall'
import { createCommonGameSelectors } from '../../../shared/selectors/gameSelectors'
import { createMatchLifecycle } from '../../../shared/runtime/matchLifecycle'
import { MATCH_NAMES } from '../../../core/local/localGameConfig'
import { tileName } from '../../../core/rules/tiles'
import { playDiscardName } from '../../../shared/runtime/discardAudio'
import { createLocalTransientEventPresenter } from '../../../core/local/localTransientEventPresenter'
import { resolveAnimeAudioPolicy } from '../../../core/presentation/animeAudioPolicy'
import { isLocalLlmSeat } from '../../../core/presentation/localLlmVoiceRegistry'
import type { AnimeFixedTtsExecutor } from '../../../llm/animeFixedTtsExecutor'
import type { PlayerSeed } from '../../../shared/runtime/localOpening'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_TIMING } from './config'
import { createBloodFlowWorkerClient } from './workerClient'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import type { BloodFlowAction, BloodFlowOpeningState } from './state'
import type { EngineCommand } from './state'
import type { Seat, WinBatch } from './types'
import type { NetworkOpening } from './network/protocol'
import type { HandWaitHints, WaitScores } from '../patterns/handWaits'
import { createEvaluatorService } from '../patterns/evaluatorService'
import { createBloodFlowAudioBridge } from './audioBridge'
import { createBloodFlowDecisions, createBloodFlowReactions, bloodFlowReactionsAllowed, localBloodFlowProvider, type BloodFlowReaction } from '../../../llm/bloodFlowRuntime'
import { getLocalTtsClient, resolveLocalTtsVoiceKey } from '../../../llm/localTtsClient'
import { playLlmAudioGroup } from '../../../core/presentation/llmAudioBus'
import { canPlayLocalLlmAudio } from '../../../core/presentation/llmAudioBus'
import { createAnimeFixedTtsRequest } from '../../../llm/animeFixedTts'
import { animeVoiceKeyForTableAction } from '../../../llm/animeFixedTtsExecutor'
import { decisionSpeech } from '../../../llm/decisionSpeech'
import {actionSpeechMatches,type BloodFlowActionSpeech} from '../../../llm/bloodFlowSpeech'
import type {BloodFlowDiscardSpeech} from '../../../llm/bloodFlowSpeech'
import {playDecisionSpeech} from '../../../llm/decisionSpeechPlayback'
import {reasoningStatusSpeech} from '../../../llm/decisionSpeech'

export interface BloodFlowGameOptions {
  playSound?: (name: string, volume?: number) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  getThemeName?: () => string
  animeFixedTts?: AnimeFixedTtsExecutor
  humanPlayerSeed?: PlayerSeed
  aiPlayerSeeds?: PlayerSeed[]
  /** 本家可胡时未操作的自动胡牌延迟（默认 1000ms；<=0 关闭）。 */
  autoHuMs?: number
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
type RemoteViewMeta = { round: number; dealer: number; mode: MatchType; opening?: NetworkOpening; replay?: boolean; continuation?:{readySeats:Seat[];requiredSeats:Seat[]} }

export function useBloodFlowGame(options: BloodFlowGameOptions = {}) {
  const state = createLotusGameState()
  const common = createCommonGameSelectors(state, MATCH_NAMES)
  const view = shallowRef<BloodFlowSeatView | null>(null)
  const handHints = shallowRef<HandWaitHints | null>(null)
  const presentationSerial = shallowRef(0)
  const continuation = shallowRef<import('./types').BloodFlowTableState['continuation']>()
  const roundBubbles = shallowRef<Record<number, { text: string; id: number; persistent: boolean }>>({})
  const actionBubbles = shallowRef<Record<number, {text:string;id:number;persistent:boolean}>>({})
  const thinkingBubbles = shallowRef<Record<number, {text:string;id:number;persistent:boolean}>>({})
  const thinkingOwners = new Map<number,string>()
  const thinkingIds = new Map<string,number>()
  const thinkingSequences = new Map<number,number>()
  const decisions = createBloodFlowDecisions({theme:()=>options.getThemeName?.()??'jade',
    metadata:()=>({roundIndex:state.round.value,dealerIndex:state.dealer.value}),
    onStatus:(absoluteSeat,active,text,requestId,style,voiceKey)=>{
      if(!bloodFlowReactionsAllowed(options.getThemeName?.()??'jade'))return
      const seat=(absoluteSeat-(view.value?.seat??0)+4)%4
      if(active){
        // 同一次流式思考复用同一气泡节点（同一 requestId 同一 id），只替换文字；
        // 每个推理块都换新 id 会让 :key 重建节点并反复触发进出场过渡（闪烁），非血流按此复用。
        if(thinkingOwners.get(seat)!==requestId){
          thinkingOwners.set(seat,requestId)
          thinkingIds.set(requestId,++bubbleSerial)
        }
        // 无安全进度文本时为条件深思的开场：按性格轮换台词，与非血流 hooksForSeat 一致；
        // 安全进度到达后只更新气泡文字。
        const line=text??reasoningStatusSpeech(style,thinkingSequences.get(seat)??0)
        if(!text)thinkingSequences.set(seat,(thinkingSequences.get(seat)??0)+1)
        thinkingBubbles.value={...thinkingBubbles.value,[seat]:{text:line,id:thinkingIds.get(requestId)!,persistent:false}}
        // 开场性格台词与模型请求并行播报，不占决策预算；静音/失败静默降级。
        if(!text)void getLocalTtsClient().speak(absoluteSeat,line,voiceKey,style,'normal').catch(()=>false)
      }else if(thinkingOwners.get(seat)===requestId){thinkingOwners.delete(seat);thinkingIds.delete(requestId);const next={...thinkingBubbles.value};delete next[seat];thinkingBubbles.value=next}
    }})
  const actionSpoken=new Set<string>(),actionSpeechControllers=new Set<AbortController>()
  const pendingDiscardSpeech=new Map<AbortController,()=>boolean>()
  const pendingBots = new Set<string>(), spoken = new Set<string>(), speechControllers = new Set<AbortController>()
  let speechChain = Promise.resolve(), bubbleSerial = 0
  const reactions = createBloodFlowReactions({ theme: () => options.getThemeName?.() ?? 'jade',
    current: current => view.value?.authorityEpoch === current.authorityEpoch && view.value?.roundId === current.roundId && !!view.value?.public.roundResult,
    emit: (line, signal) => presentRoundReaction(line, signal),
  })
  let worker: ReturnType<typeof createBloodFlowWorkerClient> | null = null
  let hintWorker: ReturnType<typeof createEvaluatorService> | null = null
  let generation = 0, busy = false, heardAction = 0, heardDiscard = '', autoHuWindow = ''
  let waitQuerySerial = 0
  let hintKey = '', hintBusy = false
  let ring: TileType[] = [], dealerTile: TileType | null = null
  let remoteOpeningId = '', countdownTicket = 0
  let warnedCountdownWindow = ''
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
    continuation.value=undefined
    generation++; busy = false
    presentationSerial.value++
    remoteOpeningId = ''; countdownTicket++
    warnedCountdownWindow = ''
    completedRemoteOpenings.clear(); pendingRemote = null
    timers.forEach(clearTimeout); timers.clear()
    waiters.forEach(resolve => resolve()); waiters.clear()
    worker?.close(); worker = null
    hintWorker?.cancel(); hintWorker = null
    hintKey = ''; hintBusy = false; waitQuerySerial++; handHints.value = null
    actionAudio.reset()
    decisions.cancel(); pendingBots.clear(); reactions.cancel(); cancelReactionSpeech(); spoken.clear()
    cancelActionSpeech();actionSpoken.clear();seenWinBatches.clear();fixedVoiceEvents.clear()
  }
  const actionAudio = createBloodFlowAudioBridge({ epoch: () => `blood-flow:${generation}`, theme: () => options.getThemeName?.() ?? 'jade',
    player: index => state.players[index], fixed: options.animeFixedTts, play: sound })
  // 胡牌赢家语音统一调度（等语音播完再飞牌盖楼），动作事件声音仍走原桥。
  const winEventTypes = new Set<TableActionEvent['type']>(['self-draw', 'discard-win', 'robbed-kong-win'])
  const voiceActionTypes = new Set<TableActionEvent['type']>(['peng', 'chi', 'discard-gang', 'concealed-gang', 'added-gang', 'wind-kong'])
  const transient = createLocalTransientEventPresenter({ state, later, onTableAction: (event) => {
    if (winEventTypes.has(event.type)) return
    // llm 主题吃碰杠：动作音由模型台词 TTS 承担（用户指定），不播本地 mp3。
    if (options.getThemeName?.() === 'llm' && voiceActionTypes.has(event.type)) return
    actionAudio.present(event)
  } })
  const seenWinBatches = new Set<string>()
  const fixedVoiceEvents = new Set<number>()
  function playEffectUntilEnd(name: string): Promise<void> {
    const element = sound(name) as HTMLAudioElement | null | undefined
    if (!element || typeof (element as { addEventListener?: unknown }).addEventListener !== 'function') return Promise.resolve()
    if (element.ended) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const settle = () => resolve()
      element.addEventListener('ended', settle, { once: true })
      element.addEventListener('error', settle, { once: true })
    })
  }
  // 每个胡牌批次（单响/多响）赢家语音：llmAnime 用固定台词，其他主题大模型赢家用自己
  // 的台词 TTS（与非血流一致），其余赢家播 hu/zimo 效果音；全部播完设置语音闸门。
  function scheduleWinVoices(batch: WinBatch, snapshot: BloodFlowSeatView, delayMs: number) {
    const theme = options.getThemeName?.() ?? 'jade'
    const epoch = generation
    const toLocal = (seat: number) => (seat - snapshot.seat + 4) % 4
    const winType = (source: string): TableActionEvent['type'] => source === 'self-draw' || source === 'kong-bloom' ? 'self-draw'
      : source === 'robbed-kong' ? 'robbed-kong-win' : 'discard-win'
    const effectFile = (source: string) => source === 'self-draw' || source === 'kong-bloom' ? 'zimo.mp3' : 'hu.mp3'
    const tasks: (() => Promise<void>)[] = []
    if (theme === 'llmAnime') {
      for (const record of batch.winners) {
        const characterId = state.players[toLocal(record.winner)]?.characterId
        tasks.push(characterId ? (async () => {
          const request = createAnimeFixedTtsRequest(characterId, animeVoiceKeyForTableAction(winType(record.score.source)))
          const url = await getLocalTtsClient().resolveAudioUrl(request.normalizedText, request.voiceKey, request.style, request.cacheIdentity)
          if (url) await playLlmAudioGroup([{ url, seat: record.winner }])
          else await playEffectUntilEnd(effectFile(record.score.source))
        }) : () => playEffectUntilEnd(effectFile(record.score.source)))
      }
    } else {
      let sequence = 0
      for (const record of batch.winners) {
        const player = state.players[toLocal(record.winner)]
        const provider = player && (player.playerKind === 'llm' || player.isLlm) ? localBloodFlowProvider(record.winner) : null
        tasks.push(provider ? (async () => {
          // 台词与合成在模型做出胡牌决定的瞬间已完成（预合成），这里直接取用开播。
          const own = decisions.takeWinLine(batch.windowId, record.winner)
          const style = own?.style ?? provider.style
          const voiceKey = own?.voiceKey ?? resolveLocalTtsVoiceKey(provider)
          const text = own?.text ?? decisionSpeech({ kind: 'win' }, style, sequence++)
          const url = own?.urlPromise ? await own.urlPromise : await getLocalTtsClient().resolveAudioUrl(text, voiceKey, style)
          if (url) await playLlmAudioGroup([{ url, seat: record.winner }])
          else await playEffectUntilEnd(effectFile(record.score.source))
        }) : () => playEffectUntilEnd(effectFile(record.score.source)))
      }
    }
    later(() => {
      if (epoch !== generation) return
      void Promise.all(tasks.map(task => task()))
    }, delayMs)
  }
  watch(() => options.getThemeName?.(), () => { if (view.value) { actionAudio.reset(); presentationSerial.value++; reactions.cancel(); cancelReactionSpeech();cancelActionSpeech();decisions.cancelSpeech() } })

  function apply(next: BloodFlowSeatView) {
    const previous = view.value
    view.value = next
    for(const [controller,current] of pendingDiscardSpeech)if(!current())controller.abort()
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
    if (!previous || previous.window?.id !== next.window?.id
      || previous.players[next.seat].hand.join() !== next.players[next.seat].hand.join()) state.selectedIndex.value = -1
    const w = next.window, moves = next.ownActions
    state.phase.value = next.public.roundResult ? 'settled' : next.public.status !== 'playing' ? 'checking'
      : w && Date.now() < w.opensAt ? 'drawing' : w?.kind === 'turn'
      ? next.currentPlayer === next.seat ? 'discard' : 'thinking' : moves.length ? 'prompt' : 'checking'
    state.userDrewThisTurn.value = Boolean(w?.kind === 'turn' && next.currentPlayer === next.seat && next.public.status === 'playing')
    state.actionPrompt.value = w && w.kind !== 'turn' && moves.length ? {
      type: w.source.kind === 'added-kong' ? 'rob' : 'response',
      from: toLocal(w.source.seat), tile: w.source.tile, canHu: moves.some(a => a.kind === 'win'),
      canGang: moves.some(a => a.kind === 'gang'), canPeng: moves.some(a => a.kind === 'peng'),
      chiOptions: moves.flatMap(a => a.kind === 'chi' ? [{ tiles: a.tiles, kind: 'sequence' as const }] : []),
    } : null
    // 本家可胡时不再提供“过”：窗口开放超过 autoHuMs 毫秒未操作则自动胡牌（默认 1 秒；<=0 关闭）。
    if (w && next.public.status === 'playing' && moves.some(a => a.kind === 'win') && !options.autoplay && (options.autoHuMs ?? 1000) > 0 && w.id !== autoHuWindow) {
      autoHuWindow = w.id
      later(() => {
        if (autoHuWindow !== w.id) return
        const cur = view.value
        if (!cur || cur.window?.id !== w.id || cur.public.status !== 'playing') return
        if (cur.ownActions.some(a => a.kind === 'win')) send({ kind: 'win' })
      }, Math.max(0, w.opensAt - Date.now() + (options.autoHuMs ?? 1000)))
    }
    if (next.lastDiscardAction && next.lastDiscardAction.id !== heardDiscard) {
      heardDiscard = next.lastDiscardAction.id
      const d = next.lastDiscardAction, player = state.players[toLocal(d.seat)]
      state.lastDiscard.value = { tile: d.tile, from: toLocal(d.seat), id: next.version }
      sound('dapai.mp3', 0.8)
      const route = resolveAnimeAudioPolicy({ themeName: options.getThemeName?.(), playerKind: player.playerKind, isLlm: player.isLlm })
      const llmSeat = options.externalAuthority ? player.playerKind === 'llm' || player.isLlm : isLocalLlmSeat(d.seat)
      const epoch = generation
      state.lastDiscardSound.value = !llmSeat && route.discard.tileName !== 'suppress'
        ? playDiscardName(d.tile, { playSound: sound, playSoundAndWait: options.playSoundAndWait,
          current: () => epoch === generation }) : Promise.resolve()
    }
    // 胡牌批次：赢家语音统一调度；一炮多响在 1.5s 特效字之后同一拍开始。
    const newestBatch = next.public.batches.at(-1)
    const pendingWin = newestBatch && !seenWinBatches.has(newestBatch.batchId) ? newestBatch : null
    if (pendingWin) seenWinBatches.add(pendingWin.batchId)
    const multiWin = pendingWin && pendingWin.source.kind === 'discard' && pendingWin.winners.length > 1
    const themeName = options.getThemeName?.() ?? 'jade'
    for (const action of next.actionEvents) if (action.id > heardAction) {
      heardAction = action.id
      if (winEventTypes.has(action.type)) continue
      // llmAnime 吃碰杠：固定台词与模型台词谁先到谁播 TTS（固定台词随事件即到，先声夺人）。
      if (themeName === 'llmAnime' && voiceActionTypes.has(action.type)) fixedVoiceEvents.add(action.id)
      transient.showTableAction(action.type, toLocal(action.actorIndex), action.sourceIndex === null ? null : toLocal(action.sourceIndex), action.tile, action.meldIndex)
    }
    if (pendingWin) scheduleWinVoices(pendingWin, next, multiWin ? BLOOD_FLOW_TIMING.multiWinIntroMs : 0)
    if(!options.externalAuthority)for(const line of decisions.observe(next))void presentActionSpeech(line)
    if (next.public.roundResult) {
      cancelActionSpeech()
      const result = next.public.roundResult
      state.revealHands.value = true
      state.result.value = { winner: '本局结束', draw: result.winCounts.every(n => n === 0), roundLabel: common.roundLabel.value,
        scoreChanges: state.players.map((p, i) => ({ playerIndex: i, name: p.name, avatar: p.avatar, delta: result.endingScores[p.seat] - result.openingScores[p.seat], score: p.score })) }
      state.matchFinished.value = state.round.value >= BLOOD_FLOW_CONFIG.rounds[state.matchType.value]
      if (!options.externalAuthority) void reactions.run(next)
    }
    void refreshWaits()
    if (previous && (next.transition?.kind === 'draw' && next.transition.id !== previous.transition?.id
      || w?.kind === 'turn' && w.source.id !== previous.window?.source.id && previous.transition?.kind !== 'draw')
      && next.players[next.currentPlayer].drawnTileIndex >= 0) sound('give.mp3', .7)
    const ticket = ++countdownTicket
    const updateCountdown = () => {
      if (ticket !== countdownTicket) return
      state.turnSeconds.value = w && Date.now() >= w.opensAt && moves.length && options.countdownEnabled !== false && Number.isFinite(w.deadlineAt)
        ? Math.max(0, Math.ceil((w.deadlineAt - Date.now()) / 1000)) : 0
      if (w && state.turnSeconds.value > 0 && state.turnSeconds.value <= 3 && warnedCountdownWindow !== w.id) {
        warnedCountdownWindow = w.id
        sound('didu.ogg')
      }
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
    if (current?.transition && current.public.status === 'playing') {
      const stage = current.transition
      later(() => {
        const advance = () => { if (view.value?.transition?.id === stage.id) void request({ kind: 'advance', transitionId: stage.id }) }
        // Reuse the actual tile-name completion, bounded for unavailable audio/TTS.
        if (stage.kind === 'discard') {
          let done = false
          const once = () => { if (!done) { done = true; advance() } }
          void state.lastDiscardSound.value?.then(once, once)
          later(once, 1500)
        } else advance()
      }, Math.max(0, stage.readyAt - Date.now()))
      return
    }
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
      && Date.now() < view.value.window.deadlineAt
    try {
      const own = await active.request<BloodFlowSeatView>({ kind: 'view', seat })
      if (!current() || own.window?.id !== windowId) return
      const action = await decisions.decide(own, current)
      if (!current()) return
      if(action?.kind==='discard'){
        const line=decisions.prepareDiscard(own,action)
        if(line)await presentDiscardSpeech(line,current)
      }
      // Audio may have waited across a deadline, leave, or authority refresh.
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
    if (!current || !w || !current.ownActions.some(move => JSON.stringify(move) === JSON.stringify(action))) return
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
      paced: options.paceMs !== 0,
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
    view.value = null; heardAction = 0; heardDiscard = ''; autoHuWindow = ''
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
  const matchLifecycle = createMatchLifecycle({ state, clearTimers: clear, startGame })
  function returnToLobby() {
    decisions.resetReasoning()
    opening.cancel()
    // The shared cleanup removes players, unmounting the old HUD/3D table.
    // The next lobby start must mount a fresh table and receive its ready event.
    matchLifecycle.returnToLobby()
    remoteOpeningId = ''; view.value = null
    options.externalAuthority?.leave()
  }

  const moves = computed(() => view.value?.ownActions ?? [])
  const hintsVisible = computed(() => view.value?.public.status === 'playing' && view.value.transition?.kind !== 'win')
  function makeWaitInfo(scores: WaitScores, discard: TileType | null = null): WaitInfo | null {
    if (!view.value || !hintsVisible.value || !scores.length) return null
    const visible = visibleTiles(view.value)
    const tiles = scores.map(w => ({ tile: w.tile, remaining: Math.max(0, 4 - visible.filter(t => t === w.tile).length) }))
    return { discard, tiles, any: tiles.length === 34, remaining: tiles.reduce((n, t) => n + t.remaining, 0) }
  }
  const currentWaitInfo = computed(() => makeWaitInfo(handHints.value?.current ?? []))
  const userTingOptions = computed(() => !common.isUserTurn.value ? [] : (handHints.value?.discards ?? []).flatMap(item => {
    const legal = moves.value.some(a => a.kind === 'discard' && state.players[0].hand[a.index] === item.discard)
    const info = legal ? makeWaitInfo(item.waits, item.discard) : null
    return info ? [info] : []
  }))
  const userDiscardWaits = computed(() => state.selectedIndex.value < 0 ? null
    : userTingOptions.value.find(item => item.discard === state.players[0]?.hand[state.selectedIndex.value]) ?? null)
  const waitScores = computed(() => {
    const discard = userDiscardWaits.value?.discard
    return (discard ? handHints.value?.discards.find(item => item.discard === discard)?.waits : handHints.value?.current) ?? []
  })
  async function refreshWaits() {
    const current = view.value
    if (!hintWorker || !current || current.public.status !== 'playing' || options.autoplay) return
    const player = current.players[current.seat]
    const input = { concealed: [...player.hand], melds: player.melds, jokers: current.jokers,
      drawnTileIndex: player.drawnTileIndex, locked: current.public.seats[current.seat].locked }
    const key = JSON.stringify([current.authorityEpoch, current.roundId, input])
    if (key === hintKey) return
    hintKey = key; handHints.value = null
    // A changed hand supersedes unfinished work; selection and opponent windows
    // reuse the same results instead of queueing exhaustive searches behind it.
    if (hintBusy) { hintWorker.cancel(); hintWorker = createEvaluatorService() }
    const query = ++waitQuerySerial
    const active = hintWorker, epoch = generation
    hintBusy = true
    try {
      const hints = await active.handWaits(input)
      if (query === waitQuerySerial && epoch === generation && hintKey === key) handHints.value = hints
    } catch { /* closed worker has no current hint to publish */ }
    finally { if (query === waitQuerySerial) hintBusy = false }
  }
  function cancelReactionSpeech() {
    speechControllers.forEach(c => c.abort()); speechControllers.clear()
    roundBubbles.value = {}; speechChain = Promise.resolve()
  }
  function cancelActionSpeech(){actionSpeechControllers.forEach(c=>c.abort());actionSpeechControllers.clear();pendingDiscardSpeech.clear();actionBubbles.value={};thinkingOwners.clear();thinkingIds.clear();thinkingBubbles.value={}}
  async function presentDiscardSpeech(line:BloodFlowDiscardSpeech,current:()=>boolean):Promise<void>{
    if(!current()||actionSpoken.has(line.id))return
    actionSpoken.add(line.id)
    const controller=new AbortController(),epoch=generation,seat=(line.seat-(view.value?.seat??0)+4)%4
    actionSpeechControllers.add(controller);pendingDiscardSpeech.set(controller,current)
    const alive=()=>epoch===generation&&view.value?.roundId===line.roundId&&!view.value.public.roundResult
      &&options.getThemeName?.()===line.theme&&!controller.signal.aborted
    const showBubble=()=>{
      if(!alive())return
      const id=++bubbleSerial
      actionBubbles.value={...actionBubbles.value,[seat]:{text:line.text,id,persistent:false}}
      later(()=>{if(actionBubbles.value[seat]?.id===id){const copy={...actionBubbles.value};delete copy[seat];actionBubbles.value=copy}},5000)
    }
    let played=false
    try{played=await playDecisionSpeech({seat,text:line.text,voiceKey:line.voiceKey,style:line.style,priority:'normal',
      signal:controller.signal,isCurrent:alive,showBubble})}
    finally{
      pendingDiscardSpeech.delete(controller)
      // Keep successful playback cancellable through its second half, until
      // round/leave cleanup. The set is bounded by this round's action lines.
      if(!played)actionSpeechControllers.delete(controller)
    }
  }
  async function presentActionSpeech(line:BloodFlowActionSpeech):Promise<void>{
    const current=view.value,theme=options.getThemeName?.()??'jade'
    if(!current||theme!==line.theme||!bloodFlowReactionsAllowed(theme)||actionSpoken.has(line.id)||!actionSpeechMatches(line,current))return
    actionSpoken.add(line.id)
    const seat=(line.seat-current.seat+4)%4,id=++bubbleSerial,epoch=generation
    actionBubbles.value={...actionBubbles.value,[seat]:{text:line.text,id,persistent:false}}
    later(()=>{if(actionBubbles.value[seat]?.id===id){const copy={...actionBubbles.value};delete copy[seat];actionBubbles.value=copy}},5000)
    // 吃碰杠人声：llmAnime 固定台词随事件先到并已播其 TTS，模型台词只保留气泡；
    // llm 主题播模型台词 TTS（用户指定，不播本地 mp3）；其他主题保持原动作音。
    if(line.eventKind==='action'){
      if(line.theme==='llmAnime'&&fixedVoiceEvents.has(Number(line.eventId)))return
      if(line.theme!=='llm'||!canPlayLocalLlmAudio())return
      const controller=new AbortController();actionSpeechControllers.add(controller)
      const isCurrent=()=>generation===epoch&&view.value?.roundId===line.roundId&&!view.value.public.roundResult&&options.getThemeName?.()===line.theme&&!controller.signal.aborted
      // Event IDs only deduplicate playback; ordinary speech uses the gateway's content cache.
      try{await getLocalTtsClient().speak(seat,line.text,line.voiceKey,line.style,'normal',{signal:controller.signal,isCurrent})}catch{/* text remains usable without voice */}
      finally{actionSpeechControllers.delete(controller)}
      return
    }
    // 普通弃牌吐槽 TTS（动作音与吃碰杠人声已在上方分支处理）。
    if(!canPlayLocalLlmAudio())return
    const route=resolveAnimeAudioPolicy({themeName:theme,playerKind:'llm'})
    if(route.discard.commentary==='suppress')return
    const controller=new AbortController();actionSpeechControllers.add(controller)
    const isCurrent=()=>generation===epoch&&view.value?.roundId===line.roundId&&!view.value.public.roundResult&&options.getThemeName?.()===line.theme&&!controller.signal.aborted
    // Event IDs only deduplicate playback; ordinary speech uses the gateway's content cache.
    try{await getLocalTtsClient().speak(seat,line.text,line.voiceKey,line.style,'normal',{signal:controller.signal,isCurrent})}catch{/* text remains usable without voice */}
    finally{actionSpeechControllers.delete(controller)}
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
        { isCurrent, signal: controller.signal, waitForCompletion: true })
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
      clear(); remoteOpeningId = ''; view.value = null
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
    continuation.value=meta.continuation?{...meta.continuation,ready:meta.continuation.readySeats.includes(next.seat)}:undefined
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
  const capabilities = computed(() => ({
    lotusTable: { flipTile: state.flipTile.value, jokerTiles: state.jokerTiles.value, wildcardTiles: ['white' as const],
      wallBreakIndex: state.wallBreakIndex.value, flipStack: state.flipStack.value },
    chi: { choose: (index: number) => { const chi = moves.value.filter(a => a.kind === 'chi')[index]; if (chi) send(chi) } },
    windKong: { available: moves.value.some(a => a.kind === 'wind-kong'), execute: () => send({ kind: 'wind-kong' }) },
    bloodFlow: view.value ? { ...view.value.public, waits: waitScores.value,
      discardWaitScores: Object.fromEntries((handHints.value?.discards ?? []).map(item => [item.discard, item.waits])),
      presentationKey: String(presentationSerial.value), roundBubbles: roundBubbles.value, actionBubbles:{...actionBubbles.value,...thinkingBubbles.value}, continuation:continuation.value, sourceEvent:view.value.window?.source, kongEvents:view.value.kongEvents } : null,
  }))
  if (getCurrentInstance()) onBeforeUnmount(returnToLobby)
  return defineGamePort({ ...state, ...common, capabilities,
    userCanHu: computed(() => moves.value.some(a => a.kind === 'win')),
    userKongs: computed(() => moves.value.flatMap(a => a.kind === 'concealed-kong' ? [a.tile]
      : a.kind === 'added-kong' ? [state.players[0].melds[a.meldIndex].tile] : [])),
    userCurrentWaits: currentWaitInfo,
    userDiscardWaits, userTingOptions,
    startGame, nextRound, returnToLobby, tileName,
    selectTile: (index: number) => {
      if (!moves.value.some(a => a.kind === 'discard' && a.index === index)) return
      if (state.selectedIndex.value !== index) sound('click.mp3', .55)
      state.selectedIndex.value = index
    }, clearUserSelection: () => { state.selectedIndex.value = -1 },
    userDiscard: (index = state.selectedIndex.value) => send({ kind: 'discard', index }),
    userPass: () => send({ kind: 'pass' }), userHu: () => send({ kind: 'win' }), userPeng: () => send({ kind: 'peng' }),
    userGangFromDiscard: () => send({ kind: 'gang' }), userGang: (tile?: TileType) => {
      const action = moves.value.find(a => a.kind === 'concealed-kong' && a.tile === tile
        || a.kind === 'added-kong' && state.players[0].melds[a.meldIndex].tile === tile)
      if (action) send(action)
    }, refreshWaits, view, acceptRemoteView, presentRoundReaction, presentActionSpeech, llmStats: decisions.stats, dispose: clear,
  })
}
