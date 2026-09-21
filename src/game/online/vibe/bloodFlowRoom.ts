import type { MatchType, GamePlayer } from '../../core/contracts/types'
import { createWall } from '../../core/rules/tiles'
import { useBloodFlowGame, type BloodFlowGameOptions } from '../../variants/lotus/bloodFlow/useBloodFlowGame'
import { BLOOD_FLOW_CONFIG } from '../../variants/lotus/bloodFlow/config'
import { BloodFlowAuthority } from '../../variants/lotus/bloodFlow/network/authority'
import { BloodFlowReplica } from '../../variants/lotus/bloodFlow/network/replica'
import { createWorkerAuthorityBackend } from '../../variants/lotus/bloodFlow/network/backends'
import { decodeBloodFlowPacket, type BloodFlowPacket } from '../../variants/lotus/bloodFlow/network/protocol'
import type { Seat } from '../../variants/lotus/bloodFlow/types'
import type { HostOpeningData } from '../host/hostGameRunner'
import { runCommittedShuffle } from '../antiCheat/committedShuffle'
import { createMatchStatsRecorder } from './matchStatsRecorder'
import { sendChunked, unwrapChunk } from '../transport/vibeRoomTransport'

/** 线上验收诊断开关：`?bfdiag=1` 时打印血流 P2P 收帧/失败的关键路径（默认静默）。 */
const BF_DIAG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('bfdiag')
import { updatePlayerStats } from './vibeStats'
import { watch } from 'vue'
import { createBloodFlowDecisions, createBloodFlowReactions, type BloodFlowReaction } from '../../llm/bloodFlowRuntime'
import { readLlmSettings, type LlmProviderPreset } from '../../llm/config'
import { BLOOD_FLOW_LLM_AI } from '../../variants/lotus/bloodFlow/config'
import type { BloodFlowSeatView } from '../../variants/lotus/bloodFlow/seatView'
import type { EngineCommand } from '../../variants/lotus/bloodFlow/state'
import {
  decisionStateOf, legalActionId, seatLegalActions, windowKindOf, type BloodFlowViewLike,
} from '../../replay/analysis/bloodFlowAdapter'
import { createBloodFlowDecisionSink } from '../../replay/analysis/decisionSink'
import type { HostLlmSeatSelection } from './vibeLlm'
import {createReplayRecorder} from '../../replay/recorder'
import {
  REPLAY_ACK_KIND,
  REPLAY_INVENTORY_KIND,
  REPLAY_REQUEST_KIND,
  createManifestRegistry,
  createRemoteReplayHost,
  createRemoteReplayPeer,
  createRemoteReplayServer,
  isRemoteReplayMessage,
  type RemoteReplayMessage,
  type RemoteReplayRequestMessage,
} from '../../replay/remoteRelay'
import {
  createBloodFlowRecordState,
  recordBloodFlowSettle,
  recordBloodFlowView,
  type BloodFlowRecordContext,
} from '../../replay/bloodFlowRecorder'
import type {ReplayStorage} from '../../replay/storage'
import {getRuleVariant} from '../../core/rules/ruleVariants'
import {actionSpeechMatches,type BloodFlowActionSpeech} from '../../llm/bloodFlowSpeech'
import type {AnalysisRecorder} from '../../replay/analysis/recorder'
import type {AnalysisSeatControl} from '../../replay/analysis/types'
import {
  ANALYSIS_REPRODUCTION_FORMAT_VERSION,
  decodeReproductionPayload,
  reproductionFromPayload,
  unavailableReproduction,
} from '../../replay/analysis/onlineReproduction'

interface BloodFlowRoomOptions extends Pick<BloodFlowGameOptions, 'playSound' | 'playSoundAndWait' | 'getThemeName' | 'animeFixedTts' | 'paceMs'> {
  getSeat(): number
  getMode(): MatchType
  getIsHost(): boolean
  /** Supplied only from the lobby's verified seat-token roster. */
  getVerifiedBindings(): Map<string, number>
  getPlayerProfile(seat: number): Partial<Pick<GamePlayer, 'name' | 'avatar' | 'characterId' | 'playerKind' | 'isLlm'>>
  leave(): void
  onError(message: string): void
  getPrivateAiSelections?(): readonly HostLlmSeatSelection[]
  onAutoPlayChanged?(enabled: boolean): void
  /**
   * 联机牌谱（全知）本地存储：房主用权威的旁观视角录制并广播给全员，客机收片落库。
   * 不传则联机回放整体关闭（零行为变化）。
   */
  replayStorage?: ReplayStorage | null
  /**
   * AI 分析记录（方案 docs/blood-flow/design/replay-ai-analysis-recording.md）。
   * 联机时分析区由 App 的分析会话持有（`analysis.port` 这个稳定代理），本房间负责：
   * 1. 把本机座位（客机）/ AI 座位（房主）的决策照常喂给记录器；
   * 2. 房主在**局后**产出 §6 赛后私有复现数据（牌墙/手牌/开局参数 + 权威命令序列），
   *    一份写进本机分析区，一份经既有中继下发给房间里的其他客户端；
   * 3. 客机收到后校验并写进自己的分析区。
   * 不传（或分析关闭）时整条路径零成本。
   */
  analysis?: AnalysisRecorder | null
  /**
   * 联机分析开场：把这一场的分析区场次 id 与座位口径交给 App 去 `analysis.start(...)`。
   * **必须与展示回放同一个场次 id**（房主的回放录制器就是这把钥匙），否则客机那份分析数据
   * 在"按展示回放清单回收"时会被当成悬空数据删掉（§9.2）。
   */
  onAnalysisMatchId?(detail: { matchId: string; seatControl: AnalysisSeatControl[]; mode: MatchType }): void
}

export function createBloodFlowRoom(options: BloodFlowRoomOptions) {
  let room: VibeHubSDK.Room | null = null, replica: BloodFlowReplica | null = null, authority: BloodFlowAuthority | null = null
  let lifecycle = 0, hostPeer = '', started = false, starting = false, lastReceived = 0, lastHello = 0, goneSince = 0
  /** 状态推进（sequence/round 变化）与"收到帧"分开跟踪；见 present() 里的注释。 */
  let lastStateSequence = -1, lastStateRound = -1, lastStateAdvance = 0
  /** 自愈可观测：已上报过的决策超时次数（避免同一计数重复打印）。 */
  let reportedDecisionTimeouts = 0
  /** 自愈可观测：已上报过的引擎/传输调用超时次数。 */
  let reportedWorkerTimeouts = 0
  /** 停滞取证：房间侧（450ms 定时器）的 tick 调用次数；与权威的 tickRuns 对照即可判断"是不是调用停了"。 */
  let tickCalls = 0
  /** 自愈可观测：客机因"状态停滞"重握手的次数（打印时自增）。 */
  let stateStallHandshakes = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let latestFrame: Extract<BloodFlowPacket, { kind: 'blood_flow_snapshot' | 'round_settled' }> | null = null
  let offline: (() => void) | null = null, online: (() => void) | null = null
  const shuffleIds = new Set<string>()
  const stats = createMatchStatsRecorder({ writeStats: updatePlayerStats, storageKey: 'lgm_blood_flow_match_stats' })
  const version = BLOOD_FLOW_CONFIG.version
  const completedKey = 'lgm_blood_flow_completed_epochs'
  const completed = new Set<string>()
  const pendingReactions = new Map<string, BloodFlowReaction>()
  const pendingActionSpeech=new Map<string,{line:BloodFlowActionSpeech;receivedAt:number}>()
  const provider = (seat: Seat): LlmProviderPreset | null => {
    if ([...options.getVerifiedBindings().values()].includes(seat)) return null
    const selected = options.getPrivateAiSelections?.().find(s => s.seat === seat), settings = readLlmSettings()
    if (!settings.enabled || !selected) return null
    const preset = settings.presets.find(p => p.id === selected.presetId)
    return preset?.apiKey.trim() ? { ...preset, style: selected.style } : null
  }
  /**
   * 本机**这一场是否真的在录**（§9.2/§10.7）。
   *
   * 代理（`analysis.port`）现在是恒存在的稳定对象（UI 上有开关，随时可切），因此所有
   * "要不要产出/下发私有复现数据"的判断都必须看 `enabled`（开关打开且已 start），
   * 而不是"代理是否存在" —— 否则房主关掉分析后仍会把牌墙与暗手发给房间里所有人。
   */
  const analysisRecording = () => options.analysis?.enabled === true
  const decisions = createBloodFlowDecisions({ provider,theme:()=>options.getThemeName?.()??'jade',
    // §3/§4 分析记录接缝：AI/LLM 座位的候选、推荐、请求生命周期与来源接进录制器。
    // 联机时这些座位由**房主**决定（权威的 decide 钩子），因此录制也只能在房主侧发生；
    // 客机那份分析记录里没有 AI 座位的决策明细，只有自己的决策与权威端下发的复现数据。
    analysis: options.analysis ? createBloodFlowDecisionSink({ recorder: options.analysis }) : null,
    aiConfig: BLOOD_FLOW_LLM_AI,
    metadata: () => ({ roundIndex: port.round.value, dealerIndex: port.dealer.value }) })

  /**
   * §3.2/§3.4：AI/LLM 座位的决策前态与选择也入账（房主侧）。
   * 决策前态用的就是**权威实际交给该座位的视角**（`view` 参数），与单机路径同一口径，不另算一份。
   * 执行回执不在这里记：那条判据是"权威是否真的执行了"，由权威回执驱动（见 applyReceipt）。
   */
  async function decideSeat(view: BloodFlowSeatView, isCurrent: () => boolean) {
    const recorder = options.analysis
    if (!recorder || !analysisRecording()) return decisions.decide(view, isCurrent)
    const window = view.window
    const seat = view.seat
    const actions = window ? seatLegalActions(view, seat) : []
    const mono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    if (window) {
      recorder.windowOpened({
        windowId: window.id, seat, windowKind: windowKindOf(actions),
        roundIndex: port.round.value, authorityEpoch: view.authorityEpoch, stateVersion: window.version,
        state: decisionStateOf(view as BloodFlowViewLike, seat), openedAt: mono(),
      })
    }
    const action = await decisions.decide(view, isCurrent)
    if (!window) return action
    const pickedIndex = action ? actions.findIndex(move => JSON.stringify(move) === JSON.stringify(action)) : -1
    recorder.chosen({
      windowId: window.id, seat, source: action ? 'unknown' : 'rule-auto',
      legalActionId: pickedIndex >= 0 ? legalActionId(window.id, pickedIndex) : null, at: mono(),
    })
    // 记下"这一手是谁提的"，等权威回执到了再补执行状态（§3.4：请求发出 ≠ 动作执行）
    if (action) pendingReceipts.set(`${window.id}/${seat}`, {
      windowId: window.id, seat, ...(pickedIndex >= 0 ? { legalActionId: legalActionId(window.id, pickedIndex) } : {}),
    })
    return action
  }

  /** 等待执行回执的决策（窗口/座位 → 决策标识）。 */
  const pendingReceipts = new Map<string, { windowId: string; seat: number; legalActionId?: string }>()

  /**
   * 权威对命令的处置 → 分析记录的执行回执（§3.4）：
   * - `rejected`：权威从未执行这条决定 ⇒ **不记回执**（不能把没发生的事记成执行过）；
   * - `accepted`：引擎接受了这条决定 ⇒ `executed`（房主侧能给出比客机更硬的判据，detail 里写明口径）；
   * - `unknown`：调用失败/超时 ⇒ `state-changed`，如实说"不知道执行没执行"。
   */
  function applyReceipt(command: EngineCommand, outcome: 'accepted' | 'rejected' | 'unknown'): void {
    const recorder = options.analysis
    if (!recorder) return
    const pending = pendingReceipts.get(`${command.windowId}/${command.seat}`)
    if (!pending) return
    pendingReceipts.delete(`${command.windowId}/${command.seat}`)
    if (outcome === 'rejected') return
    recorder.receipt({
      windowId: pending.windowId, seat: pending.seat,
      status: outcome === 'accepted' ? 'executed' : 'state-changed',
      detail: outcome === 'accepted' ? 'authority-accepted' : 'authority-outcome-unknown',
      ...(pending.legalActionId ? { executedLegalActionId: pending.legalActionId } : {}),
    })
  }

  // ── 联机牌谱（全知）：房主用权威的旁观视角录制 → 广播给全员 → 各自存本地 ──
  // 血流的房主权威跑在 BloodFlowAuthority（引擎在 worker 里），座位视角只有自己的手牌，
  // 因此全知牌谱必须走 `authority.spectatorView()`（四家明牌 + 累计弃牌流水）。
  const replayStorage: ReplayStorage | null = options.replayStorage ?? null
  const replayState = createBloodFlowRecordState()
  /** 诊断：房主旁观采样的成功/失败次数（线上验收据此判断"牌谱有没有事件流"）。 */
  let replaySpectatorSamples = 0, replaySpectatorMisses = 0
  let replayHostRelay: ReturnType<typeof createRemoteReplayHost> | null = null
  let replayPeerRelay: ReturnType<typeof createRemoteReplayPeer> | null = null
  let replayServer: ReturnType<typeof createRemoteReplayServer> | null = null
  /** 清单登记簿：多个持有者靠它错峰，谁先发别人就不再重复发。 */
  const replayRegistry = createManifestRegistry()
  const replayRecorder = replayStorage
    ? createReplayRecorder({
      meta: () => ({
        rulesetId: 'lotus-blood-flow' as const,
        rulesetName: getRuleVariant('lotus-blood-flow').name,
        themeName: (options.getThemeName?.() ?? 'jade') as never,
        humanSeat: options.getSeat(),
        gameMode: 'remote' as const,
      }),
      sink: {
        saveRound: (round) => {
          void replayStorage.saveRound(round)
          // 必须在这里惰性建中继：中继此前只在收到回执/补局请求时才创建，
          // 结果广播永远命中 null（线上实测：客机本地一条牌谱都没有）
          void ensureReplayHost()?.broadcastRound(round)
          // 房主是自己录制、不接收牌谱的那一方：本地不全时也必须能自愈（去问任意持有者）
          void ensureReplayPeer()?.review(round.matchId)
        },
        saveMatch: (match) => {
          void replayStorage.saveMatch(match)
          void ensureReplayHost()?.broadcastMatch(match)
          void ensureReplayPeer()?.review(match.id)
        },
      },
    })
    : null

  function sendReplayMessage(message: object) {
    if (!room) return
    try { sendChunked(room, message) } catch { /* 断线期间丢弃：牌谱不是对局必需路径 */ }
  }

  function ensureReplayHost(): ReturnType<typeof createRemoteReplayHost> | null {
    if (!replayStorage) return null
    if (!replayHostRelay) {
      replayHostRelay = createRemoteReplayHost({
        send: sendReplayMessage,
        loadRounds: (matchId) => replayStorage.loadRounds(matchId),
        loadMatch: (matchId) => replayStorage.loadMatch(matchId),
      })
    }
    return replayHostRelay
  }

  /** 补局服务器：每个参与者都有 —— 谁手上留着对方缺的局，谁就能补（不必是房主）。 */
  function ensureReplayServer(): ReturnType<typeof createRemoteReplayServer> | null {
    if (!replayStorage) return null
    if (!replayServer) {
      replayServer = createRemoteReplayServer({
        send: sendReplayMessage,
        loadRounds: (matchId) => replayStorage.loadRounds(matchId),
        loadMatch: (matchId) => replayStorage.loadMatch(matchId),
        selfKey: () => `${options.getSeat()}:${room?.roomId ?? ''}`,
        registry: replayRegistry,
      })
    }
    return replayServer
  }

  function ensureReplayPeer(): ReturnType<typeof createRemoteReplayPeer> | null {
    if (!replayStorage) return null
    if (!replayPeerRelay) {
      replayPeerRelay = createRemoteReplayPeer({
        send: sendReplayMessage,
        saveRound: (round) => replayStorage.saveRound(round),
        saveMatch: (match) => replayStorage.saveMatch(match),
        loadRounds: (matchId) => replayStorage.loadRounds(matchId),
        loadMatch: (matchId) => replayStorage.loadMatch(matchId),
        getMySeat: () => options.getSeat(),
        onManifestSeen: (id) => replayRegistry.note(id),
        // 落库后广播本机持有清单：让别人知道缺局可以找谁要（含"场次记录也缺"的情况）
        onSaved: (detail) => { if (detail.kind === 'match') void ensureReplayServer()?.announce(detail.matchId) },
        // §6：分析复现数据走同一套中继，但**不进回放库**（回放是公开口径，分析含赛后私有数据）
        onAnalysisPayload: (detail) => acceptAnalysisPayload(detail),
      })
    }
    return replayPeerRelay
  }

  /**
   * 回放协议消息入口。回执/补局请求来自远端客机，必须排在 replica 的
   * 报文校验（receive）之前；它们只驱动回放中继，不写任何对局状态。
   */
  function handleReplayMessage(raw: unknown): boolean {
    if (!replayStorage) return false
    const kind = (raw as { kind?: unknown } | null)?.kind
    if (kind === REPLAY_ACK_KIND || kind === REPLAY_REQUEST_KIND) {
      const message = raw as RemoteReplayMessage
      if (message.kind === REPLAY_ACK_KIND) {
        if (authority) void ensureReplayHost()?.handleAck(message.ack)
        return true
      }
      // 补局请求：房主立即应答，同时每个参与者都按错峰应答一次（任意持有者都能补）
      const request = raw as RemoteReplayRequestMessage
      if (authority) void ensureReplayHost()?.handleRequest(request)
      void ensureReplayServer()?.handleRequest(request)
      return true
    }
    if (kind === REPLAY_INVENTORY_KIND) replayRegistry.prune()
    if (!isRemoteReplayMessage(raw)) return false
    const peer = ensureReplayPeer()
    if (!peer) return false
    void peer.handle(raw)
    return true
  }

  // ── §6 赛后私有复现数据（联机分析记录）──
  // 对局进行中谁都拿不到牌墙与对手暗手；只有房主的权威端在**局后**才产得出这份数据。
  // 因此这里的分工是：房主局末产出 → 一份写本机分析区、一份经既有中继（清单+分片+回执）下发；
  // 客机收全后**严格校验**再写自己的分析区。房主没开分析记录时不产出，客机如实记"未提供"。
  /** 本场的分析区场次 id（与展示回放同一个钥匙）；房主在 attach 时定下，客机从快照信封里取。 */
  let analysisMatchId = ''
  /**
   * 分析记录的关键节点（有界留痕）。线上验收与本地 e2e 排查"这一局为什么没有复现数据"时，
   * 只有这条轨迹能区分：房主根本没产出、产出为空、写晚了（会话已结束）还是压根没收到客机那一份。
   */
  const analysisTrace: string[] = []
  function traceAnalysis(message: string) {
    analysisTrace.push(`${new Date().toISOString().slice(11, 23)} ${message}`)
    if (analysisTrace.length > 60) analysisTrace.splice(0, analysisTrace.length - 60)
    if (BF_DIAG) console.warn(`[bf-diag] 分析记录：${message}`)
  }
  /** 这一局是否已经有结论（收到了权威端的复现数据，或已如实记为"拿不到"）—— 迟到数据不再覆盖结论。 */
  const reproductionDecided = new Set<number>()
  /** 已结算但还没等到复现数据的局（房主不在时限内给出，就如实记"拿不到"）。 */
  const reproductionAwaited = new Map<number, number>()
  /** 房主侧：正在产出/广播复现数据的局（场末收尾要等它们落地，否则最后一局会被会话结束吞掉）。 */
  const reproductionInFlight = new Set<number>()
  /**
   * 房主侧：**已结算但还没结清**的局。
   *
   * 为什么需要它：权威先广播结算帧、再调 `onRoundSettled` 产出复现数据，而客户端一侧的
   * "本场结束"判定只需要结算帧 —— 场末可能在本机产出开始**之前**就到达（实测：加速用例下
   * 最后一局的复现数据因此写晚了、被会话结束吞掉）。这里以"看到结算帧"为起点记账，
   * 场末收尾就会等到本机那一份真的结清为止。
   */
  const hostReproductionPending = new Set<number>()
  /** 等多久算"没收到"：正常一两秒就到（清单+分片+回执），20s 足够跨过一次丢包补发。 */
  const REPRODUCTION_WAIT_MS = 20_000

  /** 座位口径（绝对座位）：分析记录里必须按权威的座位编号，不能按本机视角的旋转后编号。 */
  function analysisSeatControls(): AnalysisSeatControl[] {
    const humans = new Set<number>([...options.getVerifiedBindings().values()])
    const llm = new Set<number>((options.getPrivateAiSelections?.() ?? []).map(selection => selection.seat))
    return [0, 1, 2, 3].map(seat => humans.has(seat) ? 'human' as const : llm.has(seat) ? 'llm' as const : 'local-ai' as const)
  }

  /** 通知 App 开一场分析记录（换场时先如实收尾上一场，避免错场归属）。 */
  function announceAnalysisMatch(matchId: string) {
    if (!matchId) return
    analysisMatchId = matchId
    traceAnalysis(`本场分析场次 id=${matchId}（${options.getIsHost() ? '房主' : '客机'}）`)
    if (!options.analysis) return
    options.onAnalysisMatchId?.({ matchId, seatControl: analysisSeatControls(), mode: options.getMode() })
  }

  /**
   * 房主：局末产出这一局的复现数据。**先写本机分析区再广播** —— 本机记录不该依赖传输；
   * 拿不到就如实记一条缺失（§6：不猜测补齐），绝不发一份缺字段的载荷让客机"复现"出另一个局面。
   */
  async function publishRoundReproduction(round: number): Promise<void> {
    const active = authority, recorder = options.analysis
    if (!active || !recorder || !analysisRecording() || !analysisMatchId) {
      traceAnalysis(`房主跳过第 ${round} 局：${!active ? '无权威' : !analysisRecording() ? '本机未开分析' : '无场次 id'}`)
      hostReproductionPending.delete(round)
      return
    }
    reproductionInFlight.add(round)
    try {
      const payload = await active.reproduction(analysisMatchId, round)
      if (!payload) {
        traceAnalysis(`房主第 ${round} 局拿不到复现数据（引擎未开记录或已推进到下一局）`)
        recorder.noteGap({ scope: 'reproduction', from: round, reason: '权威端未能产出这一局的赛后复现数据（引擎未开启命令记录或已推进到下一局）' })
        return
      }
      recorder.reproduction(reproductionFromPayload(payload))
      traceAnalysis(`房主第 ${round} 局已写本机分析区（命令 ${payload.commands.length} 条，牌墙 ${payload.initialWall.length} 张）`)
      try {
        await ensureReplayHost()?.broadcastAnalysis(analysisMatchId, round, payload, ANALYSIS_REPRODUCTION_FORMAT_VERSION)
        traceAnalysis(`房主第 ${round} 局已广播复现数据`)
      } catch (error) {
        traceAnalysis(`房主第 ${round} 局广播失败：${String(error).slice(0, 80)}`)
      }
    } finally {
      reproductionInFlight.delete(round)
      hostReproductionPending.delete(round)
    }
  }

  /** 房主：看到某局结算帧 → 记下"本机还欠这一局一份复现数据"（场末收尾据此等待）。 */
  function expectHostReproduction(round: number): void {
    if (!analysisRecording() || !analysisMatchId || !authority) return
    if (reproductionInFlight.has(round) || hostReproductionPending.has(round)) return
    hostReproductionPending.add(round)
  }

  /**
   * 客机：收到权威端的复现数据。载荷是**未受信任的网络输入**，字段校验不过就整份拒收并留痕，
   * 半份数据写进分析区只会让赛后复现得出一个看似成功的错误结论。
   */
  function acceptAnalysisPayload(detail: { matchId: string; roundIndex: number | null; payload: unknown }): void {
    const recorder = options.analysis
    if (!recorder || !analysisRecording()) return
    if (!analysisMatchId || detail.matchId !== analysisMatchId) return
    const decoded = decodeReproductionPayload(detail.payload)
    const round = decoded.payload?.roundIndex ?? detail.roundIndex
    if (round !== null && reproductionDecided.has(round)) {
      // 该局已经归档（收到过一份，或已按"拿不到"记录）：迟到/重复的数据不覆盖结论，但要留痕
      recorder.noteGap({ scope: 'reproduction', from: round, reason: '同一局的重复或迟到的赛后复现数据被丢弃' })
      return
    }
    if (!decoded.payload) {
      recorder.noteGap({ scope: 'reproduction', ...(detail.roundIndex ? { from: detail.roundIndex } : {}),
        reason: `收到的赛后复现数据不合规：${decoded.reason}` })
      if (round !== null) { reproductionDecided.add(round); reproductionAwaited.delete(round) }
      return
    }
    if (detail.roundIndex !== null && decoded.payload.roundIndex !== detail.roundIndex) {
      recorder.noteGap({ scope: 'reproduction', from: detail.roundIndex, reason: '赛后复现数据的局号与清单不一致' })
      if (round !== null) { reproductionDecided.add(round); reproductionAwaited.delete(round) }
      return
    }
    recorder.reproduction(reproductionFromPayload(decoded.payload))
    if (round !== null) { reproductionDecided.add(round); reproductionAwaited.delete(round) }
  }

  /** 如实记一条"这一局拿不到复现数据"（§6：明确标记，不猜测补齐）。 */
  function markReproductionUnavailable(round: number, reason: string): void {
    const recorder = options.analysis
    if (!recorder || !analysisRecording() || reproductionDecided.has(round)) return
    reproductionDecided.add(round)
    reproductionAwaited.delete(round)
    recorder.noteGap({ scope: 'reproduction', from: round, reason })
    recorder.reproduction(unavailableReproduction(round, reason))
  }

  /**
   * 客机：某局结算了 → 开始等权威端那份数据。
   *
   * `serving` 是房主随帧下发的**房间级**说明（`analysisReproduction`）：
   * - `false`：房主明确说了本场不记录、不提供赛后数据 ⇒ **当场**如实记「房主未开启」，不空等；
   * - `true`：等中继把数据送到，超过时限由 450ms 定时器兜底记「未收到」；
   * - `undefined`：老版本没这个字段（未知）⇒ 按等待处理。
   */
  function awaitRoundReproduction(round: number, serving?: boolean): void {
    if (!options.analysis || !analysisRecording() || reproductionDecided.has(round)) return
    if (serving === false) {
      markReproductionUnavailable(round, '联机房主未开启 AI 分析记录，本场没有赛后复现数据')
      return
    }
    if (!analysisMatchId) {
      markReproductionUnavailable(round, '联机房主未开启 AI 分析记录，本局没有赛后复现数据')
      return
    }
    if (!reproductionAwaited.has(round)) reproductionAwaited.set(round, Date.now())
  }

  /** 等够时限还没到：如实记"未收到"（丢包/放弃补发/房主中途退出都走这里）。 */
  function sweepReproductionWaiting(now: number): void {
    for (const [round, since] of [...reproductionAwaited]) {
      if (now - since < REPRODUCTION_WAIT_MS) continue
      markReproductionUnavailable(round, '未在时限内收到权威端的赛后复现数据（丢包或房主中断）')
    }
  }

  /**
   * 场末分析收尾（`analysis.finish()` **之前**必须调一次）：
   * 给还在路上的复现数据一小段送达时间，仍未到/仍在产出的就如实结清。
   *
   * 为什么必须在会话结束之前：会话结束（flush → 清空 target）之后的写入会被直接丢弃，
   * "还没收到"就会变成一片空白 —— 而空白正是 §6 最不能接受的那种含糊。
   */
  async function settleAnalysis(graceMs = 6_000): Promise<void> {
    const deadline = Date.now() + Math.max(0, graceMs)
    while ((reproductionAwaited.size || reproductionInFlight.size || hostReproductionPending.size) && Date.now() < deadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 200) })
    }
    for (const round of [...reproductionAwaited.keys()]) {
      markReproductionUnavailable(round, '场末仍未收到权威端的赛后复现数据')
    }
    for (const round of [...hostReproductionPending]) {
      traceAnalysis(`场末仍未结清第 ${round} 局（房主侧复现数据产出超时）`)
      hostReproductionPending.delete(round)
    }
  }

  function replayContext(): BloodFlowRecordContext {
    return {
      matchType: options.getMode(),
      round: port.round.value,
      dealer: port.dealer.value,
      honba: 0,
      diceThrowerIndex: port.dealer.value,
      wildcardTiles: ['white'],
    }
  }

  /** 场末名次：取结算帧的逐家分数与名次（联机牌谱的位次按客机自己重算，这里给房主口径）。 */
  function replayStandings(view: {
    players: Array<{ name: string; score: number }>
    public: { roundResult?: { endingScores: readonly number[]; ranks?: readonly number[] } | null }
  }) {
    const result = view.public.roundResult
    if (!result) return undefined
    return view.players
      .map((player, seat) => ({
        seat,
        name: player.name,
        score: result.endingScores?.[seat] ?? player.score,
        rank: result.ranks?.[seat] ?? 0,
      }))
      .sort((a, b) => (a.rank || 99) - (b.rank || 99) || b.score - a.score)
      .map((entry, index) => ({ ...entry, rank: entry.rank || index + 1 }))
  }

  /** 房主采样：取一份旁观视角喂给录制器；结算帧顺带收尾本局。 */
  async function sampleReplay(): Promise<void> {
    const recorder = replayRecorder, active = authority
    if (!recorder || !active) return
    const view = await active.spectatorView()
    if (!view) { replaySpectatorMisses += 1; return }
    replaySpectatorSamples += 1
    const context = replayContext()
    recordBloodFlowView(recorder.hooks, view, context, replayState)
    if (view.public.roundResult) recordBloodFlowSettle(recorder.hooks, view, context, replayState)
  }
  try { for (const id of JSON.parse(sessionStorage.getItem(completedKey) ?? '[]')) if (typeof id === 'string') completed.add(id) } catch { /* ephemeral stats */ }

  // 注意：**不要**给这个本地客户端再传 `recorder`。房间侧已经用旁观视角驱动同一份录制器
  // （事件流 + 结算），而客户端自己的结算路径会用另一份状态再 roundStart 一次，
  // 把"有事件流的那份"按同一个 id 覆盖成"只有结算帧的那份"（线上与本地 mock 实测 steps 全 0）。
  const port = useBloodFlowGame({ ...options, externalAuthority: {
    send: command => transmit({ kind: 'blood_flow_command', roomId: room?.roomId ?? '', ruleVersion: version, command }),
    nextRound: () => {
      if (!latestFrame) return
      if (authority) reactions.cancel()
      pendingReactions.clear()
      pendingActionSpeech.clear();decisions.cancelSpeech()
      transmit({ kind: 'blood_flow_continue', roomId: latestFrame.roomId, ruleVersion: version,
        authorityEpoch: latestFrame.authorityEpoch, round: latestFrame.round })
    },
    openingDone: round => {
      if (!latestFrame) return
      transmit({ kind: 'blood_flow_opening_done', roomId: latestFrame.roomId, ruleVersion: version,
        authorityEpoch: latestFrame.authorityEpoch, round })
    },
    leave: () => { stop(); options.leave() },
  } })
  const reactions = createBloodFlowReactions({ provider, theme: () => options.getThemeName?.() ?? 'jade',
    current: view => !!authority && replica?.view?.roundId === view.roundId && !!replica?.view?.public.roundResult,
    emit: line => {
      if (!room || !authority) return
      const message: BloodFlowPacket = { kind: 'blood_flow_reaction', roomId: room.roomId, ruleVersion: version, reaction: line }
      sendChunked(room, message); present(message, hostPeer)
    },
  })
  watch(() => options.getThemeName?.(), () => { reactions.cancel(); pendingReactions.clear();pendingActionSpeech.clear();decisions.cancelSpeech() })

  function flushReactions() {
    if (!replica?.view?.public.roundResult) return
    for (const [id, line] of pendingReactions) {
      pendingReactions.delete(id)
      if (line.roundId === replica.view.roundId && line.authorityEpoch === replica.view.authorityEpoch) void port.presentRoundReaction(line)
    }
  }
  function flushActionSpeech(){
    const view=port.view.value;if(!view)return
    for(const [id,p] of pendingActionSpeech){
      if(actionSpeechMatches(p.line,view)){pendingActionSpeech.delete(id);void port.presentActionSpeech(p.line)}
      else if(Date.now()-p.receivedAt>5000||view.roundId!==p.line.roundId||view.public.roundResult||view.public.status==='interrupted'
        ||view.public.status==='playing'&&view.version>=p.line.stateVersion)pendingActionSpeech.delete(id)
    }
  }

  /**
   * 房主 peer 实时解析：`hostPeer` 只在 attach 时取一次（`active.hostId`），对端 id 一旦变化
   * （SDK 修复连接 / 中继切换 / 重新入房），客机的 hello/回执会发往旧 id、主机的帧也会被判成
   * 「非房主」丢弃——实测表现为：主机侧 `[VibeHub] 联机消息加密失败: 消息未发送` 连续刷屏、
   * 客机再也收不到帧却仍能显示旧视图，最后判「房主无法恢复」整场中断（2026-09-10 线上验收）。
   */
  function liveHostPeer(): string {
    const active = room
    if (!active) return hostPeer
    const resolved = options.getIsHost() ? active.peerId : (active.hostId ?? '')
    if (!resolved) return hostPeer
    if (resolved !== hostPeer) {
      if (BF_DIAG) console.warn(`[bf-diag] 房主 peer 变更 ${hostPeer || '(空)'} → ${resolved}`)
      hostPeer = resolved
      // replica 用它拒收非房主消息，必须同步更新：否则对端 id 一变，客机会「收到帧但全部拒收」
      // ——实测表现为 HUD 停在 checking、结算面板永不出现，随后判「房主无法恢复」整场中断。
      if (replica) replica.hostPeer = resolved
    }
    return hostPeer
  }

  function isFromHost(from: string): boolean {
    return from === liveHostPeer()
  }

  function transmit(message: BloodFlowPacket) {
    if (!room) return
    if (authority) void authority.receive(message, room.peerId)
    else try { sendChunked(room, message, liveHostPeer()) } catch { /* periodic sync retries while disconnected */ }
  }
  function fail(message: string) {
    if (BF_DIAG) console.warn(`[bf-diag] fail: ${message}`)
    options.onError(message)
    replica?.interrupt()
    if (replica?.view && latestFrame) void port.acceptRemoteView(replica.view, { ...latestFrame, replay: true })
  }
  function present(raw: unknown, from: string) {
    const active = room, current = replica
    if (!active || !current) return
    // 联机牌谱协议先处理：回执/补局请求来自远端，必须排在 replica 报文校验之前
    if (handleReplayMessage(raw)) return
    const reaction = decodeBloodFlowPacket(raw)
    if(reaction?.kind==='blood_flow_action_speech'){
      const line=reaction.speech
      if(!isFromHost(from)||reaction.roomId!==active.roomId||line.authorityEpoch!==current.view?.authorityEpoch||line.roundId!==current.view?.roundId)return
      pendingActionSpeech.set(line.id,{line,receivedAt:Date.now()});flushActionSpeech();return
    }
    if (reaction?.kind === 'blood_flow_reaction') {
      if (!isFromHost(from) || reaction.roomId !== active.roomId || reaction.reaction.authorityEpoch !== current.view?.authorityEpoch
        || reaction.reaction.roundId !== current.view?.roundId) return
      pendingReactions.set(reaction.reaction.id, reaction.reaction); flushReactions(); return
    }
    if (!current.receive(raw, from)) {
      if (BF_DIAG) {
        const probe = decodeBloodFlowPacket(raw)
        const seq = probe && 'sequence' in probe ? (probe as { sequence: number }).sequence : null
        const result = probe && 'view' in probe
          ? Boolean((probe as { view?: { public?: { roundResult?: unknown } } }).view?.public?.roundResult) : null
        if (probe && (probe.kind === 'round_settled' || probe.kind === 'blood_flow_snapshot')) {
          console.warn(`[bf-diag] replica 拒收 kind=${probe.kind} round=${probe.round} seq=${seq} `
            + `携带结算=${result} 已应用round=${current.round} replicaSeq=${current.sequence} `
            + `已应用结算=${Boolean(current.view?.public.roundResult)}`)
          // 拒收原因细分（2026-09-14）：座位不符 / epoch 不符 / 序列回退 / 重复序列，
          // 是"客机收帧但视图不更新"这类停滞最需要区分的信息。
          const view = (probe as { view?: { seat?: unknown; public?: { status?: unknown } } }).view
          const epoch = (probe as { authorityEpoch?: unknown }).authorityEpoch
          console.warn(`[bf-diag] 拒收细分 座位报文=${String(view?.seat)} 本机=${current.seat} `
            + `epoch报文=${String(epoch)} 本机=${String(current.view?.authorityEpoch)} `
            + `seq报文=${String(seq)} 已应用=${current.sequence} ${String(view?.public?.status ?? '')}`)
        }
      }
      return
    }
    lastReceived = Date.now(); goneSince = 0
    const message = decodeBloodFlowPacket(raw)
    if (!message) return
    // 状态推进打点（2026-09-14 自愈）：与"收到帧"分开记。主机权威链被堵住时会**反复广播同一份
    // 状态**——只按收帧判断会以为一切正常，其实牌局早已停住（线上验收实测：双端停在等待、只剩托管）。
    if ('sequence' in message && (message.sequence !== lastStateSequence || message.round !== lastStateRound)) {
      lastStateSequence = message.sequence; lastStateRound = message.round; lastStateAdvance = Date.now()
    }
    if (message.kind === 'blood_flow_error') {
      fail(message.code === 'INCOMPATIBLE_RULE_VERSION' ? '房间规则版本不兼容，请更新所有客户端' : '房主对局已中断，保留最后确认流水')
      return
    }
    if (message.kind === 'blood_flow_snapshot' || message.kind === 'round_settled') {
      if ('autoPlay' in message) options.onAutoPlayChanged?.(message.autoPlay === true)
      const replay = latestFrame === null || port.view.value?.public.status === 'paused'
      latestFrame = message
      // §6：房主把本场分析场次 id 随帧带过来，客机据此把自己的分析记录挂在**同一场次**下
      // （否则客机那份会被"按展示回放清单回收"当成悬空数据删掉）。换场时 id 变，同样在这里接管。
      const announcedAnalysis = (message as { analysisMatchId?: string }).analysisMatchId
      if (announcedAnalysis && announcedAnalysis !== analysisMatchId) announceAnalysisMatch(announcedAnalysis)
      // §6：这一局结算了 →
      // - 客机：开始等权威端那份赛后复现数据（房主在帧里明确说了不提供，就当场如实记"房主未开启"）；
      // - 房主：记下"本机还欠这一局一份复现数据"（产出由 onRoundSettled 触发，可能晚于结算帧，
      //   场末收尾要等它结清，否则最后一局会被会话结束吞掉）。
      if (message.view.public.roundResult) {
        if (authority) expectHostReproduction(message.round)
        else awaitRoundReproduction(message.round, (message as { analysisReproduction?: boolean }).analysisReproduction)
      }
      if (!current.view) return
      if(authority)for(const line of decisions.observe(current.view)){
        sendChunked(active, {kind:'blood_flow_action_speech',roomId:active.roomId,ruleVersion:version,speech:line} satisfies BloodFlowPacket)
        pendingActionSpeech.set(line.id,{line,receivedAt:Date.now()})
      }
      try { sessionStorage.setItem(`blood-flow-view:${active.roomId}:${current.seat}`, JSON.stringify(message)) } catch { /* view remains in memory */ }
      void port.acceptRemoteView(current.view, { ...message, replay }).then(() => {
        flushReactions()
        flushActionSpeech()
        // 房主：每次状态应用后取一份旁观视角喂录制器（全知牌谱只能由房主产出）
        if (authority) void sampleReplay()
        if (room !== active || !message.view.public.roundResult || completed.has(message.authorityEpoch)) return
        // 结算帧当场收尾本局（不等下一次旁观采样，否则场末最后一局可能还没落库）
        if (authority && replayRecorder) {
          const context = replayContext()
          recordBloodFlowView(replayRecorder.hooks, message.view, context, replayState)
          recordBloodFlowSettle(replayRecorder.hooks, message.view, context, replayState)
        }
        const result = message.view.public.roundResult, own = current.seat
        stats.noteHandResult({ epoch: message.authorityEpoch, round: message.round, honba: 0,
          result: { winnerIndex: result.winCounts[own] > 0 ? 0 : undefined,
            scoreChanges: [{ playerIndex: 0, name: message.view.players[own].name, avatar: message.view.players[own].avatar,
              delta: result.endingScores[own] - result.openingScores[own], score: result.endingScores[own] }] } })
        if (message.round === BLOOD_FLOW_CONFIG.rounds[message.mode]) {
          completed.add(message.authorityEpoch)
          try { sessionStorage.setItem(completedKey, JSON.stringify([...completed].slice(-20))) } catch { /* at-most-once in this session */ }
          void stats.flushMatch(message.authorityEpoch)
          // 场末收尾：广播场次记录（客机据此补齐缺失的局）
          replayRecorder?.finishAuto(replayStandings(message.view))
          if (BF_DIAG) console.log(`[bf-replay] 房主旁观采样 成功=${replaySpectatorSamples} 失败=${replaySpectatorMisses}`)
        }
      }).catch((error) => {
        if (BF_DIAG) console.warn(`[bf-diag] acceptRemoteView 失败 round=${message.round} `
          + `result=${Boolean(message.view.public.roundResult)} err=${String(error).slice(0, 200)}`)
        fail('牌桌展示恢复失败，已保留确认流水')
      })
    } else if (message.kind === 'win_batch' && current.view && latestFrame) {
      void port.acceptRemoteView(current.view, { round: latestFrame.round, dealer: latestFrame.dealer, mode: latestFrame.mode })
    }
  }

  function verified(): Map<string, Seat> {
    const entries = [...options.getVerifiedBindings()].filter(([, seat]) => Number.isInteger(seat) && seat >= 0 && seat < 4)
    return new Map(entries.map(([peer, seat]) => [peer, seat as Seat]))
  }
  function shuffle(active: VibeHubSDK.Room, roundId: string, epoch: string, bindings: Map<string, Seat>, onMissing?: (seats: number[]) => void) {
    return new Promise<HostOpeningData>((resolve, reject) => runCommittedShuffle({ room: active, roundId, authorityEpoch: epoch,
      mySeat: options.getSeat(), seatCount: 4, seatByPeer: bindings, tiles: createWall(), onTimeout: onMissing,
      onComplete: (initialWall, openingDice, openingSecondDice) => resolve({ initialWall, openingDice, openingSecondDice }), onError: reject }))
  }

  function stop() {
    lifecycle++
    if (timer) clearInterval(timer)
    timer = null
    if (offline) window.removeEventListener('offline', offline)
    if (online) window.removeEventListener('online', online)
    authority?.stop(); authority = null; room = null; replica = null
    decisions.cancel(); reactions.cancel(); pendingReactions.clear();pendingActionSpeech.clear()
    port.dispose(); port.view.value = null; port.result.value = null; port.phase.value = 'lobby'
    // §6：还等着权威端复现数据的局，在离场时如实收尾（不能让"等不到"变成一片空白）。
    // 房主自己不是等待方（它边产出边落库），这里的集合只会有客机那份记录。
    for (const round of [...reproductionAwaited.keys()]) {
      markReproductionUnavailable(round, '离开房间时仍未收到权威端的赛后复现数据')
    }
    reproductionAwaited.clear(); reproductionDecided.clear(); analysisMatchId = ''
    started = false; starting = false; latestFrame = null
  }
  function attach(active: VibeHubSDK.Room, firstOpening?: PromiseLike<HostOpeningData>, initialBindings?: Map<string, number>) {
    const seat = options.getSeat()
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) return
    if (room === active && (!firstOpening || authority)) return
    if (options.getIsHost() && !firstOpening) return // lobby alone must never start an authority
    stop()
    const token = lifecycle
    room = active; hostPeer = options.getIsHost() ? active.peerId : active.hostId ?? ''
    if (!hostPeer) return fail('无法验证房主身份')
    lastReceived = Date.now(); lastHello = 0; goneSince = 0; shuffleIds.clear()
    replica = new BloodFlowReplica(active.roomId, hostPeer, seat as Seat, () => transmit({ kind: 'blood_flow_sync', roomId: active.roomId, ruleVersion: version }))
    // Cached state is displayed as paused until the pinned host confirms it again.
    try {
      const cached = decodeBloodFlowPacket(JSON.parse(sessionStorage.getItem(`blood-flow-view:${active.roomId}:${seat}`) ?? 'null'))
      if (cached && (cached.kind === 'blood_flow_snapshot' || cached.kind === 'round_settled') && replica.receive(cached, hostPeer)) {
        latestFrame = cached; replica.pause()
        if (replica.view) void port.acceptRemoteView(replica.view, { round: cached.round, dealer: cached.dealer, mode: cached.mode, replay: true,continuation:cached.continuation })
      }
    } catch { /* corrupt cache is not authority */ }

    if (options.getIsHost()) {
      const epoch = crypto.randomUUID()
      // §6 分析记录：本场的场次 id。房主用**展示回放录制器的那把钥匙**（分析区与回放必须同一个 id，
      // 否则分析数据在"按展示回放清单回收"时会被删掉），并立刻随快照下发给客机。
      // 只要回放录制器在就下发：房主没开分析时客机仍需要这把钥匙来挂自己的分析记录，
      // 只是那时客机拿不到赛后复现数据 —— 它会如实记成"未提供"。
      if (replayRecorder) announceAnalysisMatch(replayRecorder.ensureMatchId())
      else announceAnalysisMatch(crypto.randomUUID())
      const bindings = new Map([...(initialBindings ?? verified())].map(([peer, s]) => [peer, s as Seat]))
      bindings.set(active.peerId, 0)
      authority = new BloodFlowAuthority({ roomId: active.roomId, authorityEpoch: epoch, hostPeer: active.peerId,
        mode: options.getMode(), seatByPeer: bindings,
        // §6：分析开启时让引擎记录权威命令序列（局后才能产出复现数据）；关闭时零成本。
        backend: createWorkerAuthorityBackend({ recordCommands: analysisRecording() }),
        decide: (view, current) => decideSeat(view, current), cancelDecisions: decisions.cancel,
        // §3.4：把权威的处置结果接进分析记录（AI/LLM 座位的执行回执）
        onCommand: (command, outcome) => applyReceipt(command, outcome),
        // §6：把本场分析场次 id 随帧下发给客机（客机据此把自己的分析挂在同一场次下）。
        // **与本机是否开分析无关**：这把钥匙就是展示回放的场次 id，房主没开分析时客机仍然需要它
        // （否则客机那份分析数据会被"按展示回放清单回收"删掉）；只是那种情况下客机拿不到复现数据。
        analysisMatchId: () => analysisMatchId || null,
        // §6 房间级语义：本场是否由权威端记录并提供赛后复现数据（= 房主的分析开关）。
        // 客机据此当场知道"这一场有没有赛后数据"，不必空等超时；房主关着就明确发 false。
        analysisServing: () => analysisRecording(),
        // 停滞取证：仅 ?bfdiag=1 时把 tick 的关键分支打到控制台（验收取证会收集这些行）。
        trace: BF_DIAG ? (message: string) => console.warn(`[bf-diag] 权威 tick：${message}`) : undefined,
        // 局末两件事：当局感言（reactions）与 §6 赛后私有复现数据的产出与下发。
        // 放在 onRoundSettled（已经结算）而不是更早：进行中下发牌墙/暗手就是泄露。
        // 两条路径必须互不牵连：感言侧抛错也不能让复现数据不再产出（否则整局数据凭空消失）。
        onRoundSettled: (view, round) => {
          try { void reactions.run(view) } catch (error) { traceAnalysis(`第 ${round} 局局末感言抛错（不影响复现数据）：${String(error).slice(0, 80)}`) }
          void publishRoundReproduction(round)
        },
        send: (peer, message) => {
          if (room !== active || token !== lifecycle) return
          let packet = message
          if (message.kind === 'blood_flow_snapshot' || message.kind === 'round_settled') packet = {
            ...message, view: { ...message.view, players: message.view.players.map(p => ({ ...p, ...options.getPlayerProfile(p.seat) })) },
          }
          if (peer === active.peerId) present(packet, hostPeer)
          else sendChunked(active, packet, peer)
        },
        prepareOpening: async round => {
          if (round === 1) {
            const initial = await firstOpening!
            return { initialWall: initial.initialWall, firstDice: initial.openingDice, secondDice: initial.openingSecondDice }
          }
          for (let attempt = 0; attempt < 3; attempt++) {
            const current = authority!
            const participants = new Map([...current.bindings].filter(([, s]) => !current.aiSeats.has(s)))
            const roundId = `${epoch}/shuffle/${round}/${attempt}`
            const packet = { type: 'blood_flow_shuffle', roomId: active.roomId, ruleVersion: version, authorityEpoch: epoch,
              round, roundId, participants: [...participants].map(([peerId, s]) => ({ peerId, seat: s })) }
            sendChunked(active, packet)
            let missing: number[] = []
            try {
              const prepared = await shuffle(active, roundId, epoch, participants, seats => { missing = seats })
              return { initialWall: prepared.initialWall, firstDice: prepared.openingDice, secondDice: prepared.openingSecondDice }
            } catch (error) {
              let changed = false
              for (const s of missing) {
                const peer = [...participants].find(([, candidate]) => candidate === s)?.[0]
                if (peer && !active.peers().some(p => p.id === peer && p.open)
                  && Date.now() - (current.disconnected.get(peer) ?? Date.now()) >= 12_000) { current.aiSeats.add(s as Seat); changed = true }
              }
              if (!changed || attempt === 2) throw error
            }
          }
          throw new Error('Committed shuffle unavailable')
        },
      })
    } else void Promise.resolve(firstOpening).catch(() => fail('承诺洗牌失败，未进入对局'))

    active.onMessage((raw, from) => {
      if (room !== active || token !== lifecycle) return
      // 本房间直接订阅 SDK 的 room.onMessage（不经传输层），因此必须自己拆大包分片：
      // 否则被分片的结算帧在这里会被当成未知包丢弃 —— 线上实测「主机一直发、客机计数收到、
      // 但视图永远没有 roundResult、结算面板不出现」（场景 B 帧更大更早触发分片）。
      const unwrapped = unwrapChunk(raw)
      if (unwrapped === null) return
      const raw2 = unwrapped
      if (!authority && isFromHost(from) && typeof raw2 === 'object' && raw2 !== null && (raw2 as any).type === 'blood_flow_shuffle') {
        const m = raw2 as any
        if (m.roomId !== active.roomId || m.ruleVersion !== version || m.authorityEpoch !== latestFrame?.authorityEpoch
          || !Number.isInteger(m.round) || m.round !== (latestFrame?.round ?? 0) + 1 || typeof m.roundId !== 'string' || shuffleIds.has(m.roundId)
          || !Array.isArray(m.participants)) return
        const bindings = new Map<string, Seat>()
        for (const participant of m.participants) {
          if (typeof participant.peerId !== 'string' || !Number.isInteger(participant.seat) || participant.seat < 0 || participant.seat > 3
            || bindings.has(participant.peerId) || [...bindings.values()].includes(participant.seat)) return
          bindings.set(participant.peerId, participant.seat)
        }
        if (bindings.get(hostPeer) !== 0 || bindings.get(active.peerId) !== options.getSeat()) return
        shuffleIds.add(m.roundId)
        void shuffle(active, m.roundId, m.authorityEpoch, bindings).catch(() => { /* host retries or sends interruption */ })
      } else if (authority) void authority.receive(raw2, from)
      else present(raw2, from)
    })
    active.onPeer(event => {
      if (room !== active || token !== lifecycle || event.type === 'error') return
      if (authority) {
        if (event.type === 'leave' || event.type === 'reconnecting') authority.peerDisconnected(event.id)
        return
      }
      if (event.id !== liveHostPeer()) return
      if (event.type === 'leave' || event.type === 'reconnecting') {
        goneSince ||= Date.now(); replica?.pause()
        if (replica?.view && latestFrame) void port.acceptRemoteView(replica.view, { ...latestFrame, opening: undefined, replay: true })
      } else if (event.type === 'join' || event.type === 'connecting' || event.type === 'relay' && event.active) {
        transmit(replica!.hello())
      }
    })
    offline = () => { if (authority) void authority.pause(); else { goneSince ||= Date.now(); replica?.pause() } }
    online = () => { if (authority) void authority.resume(); else transmit(replica!.hello()) }
    window.addEventListener('offline', offline); window.addEventListener('online', online)
    timer = setInterval(() => {
      if (token !== lifecycle || room !== active) return
      // 联机牌谱：房主的旁观采样由这个定时器驱动 —— 房主自身的视图应用路径未必经过
      // present() 的那个分支，挂在报文上会漏采（线上验收实测：steps 全 0）。
      if (authority && replayRecorder) void sampleReplay()
      // 联机牌谱：半截会话定期回执催补（丢片只有靠回执才能发现）
      replayPeerRelay?.tick()
      // §6：等够时限还没等到复现数据的局，如实记"未收到"
      sweepReproductionWaiting(Date.now())
      if (authority) {
        const observed = verified(), bindings = new Map(authority.bindings)
        // Refresh verified peer IDs for existing seats, never drop a locked human merely
        // because a transient/older roster omitted them and never admit a new mid-game seat.
        for (const [peer, s] of observed) if ([...bindings.values()].includes(s)) {
          for (const [oldPeer, oldSeat] of bindings) if (oldSeat === s) bindings.delete(oldPeer)
          bindings.set(peer, s)
        }
        bindings.set(active.peerId, 0)
        if (started) authority.replaceVerifiedBindings(bindings)
        if (!started && !starting && [...authority.bindings.keys()].every(p => authority!.compatible.has(p))) {
          starting = true
          void authority.start().then(() => { started = true; starting = false }).catch(() => { starting = false; fail('规则版本协商或承诺洗牌失败'); authority?.interrupt() })
        } else if (started) {
          tickCalls += 1
          void authority.tick().then(() => {
            // 自愈可观测（2026-09-14）：决策/引擎调用超时是"权威链差点被堵死"的直接信号。
            // 只有 ?bfdiag=1 才打印，验收脚本会把它计数进结果里（跑通也看得见看门狗有没有干活）。
            if (BF_DIAG && authority && authority.botDecisionTimeouts > reportedDecisionTimeouts) {
              reportedDecisionTimeouts = authority.botDecisionTimeouts
              console.warn(`[bf-diag] 权威决策超时 #${reportedDecisionTimeouts}（已回落引擎机器人策略）`)
            }
            if (BF_DIAG && authority && authority.workerCallTimeouts > reportedWorkerTimeouts) {
              reportedWorkerTimeouts = authority.workerCallTimeouts
              console.warn(`[bf-diag] 权威引擎/传输调用超时 #${reportedWorkerTimeouts}（已跳过本次操作、下轮重试）`)
            }
          })
        }
        if (!started && !starting && Date.now() - lastReceived > 15_000) {
          fail('有客户端未支持当前血流规则，请更新后重开'); authority.interrupt(); if (timer) clearInterval(timer); timer = null
        }
      } else {
        if ((!replica?.view || replica.view.public.status === 'paused') && Date.now() - lastHello >= 1000) { lastHello = Date.now(); transmit(replica!.hello()) }
        // 客机：收帧停滞就主动重握手——`hello` 会触发主机立刻重发权威快照。此前只在视图
        // paused 时重握手：一旦漏掉终局帧（大帧静默发送失败/中继切换），客机既不请求重发
        // 又等不到新帧，40s+30s 后判「房主无法恢复」把整场打断（2026-09-10 线上验收实测）。
        else if (Date.now() - lastReceived > 3_000 && Date.now() - lastHello >= 3_000) {
          lastHello = Date.now(); transmit(replica!.hello())
          if (BF_DIAG) console.warn(`[bf-diag] 客机收帧停滞 ${Math.round((Date.now() - lastReceived) / 1000)}s，已重握手请求权威快照`)
        }
        // 第二道网：帧一直在到，但**状态不前进**（sequence/round 都没变）——典型是主机权威链被
        // 一条挂住的机器人/大模型决策堵死，只反复广播同一份状态。20s 阈值大于最长决策窗口
        // （12s）+ 一炮多响的并发决策余量，避免把正常的慢回合误判成停滞。
        else if (replica?.view && !replica.view.public.roundResult
          && Date.now() - lastStateAdvance > 20_000 && Date.now() - lastHello >= 20_000) {
          lastHello = Date.now(); transmit(replica!.hello())
          if (BF_DIAG) console.warn(`[bf-diag] 客机状态停滞 ${Math.round((Date.now() - lastStateAdvance) / 1000)}s（seq=${lastStateSequence} 未推进，帧仍在到），已重握手 #${++stateStallHandshakes}`)
        }
        if (replica?.view && !replica.view.public.roundResult && Date.now() - lastReceived > 40_000) goneSince ||= Date.now()
        if (goneSince && Date.now() - goneSince > 30_000) fail('房主无法恢复，对局中断，保留最后确认流水')
      }
    }, options.paceMs === 0 ? 10 : 450)
    if (!authority) transmit(replica.hello())
  }

  /**
   * 停滞取证钩子（2026-09-14，仅 `?bfdiag=1`）：线上验收卡住时，光看 HUD 阶段无法区分
   * 「主机把窗口投影给了错的人」还是「客机收下却没暴露可操作项」。这里直接暴露两端引擎级现场：
   * 客机的 replica 窗口/等待座位/可操作项、主机的权威当前视图与座位绑定。
   */
  if (BF_DIAG && typeof window !== 'undefined') {
    ;(window as unknown as { __bfDiag?: () => unknown }).__bfDiag = () => ({
      side: authority ? 'host' : replica ? 'guest' : 'idle',
      roomId: replica?.roomId ?? latestFrame?.roomId ?? null,
      /** §6 分析记录轨迹：线上验收用它回答"这一局的复现数据去哪了"。 */
      analysisTrace: [...analysisTrace],
      analysisMatchId: analysisMatchId || null,
      tickCalls,
      tickRuns: authority?.tickRuns ?? null,
      chainBusyMs: authority ? Math.round(authority.chainBusyMs) : null,
      lastReceivedAgoMs: lastReceived ? Date.now() - lastReceived : null,
      lastStateAdvanceAgoMs: lastStateAdvance ? Date.now() - lastStateAdvance : null,
      stateStallHandshakes,
      replica: replica?.view ? {
        seat: replica.seat, sequence: replica.sequence, round: replica.round,
        status: replica.view.public.status, currentPlayer: replica.view.currentPlayer,
        window: replica.view.window
          ? { id: replica.view.window.id, kind: replica.view.window.kind, version: replica.view.window.version }
          : null,
        waitingSeats: [...replica.view.waitingSeats],
        ownActions: replica.view.ownActions.map(action => action.kind),
        settled: Boolean(replica.view.public.roundResult),
      } : null,
      authority: authority ? {
        round: authority.round, botDecisionTimeouts: authority.botDecisionTimeouts,
        workerCallTimeouts: authority.workerCallTimeouts,
        aiSeats: [...authority.aiSeats], autoSeats: [...authority.autoSeats],
        bindings: [...authority.bindings.entries()],
        current: authority.currentView ? {
          status: authority.currentView.public.status, currentPlayer: authority.currentView.currentPlayer,
          window: authority.currentView.window
            ? { id: authority.currentView.window.id, kind: authority.currentView.window.kind }
            : null,
          waitingSeats: [...authority.currentView.waitingSeats],
          ownActions: authority.currentView.ownActions.map(action => action.kind),
        } : null,
      } : null,
    })
  }

  return { port, attach, stop, settleAnalysis, analysisTrace: () => [...analysisTrace],
    get activeRoom() { return room }, recover: () => { if (replica) transmit(replica.hello()) },    setAutoPlay: (enabled: boolean) => { if (latestFrame) transmit({ kind: 'blood_flow_auto', roomId: latestFrame.roomId,
      ruleVersion: version, authorityEpoch: latestFrame.authorityEpoch, enabled }) },
    interrupt: (reason: string) => { fail(reason); authority?.stop(); if (timer) clearInterval(timer); timer = null },
  }
}
