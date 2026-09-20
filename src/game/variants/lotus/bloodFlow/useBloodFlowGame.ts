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
import { defaultAvatarForSeat } from '../../../core/presentation/avatar'
import { isLocalLlmSeat } from '../../../core/presentation/localLlmVoiceRegistry'
import { activeBgmTrackPort } from '../../../core/presentation/useAudio'
import type { AnimeFixedTtsExecutor } from '../../../llm/animeFixedTtsExecutor'
import type { PlayerSeed } from '../../../shared/runtime/localOpening'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_LLM_AI, BLOOD_FLOW_TIMING } from './config'
import { createBloodFlowWorkerClient } from './workerClient'
import type { BloodFlowSeatView } from './seatView'
import { visibleTiles } from './seatView'
import { computeReformHint } from './reformHint'
import { createBloodFlowWinMusic, totalBloodFlowWinTiles } from './winMusic'
import type { WinMusicBgmPort, WinMusicState } from './winMusic'
import type { BloodFlowAction, BloodFlowOpeningState } from './state'
import type { EngineCommand } from './state'
import type { BloodFlowTableState, Seat, WinBatch } from './types'
import type { NetworkOpening } from './network/protocol'
import type { HandWaitHints, WaitScores } from '../patterns/handWaits'
import { createEvaluatorService } from '../patterns/evaluatorService'
import { createBloodFlowAudioBridge } from './audioBridge'
import { createBloodFlowDecisions, createBloodFlowReactions, bloodFlowReactionsAllowed, localBloodFlowProvider, previousBloodFlowWin, remoteVoiceIdentity, type BloodFlowReaction } from '../../../llm/bloodFlowRuntime'
import type { LlmStyle, LlmTtsVoiceKey } from '../../../llm/config'
import { getLocalTtsClient, resolveLocalTtsVoiceKey } from '../../../llm/localTtsClient'
import { playLlmAudioGroup } from '../../../core/presentation/llmAudioBus'
import { canPlayLocalLlmAudio } from '../../../core/presentation/llmAudioBus'
import { createAnimeFixedTtsRequest } from '../../../llm/animeFixedTts'
import { animeVoiceKeyForTableAction } from '../../../llm/animeFixedTtsExecutor'
import { animeWinActionVoiceKey, type AnimeActionVoiceKey } from '../../../llm/animeCharacters'
import { bloodFlowWinMomentIsBig, bloodFlowWinMomentLine } from '../../../llm/bloodFlowWinLines'
import { actionSpeechMatches,type BloodFlowActionSpeech} from '../../../llm/bloodFlowSpeech'
import { shouldSuppressLegacyAnimeSpeech } from '../../../core/presentation/animeAudioPolicy'
import type { BloodFlowWsAudio, BloodFlowWsSpeech } from './ws/authority'
import type {BloodFlowDiscardSpeech} from '../../../llm/bloodFlowSpeech'
import {playDecisionSpeech} from '../../../llm/decisionSpeechPlayback'
import {reasoningStatusSpeech} from '../../../llm/decisionSpeech'
import { createBloodFlowRecordState, recordBloodFlowSettle, recordBloodFlowView, type BloodFlowRecordContext } from '../../../replay/bloodFlowRecorder'
import type { ReplayRecorderHooks } from '../../../replay/types'
import {
  choiceTookEffect, decisionStateOf, legalActionId, seatLegalActions, settlementsFromView, windowKindOf,
  type BloodFlowLedgerViewLike,
  type BloodFlowViewLike,
} from '../../../replay/analysis/bloodFlowAdapter'
import type { AnalysisRecorder } from '../../../replay/analysis/recorder'
import { createBloodFlowDecisionSink } from '../../../replay/analysis/decisionSink'

export interface BloodFlowGameOptions {
  playSound?: (name: string, volume?: number) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  /** 全场胡牌张数到阈值时换 BGM（HuMusic.ogg），局末切回默认；过渡曲线由音频层负责。 */
  bgm?: WinMusicBgmPort
  /** 服务端 TTS 音频通道（联机模型原话）：与经典联机共用同一条 llm 音频队列。 */
  playLlmAudio?: (url: string, seat: number, messageId: number, priority?: 'normal' | 'important') => void
  getThemeName?: () => string
  animeFixedTts?: AnimeFixedTtsExecutor
  humanPlayerSeed?: PlayerSeed
  aiPlayerSeeds?: PlayerSeed[]
  /** 胡后无杠可选时的自动胡/摸打/过延迟（默认 800ms；<=0 关闭）；有杠则等完整决策窗口。 */
  lockedAutoPlayMs?: number
  /** Explicit test option: authority still uses the actual worker and rules engine. */
  autoplay?: boolean
  paceMs?: number
  countdownEnabled?: boolean
  /** 对局回放录制钩子（可选；不传时零行为变化，且不会请求旁观视角）。 */
  recorder?: ReplayRecorderHooks
  /**
   * AI 分析记录（可选；方案 docs/blood-flow/design/replay-ai-analysis-recording.md）。
   * 只旁路采集当时已有的信息：不传时零成本空转，不影响策略动作与对局结果（§10.1、§10.7）。
   */
  analysis?: AnalysisRecorder | null
  externalAuthority?: {
    send(command: EngineCommand): void
    nextRound(): void
    leave(): void
    openingDone(round: number): void
  }
}
type RemoteViewMeta = { round: number; dealer: number; mode: MatchType; opening?: NetworkOpening; replay?: boolean; continuation?:{readySeats:Seat[];requiredSeats:Seat[]} }

/** worker 回复：座位视角，录制开启时额外带一份旁观视角（本地专用）。 */
type BloodFlowWorkerView = BloodFlowSeatView & { replay?: BloodFlowSeatView }

export function useBloodFlowGame(options: BloodFlowGameOptions = {}) {
  const state = createLotusGameState()
  const common = createCommonGameSelectors(state, MATCH_NAMES)
  const view = shallowRef<BloodFlowSeatView | null>(null)
  /** 对局回放：血流旁观视角的增量状态（仅录制开启时使用）。 */
  const replayRecordState = createBloodFlowRecordState()
  /** 把一份旁观视角折成回放事件（录制关闭时为零成本空操作）。 */
  function recordReplaySpectator(spectator: BloodFlowSeatView) {
    const recorder = options.recorder
    if (!recorder) return
    recordBloodFlowView(recorder, spectator, replayContext(), replayRecordState)
  }
  /** 局末收尾（幂等）：旁观视角与座位视角两条链都调用它。 */
  function recordReplaySettle(view: BloodFlowSeatView) {
    const recorder = options.recorder
    if (!recorder) return
    recordBloodFlowSettle(recorder, view, replayContext(), replayRecordState)
  }
  function replayContext(): BloodFlowRecordContext {
    return {
      matchType: state.matchType.value,
      round: state.round.value,
      dealer: state.dealer.value,
      honba: state.honba.value,
      firstDice: state.firstDice.value ? [...state.firstDice.value] : undefined,
      secondDice: state.secondDice.value ? [...state.secondDice.value] : undefined,
      diceThrowerIndex: state.diceThrowerIndex.value,
      wildcardTiles: [...state.wildcardTiles.value],
    }
  }
  // 端口优先取显式注入（测试/自定义音频），否则取音频层注册表——联机两条分支都不需要各自接线。
  const winMusic = createBloodFlowWinMusic(options.bgm ?? activeBgmTrackPort() ?? undefined)
  const winMusicState: WinMusicState = {
    totalWinTiles: () => view.value ? totalBloodFlowWinTiles(view.value.public.seats) : 0,
    playing: () => Boolean(view.value) && view.value!.public.status === 'playing' && !view.value!.public.roundResult,
  }
  const handHints = shallowRef<HandWaitHints | null>(null)
  const presentationSerial = shallowRef(0)
  const continuation = shallowRef<import('./types').BloodFlowTableState['continuation']>()
  const roundBubbles = shallowRef<Record<number, { text: string; id: number; persistent: boolean }>>({})
  const actionBubbles = shallowRef<Record<number, {text:string;id:number;persistent:boolean}>>({})
  const thinkingBubbles = shallowRef<Record<number, {text:string;id:number;persistent:boolean}>>({})
  /** 局末感言播报中：结算面板与局间倒计时要等它播完（用户要求）。 */
  const roundSpeechBusy = shallowRef(false)
  const thinkingOwners = new Map<number,string>()
  const thinkingIds = new Map<string,number>()
  const thinkingSequences = new Map<number,number>()
  const decisions = createBloodFlowDecisions({theme:()=>options.getThemeName?.()??'jade',
    // AI 分析记录接缝（可选）：把候选/推荐/请求生命周期/来源接进录制器；不传时零成本。
    analysis: options.analysis ? createBloodFlowDecisionSink({ recorder: options.analysis }) : null,
    // LLM 座位启用"真·大牌路线"（候选层收窄）；普通 AI 座位不走这条路径，行为不变。
    aiConfig: BLOOD_FLOW_LLM_AI,
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
  /** 联机座位语音身份（服务端供应商下发）：seat → {voiceKey, style}，每次快照刷新。 */
  const remoteVoices=new Map<number, {voiceKey: Exclude<LlmTtsVoiceKey, 'auto'>; style: LlmStyle}>()
  /** 已呈现的服务端模型原话 id（llm_message 去重）。 */
  const remoteModelMessages=new Set<number>()
  const pendingBots = new Set<string>(), spoken = new Set<string>(), speechControllers = new Set<AbortController>()
  let speechChain = Promise.resolve(), bubbleSerial = 0
  const reactions = createBloodFlowReactions({ theme: () => options.getThemeName?.() ?? 'jade',
    current: current => view.value?.authorityEpoch === current.authorityEpoch && view.value?.roundId === current.roundId && !!view.value?.public.roundResult,
    emit: (line, signal) => presentRoundReaction(line, signal),
    // llmAnime 局末感言：用该座位角色的专属固定文案 + 角色音色（此前血流只用性格通用台词，
    // 角色人格整局都用不上）。座位没有角色（如普通机器人）时运行时回退通用性格台词。
    character: (seat: Seat) => state.players[(seat - (view.value?.seat ?? 0) + 4) % 4]?.characterId,
    // 只在联机时传 voice（音色取房间供应商身份，不读本机单机 LLM 设置）。
    // 必须整体缺省而不能返回 null：reactions 一旦拿到 voice 就只用它，返回 null 会让该座位
    // 直接 continue —— 单机局末感言（气泡 + TTS）会全部消失（2026-09-10 由 blood-flow.llm.spec
    // 的 roundTts 断言暴露）。单机不传时运行时回退到 localBloodFlowProvider（本机 LLM 设置音色）。
    ...(options.externalAuthority ? { voice: (seat: Seat) => remoteSeatVoice(seat) } : {}),
  })
  let worker: ReturnType<typeof createBloodFlowWorkerClient> | null = null
  let hintWorker: ReturnType<typeof createEvaluatorService> | null = null
  let generation = 0, busy = false, heardAction = 0, heardDiscard = '', lockedAutoWindow = ''
  /** 已提交决策的窗口 id：本窗口内不再接受第二次提交，也不显示可操作按钮（响应式，供 UI 门控）。 */
  const submittedWindowId = shallowRef('')
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
  /**
   * 锁手自动摸打的观察窗口。
   * 单机：窗口开放时刻 + 观察窗（与改动前逐字一致，不受联机修复影响）。
   * 联机：快照的 opensAt 恒为 0（窗口已开放），直接等观察窗，避免 0ms 立即打掉。
   */
  function lockedAutoPlayDelay(window: { opensAt: number }) {
    const observe = options.lockedAutoPlayMs ?? 800
    const opensIn = window.opensAt - Date.now()
    return options.externalAuthority ? Math.max(0, opensIn) + observe : Math.max(0, opensIn + observe)
  }
  function hasKongChoice(actions: readonly { kind: string }[]) {
    return actions.some(a => a.kind === 'gang' || a.kind === 'concealed-kong'
      || a.kind === 'added-kong' || a.kind === 'wind-kong')
  }
  function clear() {
    // 重开一局/离开牌桌都要回到默认 BGM，避免「多胡」曲目残留到下一局或大厅。
    winMusic.release()
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
    remoteVoices.clear(); remoteModelMessages.clear()
    roundSpeechBusy.value = false
    submittedWindowId.value=''
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
  /** 每个座位跨局递增的胡牌台词序号：同组台词相邻两次不重复（不随每局 clear 归零）。 */
  const winLineSequences = new Map<number, number>()
  /** llmAnime 赢家动作台词的变体序号：同座位相邻两次胡牌换一个变体（`hu` / `hu-2` 等）。 */
  const animeWinVoiceSequences = new Map<number, number>()
  /**
   * 胡牌瞬间的赢家台词气泡（2026-09-19 用户反馈「只有胡、自摸」）：此前赢家台词只有声音，
   * 牌桌上什么都看不到。此处与吃碰杠共用同一气泡通道，局末恰好同拍时不补气泡
   * （结算面板立刻接管，且 settle 时 actionBubbles 必须为空）。
   */
  function showWinSpeechBubble(absoluteSeat: number, text: string, epoch: number) {
    if (!text || epoch !== generation) return
    const current = view.value
    if (!current || current.public.roundResult || current.public.status !== 'playing') return
    const seat = (absoluteSeat - current.seat + 4) % 4, id = ++bubbleSerial
    actionBubbles.value = { ...actionBubbles.value, [seat]: { text, id, persistent: false } }
    later(() => {
      if (actionBubbles.value[seat]?.id === id) {
        const copy = { ...actionBubbles.value }
        delete copy[seat]
        actionBubbles.value = copy
      }
    }, 4000)
  }
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
    // 未走模型（锁手座位、单候选窗口、模型没给原话）时的胡牌台词：按胡法 + 大牌 + 真连胡分档，
    // 并按跨局序号轮换，避免整局反复同一句。序号叠加座位号：一炮多响时各赢家各说自己的胡牌
    // 台词（用户 2026-09-19 决定不设多响专属台词），且不会同拍同句。
    const momentLine = (record: WinBatch['winners'][number], style: LlmStyle) => {
      const sequence = winLineSequences.get(record.winner) ?? 0
      winLineSequences.set(record.winner, sequence + 1)
      const previous = previousBloodFlowWin(snapshot, record.winner, batch.batchId)
      return bloodFlowWinMomentLine({ source: record.score.source, style, ordinal: record.ordinal,
        big: bloodFlowWinMomentIsBig(record.score),
        previousSource: previous.source, previousWasSelf: previous.self, sequence: sequence + record.winner })
    }
    const tasks: (() => Promise<void>)[] = []
    if (theme === 'llmAnime') {
      for (const record of batch.winners) {
        const characterId = state.players[toLocal(record.winner)]?.characterId
        // 同座位相邻两次胡牌换一个动作变体（一局要胡十几次，单条会被反复念）。
        const rotation = animeWinVoiceSequences.get(record.winner) ?? 0
        animeWinVoiceSequences.set(record.winner, rotation + 1)
        tasks.push(characterId ? (async () => {
          const request = createAnimeFixedTtsRequest(characterId, animeWinActionVoiceKey(
            animeVoiceKeyForTableAction(winType(record.score.source)) as AnimeActionVoiceKey, rotation))
          showWinSpeechBubble(record.winner, request.normalizedText, epoch)
          const url = await getLocalTtsClient().resolveAudioUrl(request.normalizedText, request.voiceKey, request.style, request.cacheIdentity)
          if (url) await playLlmAudioGroup([{ url, seat: record.winner }])
          else await playEffectUntilEnd(effectFile(record.score.source))
        }) : () => playEffectUntilEnd(effectFile(record.score.source)))
      }
    } else {
      for (const record of batch.winners) {
        const player = state.players[toLocal(record.winner)]
        const isLlmWinner = Boolean(player && (player.playerKind === 'llm' || player.isLlm))
        if (options.externalAuthority && isLlmWinner) {
          // 联机 LLM 赢家：台词与音频由服务端下发（llm_message/llm_audio），客户端不再播
          // hu/zimo 效果音——对齐经典「模型人声替代效果音」，避免两路声音叠加。
          continue
        }
        // 单机：本机 LLM 台词（预合成）+ 本机 TTS；其余赢家播 hu/zimo 效果音。
        const voice = isLlmWinner ? voiceFor(record.winner) : null
        tasks.push(voice ? (async () => {
          // 台词与合成在模型做出胡牌决定的瞬间已完成（预合成），这里直接取用开播；
          // 模型没参与（锁手连胡等）时用血流即时胡牌台词库（按胡法/档位/序号）。
          const own = decisions.takeWinLine(batch.windowId, record.winner)
          const style = own?.style ?? voice.style
          const voiceKey = own?.voiceKey ?? voice.voiceKey
          const text = own?.text ?? momentLine(record, style)
          showWinSpeechBubble(record.winner, text, epoch)
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

  function apply(next: BloodFlowWorkerView) {
    const previous = view.value
    view.value = next
    // 对局回放：apply 是本地所有视角更新的唯一汇聚点（request / actBot / 远端桥都走这里），
    // 因此录制必须挂在这里，否则绕过 request 的路径（如机器人seat直连 worker）会漏事件与结算。
    if (options.recorder) {
      // 先补事件流水（含该局最后一张弃牌与鸣牌），再收尾；收尾幂等。
      if (next.replay) recordReplaySpectator(next.replay)
      if (next.public.roundResult) recordReplaySettle(next)
    }
    // 分析记录（§5）：权威账本的新结算也在这里入账 —— 与录制共用同一汇聚点，绕过 request 的路径同样覆盖。
    if (options.analysis) {
      for (const settlement of settlementsFromView(next as unknown as BloodFlowLedgerViewLike, state.round.value, analysisSettlementsSeen)) {
        options.analysis.settlement(settlement)
      }
    }
    // 全场胡牌张数到阈值换 HuMusic、局末切回默认 BGM（淡出→换曲→淡入在音频层）。
    winMusic.update(winMusicState)
    // 窗口已推进/结束 → 解除本窗口的提交闩锁，恢复按钮可操作性。
    if (next.window?.id !== submittedWindowId.value) submittedWindowId.value = ''
    for(const [controller,current] of pendingDiscardSpeech)if(!current())controller.abort()
    decisions.cancelStale()
    const toLocal = (seat: number) => (seat - next.seat + 4) % 4
    const seeds = [options.humanPlayerSeed, ...(options.aiPlayerSeeds ?? [])]
    state.players.splice(0, state.players.length, ...next.players.map((_, i) => {
      const p = next.players[(next.seat + i) % 4], seed = options.externalAuthority ? undefined : seeds[i]
      // 头像兜底在映射时解析：避免 <img> 报错→回退在每次快照重绘时造成头像闪烁。
      return { ...p, name: seed?.name ?? p.name,
        avatar: seed?.avatar || p.avatar || defaultAvatarForSeat(i),
        characterId: seed?.characterId ?? p.characterId, playerKind: seed?.playerKind ?? p.playerKind ?? (i === 0 ? 'human' as const : 'bot' as const) }
    }))
    // 联机 LLM 座位语音身份：按权威座位号记录快照下发的供应商音色/策略
    // （本机单机 LLM 设置与房间无关，不能用来给联机座位配音）。
    remoteVoices.clear()
    if (options.externalAuthority) for (const p of next.players) {
      const identity = p as typeof p & { style?: string; voiceKey?: string }
      if (identity.voiceKey) remoteVoices.set(p.seat, remoteVoiceIdentity(identity))
    }
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
    // 血流不设服务端公告（单机与联机一致；抢杠胡红字公告是经典玩法专属，2026-09-09 用户确认移除）。
    // 本地开局公告（翻精/开牌）由 transient.announce 自己的 1.5s 定时清除。
    // 胡后有杠可选时留给玩家完整决策时间，包括同时可胡的窗口。
    // 无杠时才快速自动胡 / 摸切 / 过；到期兜底仍由权威引擎处理。
    if (w && next.public.status === 'playing' && next.public.seats[next.seat].locked && !options.autoplay
      && !hasKongChoice(moves)
      && (options.lockedAutoPlayMs ?? 800) > 0 && w.id !== lockedAutoWindow) {
      lockedAutoWindow = w.id
      later(() => {
        if (lockedAutoWindow !== w.id) return
        const cur = view.value
        if (!cur || cur.window?.id !== w.id || cur.public.status !== 'playing') return
        if (!cur.public.seats[cur.seat].locked || hasKongChoice(cur.ownActions)) return
        if (cur.ownActions.some(a => a.kind === 'win')) send({ kind: 'win' })
        else if (w.kind === 'turn') {
          const drawn = cur.players[cur.seat].drawnTileIndex
          if (drawn >= 0 && cur.ownActions.some(a => a.kind === 'discard' && a.index === drawn)) send({ kind: 'discard', index: drawn })
        } else if (cur.ownActions.some(a => a.kind === 'pass')) send({ kind: 'pass' })
      }, lockedAutoPlayDelay(w))
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
    // 联机 LLM 台词由服务端下发（llm_message/llm_audio，模型原话 + 服务端 TTS），
    // 客户端不再按快照拼模板台词——避免与服务端原话重复出声。
    if(!options.externalAuthority)for(const line of decisions.observe(next))void presentActionSpeech(line)
    if (next.public.roundResult) {
      cancelActionSpeech()
      const result = next.public.roundResult
      state.revealHands.value = true
      state.result.value = { winner: '本局结束', draw: result.winCounts.every(n => n === 0), roundLabel: common.roundLabel.value,
        scoreChanges: state.players.map((p, i) => ({ playerIndex: i, name: p.name, avatar: p.avatar, delta: result.endingScores[p.seat] - result.openingScores[p.seat], score: p.score })) }
      state.matchFinished.value = state.round.value >= BLOOD_FLOW_CONFIG.rounds[state.matchType.value]
      // 局末感言为本地模板台词（不发模型请求），联机与单机都播，避免联机结算没有台词。
      // roundSpeechBusy 让结算面板与局间倒计时等感言播完（用户要求，2026-09-10）。
      const speech = reactions.run(next)
      roundSpeechBusy.value = true
      void speech.finally(() => { roundSpeechBusy.value = false })
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
      // 录制开启时让 worker 在同一次回复里附带旁观视角：与座位视角同一拍送达，
      // 不会因为下一局重开 worker 而丢掉局末结算。
      const next = await worker.request<BloodFlowWorkerView>(
        options.recorder ? { ...body, replay: true } : body,
      )
      if (epoch !== generation) return
      busy = false
      apply(next)
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
      const own = await active.request<BloodFlowWorkerView>({ kind: 'view', seat, replay: Boolean(options.recorder) })
      if (!current() || own.window?.id !== windowId) return
      // 分析记录：窗口与前态（含该座位的合法动作）。只读视角，不参与决策（§3.2、§10.1）。
      const actions = seatLegalActions(own, seat)
      const analysisMono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
      options.analysis?.windowOpened({
        windowId, seat, windowKind: windowKindOf(actions),
        roundIndex: state.round.value, authorityEpoch: own.authorityEpoch, stateVersion: own.window?.version ?? 0,
        state: decisionStateOf(own, seat), openedAt: analysisMono(),
      })
      const action = await decisions.decide(own, current)
      if (!current()) return
      // 分析记录：选择与来源。来源（本地策略／模型／回退）由 LLM 运行时在下一层补充，这里先如实标 unknown。
      const pickedIndex = action ? actions.findIndex(move => JSON.stringify(move) === JSON.stringify(action)) : -1
      options.analysis?.chosen({
        windowId, seat, source: action ? 'unknown' : 'rule-auto',
        legalActionId: pickedIndex >= 0 ? legalActionId(windowId, pickedIndex) : null, at: analysisMono(),
      })
      if(action?.kind==='discard'){
        const line=decisions.prepareDiscard(own,action)
        if(line)await presentDiscardSpeech(line,current)
      }
      // Audio may have waited across a deadline, leave, or authority refresh.
      if (!current()) return
      const next = await active.request<BloodFlowWorkerView>(action ? { kind: 'command', command: {
        authorityEpoch: own.authorityEpoch, roundId: own.roundId, windowId, stateVersion: own.window.version, seat, action,
      }, replay: Boolean(options.recorder) } : { kind: 'bot', seat, windowId, replay: Boolean(options.recorder) })
      if (epoch === generation && (!view.value || next.version >= view.value.version)) apply(next)
      // 分析记录：执行回执。只有该座位出现可见变化才算执行成功；否则记 state-changed（§3.4、§10.2）。
      if (action) {
        options.analysis?.receipt({
          windowId, seat,
          status: choiceTookEffect(own as BloodFlowViewLike, next as BloodFlowViewLike, seat, action) ? 'executed' : 'state-changed',
          eventId: `${next.roundId ?? own.roundId}/${windowId}`,
          executedLegalActionId: pickedIndex >= 0 ? legalActionId(windowId, pickedIndex) : undefined,
        })
      }
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
    // 本窗口已提交过决策：等权威快照推进（同一窗口只能提交一次，重复提交必被服务端拒绝）。
    // 联机下窗口推进后客户端会因演出停顿最多 3.5s 看不到新窗口，连点会打出 STALE_ACTION。
    if (submittedWindowId.value === w.id) return
    submittedWindowId.value = w.id
    state.actionPrompt.value = null
    // 分析记录：人类决策（窗口、前态与合法动作、选择）。回执由下面的 watcher 在窗口推进时补（§3.4）。
    if (options.analysis) {
      const index = current.ownActions.findIndex(move => JSON.stringify(move) === JSON.stringify(action))
      options.analysis.windowOpened({
        windowId: w.id, seat: current.seat, windowKind: windowKindOf(current.ownActions),
        roundIndex: state.round.value, authorityEpoch: current.authorityEpoch, stateVersion: w.version,
        state: decisionStateOf(current as BloodFlowViewLike, current.seat),
      })
      options.analysis.chosen({
        windowId: w.id, seat: current.seat, source: 'human',
        legalActionId: index >= 0 ? legalActionId(w.id, index) : null,
      })
      pendingHumanChoice = { windowId: w.id, seat: current.seat, action, before: current as BloodFlowViewLike }
    }
    const command: EngineCommand = { authorityEpoch: current.authorityEpoch, roundId: current.roundId,
      stateVersion: w.version, windowId: w.id, seat: current.seat, action }
    if (options.externalAuthority) options.externalAuthority.send(command)
    else void request({ kind: 'command', command })
  }
  /** 分析记录：已入账的结算（胡牌批次/杠）id，视角是累计的，同一结算只记一次引用（§5）。 */
  const analysisSettlementsSeen = new Set<string>()
  /**
   * 人类提交后的执行回执：窗口推进时才判定（§3.4、§10.2）。
   * 只有该座位出现可见变化才算 executed，否则记 state-changed —— 不能因为"请求发出去了"就算执行成功。
   */
  let pendingHumanChoice: { windowId: string; seat: number; action: BloodFlowAction; before: BloodFlowViewLike } | null = null
  watch(() => view.value?.window?.id ?? '', (nextWindowId) => {
    const pending = pendingHumanChoice
    const next = view.value
    if (!pending || !next || nextWindowId === pending.windowId) return
    pendingHumanChoice = null
    options.analysis?.receipt({
      windowId: pending.windowId, seat: pending.seat,
      status: choiceTookEffect(pending.before, next as BloodFlowViewLike, pending.seat, pending.action) ? 'executed' : 'state-changed',
      detail: 'window-advanced',
    })
  })
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
    view.value = null; heardAction = 0; heardDiscard = ''; lockedAutoWindow = ''
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
    winLineSequences.clear()
    animeWinVoiceSequences.clear()
    // The shared cleanup removes players, unmounting the old HUD/3D table.
    // The next lobby start must mount a fresh table and receive its ready event.
    matchLifecycle.returnToLobby()
    remoteOpeningId = ''; view.value = null
    options.externalAuthority?.leave()
  }

  // 本窗口已提交决策后 ownActions 视为空：按钮与提示立即收起，等权威快照推进（防连点）。
  const moves = computed(() => view.value?.window?.id === submittedWindowId.value
    ? [] : view.value?.ownActions ?? [])
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
  // 自摸窗口改张提示：与 AI 策略同源计算；抢杠/点炮窗口（window.kind 非 turn 或来源非摸牌）恒为 null。
  const reformHint = computed<BloodFlowTableState['reformHint']>(() => {
    const current = view.value
    const window = current?.window
    if (!current || !window || window.kind !== 'turn' || window.source.kind !== 'draw') return null
    if (!moves.value.some(action => action.kind === 'win')) return null
    if (current.public.seats[current.seat].locked) return null
    if (!handHints.value || !current.ownScore) return null
    const drawnTileIndex = current.players[current.seat].drawnTileIndex
    if (drawnTileIndex < 0) return null
    return computeReformHint({
      hand: current.players[current.seat].hand,
      drawnTileIndex,
      wallCount: current.wallCount,
      visible: visibleTiles(current),
      ownScore: current.ownScore,
      hints: handHints.value,
    })
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
  /** 本机 LLM 预置读取（无 localStorage 环境/隐私模式下静默降级为无音色）。 */
  function speechProvider(seat: Seat) {
    try { return localBloodFlowProvider(seat) } catch { return null }
  }
  /** 联机座位语音身份：按权威座位号查快照下发的供应商音色/策略（非 LLM 座位返回 null）。 */
  function remoteSeatVoice(seat: Seat): { voiceKey: Exclude<LlmTtsVoiceKey, 'auto'>; style: LlmStyle } | null {
    const current = view.value
    if (!current) return null
    const player = state.players[(seat - current.seat + 4) % 4]
    if (!player || !(player.playerKind === 'llm' || player.isLlm)) return null
    return remoteVoices.get(seat) ?? { voiceKey: 'default', style: '稳健' }
  }
  /** 座位语音身份：联机用房间快照下发的供应商身份（音色/策略），单机用本机 LLM 设置。 */
  function voiceFor(seat: Seat): { voiceKey: Exclude<LlmTtsVoiceKey, 'auto'>; style: LlmStyle } | null {
    if (options.externalAuthority) return remoteSeatVoice(seat)
    const provider = speechProvider(seat)
    return provider ? { voiceKey: resolveLocalTtsVoiceKey(provider), style: provider.style } : null
  }
  /** 联机模型原话（服务端 llm_message）：直接落牌桌气泡——内容来自模型，不再是客户端模板。
   *  llmAnime 主题走角色固定台词（与经典联机同口径抑制模型动作/赛后语音）。 */
  function presentRemoteModelSpeech(message: BloodFlowWsSpeech): void {
    const theme = options.getThemeName?.() ?? 'jade'
    if (!bloodFlowReactionsAllowed(theme)) return
    if (shouldSuppressLegacyAnimeSpeech(theme, message)) return
    if (remoteModelMessages.has(message.id)) return
    remoteModelMessages.add(message.id)
    const current = view.value
    if (!current) return
    const seat = (message.seat - current.seat + 4) % 4
    const id = ++bubbleSerial
    if (message.purpose === 'round-reaction') {
      roundBubbles.value = { ...roundBubbles.value, [seat]: { text: message.text, id, persistent: true } }
      return
    }
    actionBubbles.value = { ...actionBubbles.value, [seat]: { text: message.text, id, persistent: false } }
    later(() => {
      if (actionBubbles.value[seat]?.id === id) {
        const copy = { ...actionBubbles.value }
        delete copy[seat]
        actionBubbles.value = copy
      }
    }, 5000)
  }
  /** 服务端 TTS 音频（llm_audio）：与经典联机同一条 llm 音频队列（messageId 去重）。 */
  function playRemoteModelAudio(url: string, message: BloodFlowWsAudio): void {
    if (!url || !options.externalAuthority) return
    if (shouldSuppressLegacyAnimeSpeech(options.getThemeName?.() ?? 'jade', message)) return
    const current = view.value
    if (!current) return
    const seat = (message.seat - current.seat + 4) % 4
    try {
      options.playLlmAudio?.(url, seat, message.messageId, message.priority)
    } catch { /* 音频失败不影响对局 */ }
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
    // 开局节奏逐项对齐经典联机 openingTimeline.ts（用户指定基准）：
    // game_start 等播完且至少 1250ms；骰子音不阻塞、骰子阶段 1900ms（动画 1050 + 渲染余量）。
    await Promise.all([safeSoundAndWait('game_start.mp3'), wait(1250)]); if (epoch !== generation) return
    state.diceThrowerIndex.value = state.dealer.value
    state.firstDice.value = meta.opening.firstDice; state.diceValues.value = meta.opening.firstDice
    state.openingStage.value = 'dice'
    void safeSoundAndWait('dice.mp3')
    await wait(1900); if (epoch !== generation) return
    state.flipStack.value = next.flipStack; state.flipTile.value = next.flipTile; state.jokerTiles.value = next.jokers
    state.wall.value = Array(134).fill('east'); state.openingStage.value = 'flip'
    // 翻精红字公告（经典联机同款：客户端在翻精阶段用中文牌名播报）。
    if (next.flipTile) transient.announce(`翻精 ${tileName(next.flipTile)}`)
    await wait(1200); if (epoch !== generation) return
    state.diceThrowerIndex.value = (next.flipSeat - next.seat + 4) % 4
    state.secondDice.value = meta.opening.secondDice; state.diceValues.value = meta.opening.secondDice
    state.openingStage.value = 'dice'
    void safeSoundAndWait('dice.mp3')
    await wait(1900); if (epoch !== generation) return
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
      // 经典联机每批都播 deal.mp3；4 张批 260ms、其余批（含庄家跳牌 2 张）150ms。
      sound('deal.mp3', .72)
      await wait(count === 4 ? 260 : 150)
    }
    for (let batch = 0; batch < 3; batch++) for (const seat of order) { await deal(seat, 4); if (epoch !== generation) return }
    await deal(state.dealer.value, 2); if (epoch !== generation) return
    for (const seat of order.filter(n => n !== state.dealer.value)) { await deal(seat, 1); if (epoch !== generation) return }
    remoteOpeningId = ''; state.openingStage.value = null
    completedRemoteOpenings.add(next.roundId)
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: state.dealAnimation.value.serial + 1 }
    // 开牌后 650ms 停顿再放行首回合（经典联机同款）；「开牌」红字公告在动画结束后
    // 才展示——经典联机的服务端公告在动画期间被丢弃、随动画结束后的快照呈现。
    await wait(650); if (epoch !== generation) return
    transient.announce(`${common.roundLabel.value} · 开牌`)
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
      reformHint: reformHint.value,
      presentationKey: String(presentationSerial.value), roundBubbles: roundBubbles.value, actionBubbles:{...actionBubbles.value,...thinkingBubbles.value}, continuation:continuation.value, sourceEvent:view.value.window?.source, kongEvents:view.value.kongEvents, roundSpeechBusy: roundSpeechBusy.value } : null,
  }))
  if (getCurrentInstance()) onBeforeUnmount(returnToLobby)
  return defineGamePort({ ...state, ...common, capabilities,
    userCanHu: computed(() => moves.value.some(a => a.kind === 'win')),
    userKongs: computed(() => moves.value.flatMap(a => a.kind === 'concealed-kong' ? [a.tile]
      : a.kind === 'added-kong' ? [state.players[0].melds[a.meldIndex].tile] : [])),
    userCurrentWaits: currentWaitInfo,
    userDiscardWaits, userTingOptions,
    startGame, nextRound, returnToLobby, tileName,
    presentRemoteModelSpeech, playRemoteModelAudio,
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
