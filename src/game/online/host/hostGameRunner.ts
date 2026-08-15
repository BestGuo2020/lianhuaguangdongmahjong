// 房主权威对局编排（Phase 3）：开局后房主跑本地引擎 + 周期广播快照 + 桥接远端玩家输入。
//
// - 用 createGame 工厂创建本地引擎（useGame/useLotusGame），传入 remoteControllers（seat 1-3）
//   给远端真人座位；其余空席由引擎回退 AI。
// - 快照广播：把本地状态按「目标座位」脱敏后发给每个远端 peer（state-sync 模型）。
// - round_start：轮次变化时广播，触发客户端的发牌/骰点动画。
// - table_action / score_flow / hand_result：瞬时事件广播，客户端据此播放碰杠吃/胡音效与动画
//   （这些事件不进快照，且会被本地 presenter 在 ~1s 后清空，必须变化瞬间立即发出）。
//
// 诚实说明：本模块是 host-authority 的核心骨架；hand_result / match_finished 等事件消息
// 与广播时机需在真机联调阶段按实际 phase 转换校准（详见 docs/vibehub-p2p-migration.md）。
import { watch } from 'vue'
import type { GamePort } from '../../core/contracts/gamePort'
import type { MatchType } from '../../core/contracts/types'
import { serializeStateToSnapshot, type SnapshotContext, type SnapshotSource } from './localStateToSnapshot'
import type { RoundStartMessage, ServerMessage } from '../protocol/messages'
import type { ServerSnapshot } from '../protocol/dto'
import type { RuleVariant } from '../../core/rules/ruleVariants'

export interface HostGameRunnerOptions<TController> {
  room: VibeHubSDK.Room
  rulesetId: RuleVariant
  /** 场次（east / hanchan）。 */
  mode: MatchType
  /** peerId → 座位（seat 0 为房主自己，不在本映射中）。 */
  seatByPeer: Map<string, number>
  /** 远端控制器工厂：广麻用 RemotePlayerController，莲花用 LotusRemotePlayerController。 */
  createController: (room: VibeHubSDK.Room, peerId: string, onPending: (pending: boolean) => void) => TController
  /** 本地引擎工厂：传入非本家座位控制器，返回 GamePort（同时作为快照源）。 */
  createGame: (remoteControllers: Array<TController | undefined>) => GamePort & SnapshotSource
  /** seat → 昵称（覆盖默认 PLAYER_SEED；房主 + 远端真人）。 */
  seatNames?: Map<number, string>
  /** seat → 头像（SDK 用户头像；房主 + 远端真人）。 */
  seatAvatars?: Map<number, string>
  /** 快照广播间隔（ms）。 */
  broadcastIntervalMs?: number
  /** 房主自视快照（seat 0 脱敏视图）：喂给房主自己的表现层 viewer。 */
  onLocalSnapshot?: (snapshot: ServerSnapshot) => void
  /** 房主自视事件（round_start/table_action/score_flow）：喂给房主自己的表现层 viewer。 */
  onLocalEvent?: (message: ServerMessage) => void
}

export function startHostGame<TController>(options: HostGameRunnerOptions<TController>): { game: GamePort & SnapshotSource; stop(): void } {
  const { room, rulesetId, mode, seatByPeer, createController, createGame, seatNames, seatAvatars, broadcastIntervalMs = 200, onLocalSnapshot, onLocalEvent } = options

  // 构建远端控制器（seat 1-3 对应远端 peer；未映射座位留 undefined → 引擎回退 AI）
  let waitingCount = 0
  const remoteControllers: Array<TController | undefined> = [undefined, undefined, undefined]
  for (const [peerId, seat] of seatByPeer) {
    if (seat >= 1 && seat <= 3) {
      remoteControllers[seat - 1] = createController(room, peerId, (pending) => {
        if (pending) {
          // 等待远端响应前，先把当前状态广播出去（含刚发生的弃牌/杠），
          // 否则客户端会先收到 claim/turn_request 却看不到触发它的那张牌。
          broadcastAll()
        }
        waitingCount += pending ? 1 : -1
      })
    }
  }

  const game = createGame(remoteControllers)
  const context: SnapshotContext = { roomId: room.roomId, rulesetId }

  // 用真实昵称/头像覆盖默认 PLAYER_SEED。每局开局 resetPlayers 会用 PLAYER_SEED 重建玩家，
  // 因此必须在「opening」（重开局）时重新覆盖，否则过庄后昵称/头像回退成默认。
  function applySeatProfiles() {
    if (seatNames) {
      for (const [seat, name] of seatNames) {
        const player = game.players[seat]
        if (player) player.name = name
      }
    }
    if (seatAvatars) {
      for (const [seat, avatar] of seatAvatars) {
        const player = game.players[seat]
        if (player) player.avatar = avatar
      }
    }
    // 临时诊断：定位「闲家方位是房主方位」的座位映射问题。
    console.log('[host] engine seats:', game.players.map((p) => `${p.seat}:${p.name}`).join(' | '))
  }


  // 状态签名去重：同一帧状态不重复广播。否则 200ms 兜底轮询 + 多个状态 watch
  // 会反复发送幂等快照，客户端 3D 牌桌每次 rebuild 都会清掉进行中的出牌飞行动画（360ms）。
  let lastBroadcastKey = ''
  function broadcastAll() {
    // 等待远端玩家响应（出牌/碰杠胡）或本地引擎 thinking 时不广播周期快照：
    // 否则快照 applyNow 会 clearCountdown、清空 actionPrompt 并把 phase 重置为 playing，
    // 覆盖客户端 requestCoordinator 刚设的 discard/prompt 相位、倒计时与碰杠胡按钮。
    if (waitingCount > 0 || game.phase.value === 'thinking') return
    const key = [
      game.phase.value,
      game.currentPlayer.value,
      game.lastDiscard.value?.id ?? 0,
      game.wallHeadDrawn.value,
      game.wall.value.length,
      game.announcement.value?.text ?? '',
      game.result.value?.winnerIndex ?? -1,
      game.winPresentation.value?.winnerIndex ?? -1,
      game.revealHands.value ? 1 : 0,
      game.players.map((p) => `${p.hand.join('')}|${p.discards.join('')}|${p.melds.map((m) => m.type + m.tiles.join('')).join('')}|${p.score}|${p.redCount}`).join('~'),
    ].join('#')
    if (key === lastBroadcastKey) return
    lastBroadcastKey = key
    for (const [peerId, seat] of seatByPeer) {
      room.send(serializeStateToSnapshot(game, seat, context), peerId)
    }
    onLocalSnapshot?.(serializeStateToSnapshot(game, 0, context))
  }

  // ── 瞬时事件广播：碰/杠/吃 音效与动画（胡牌走 settled 快照 → settlement 时间线）──
  let lastTableActionId = -1
  let lastScoreFlowId = -1
  const stopEventWatchers = [
    watch(() => game.tableActionEvent.value, (event) => {
      if (!event || event.id === lastTableActionId) return
      lastTableActionId = event.id
      const message: ServerMessage = { kind: 'table_action', event }
      room.send(message)
      onLocalEvent?.(message)
      broadcastAll()
    }),
    watch(() => game.scoreFlowEvent.value, (event) => {
      if (!event || event.id === lastScoreFlowId) return
      lastScoreFlowId = event.id
      const message: ServerMessage = { kind: 'score_flow', deltas: event.deltas }
      room.send(message)
      onLocalEvent?.(message)
    }),
  ]

  function sendRoundStart() {
    const dice = game.diceValues.value
    const message: RoundStartMessage = {
      kind: 'round_start',
      matchStarted: game.round.value === 1,
      round: game.round.value,
      dealer: game.dealer.value,
      honba: game.honba.value,
      dice: [dice[0] ?? 1, dice[1] ?? 1] as [number, number],
      secondDice: game.secondDice?.value ?? undefined,
      flipTile: game.flipTile?.value ?? undefined,
      flipStack: game.flipStack?.value ?? undefined,
    }
    room.send(message)
    onLocalEvent?.(message)
    broadcastAll()
  }

  // round_start：发牌完成后（phase 进入 opening，此时手牌已齐）广播，触发客户端发牌/骰点动画。
  // watch 须在 startGame 之前注册；用 phase 而非 round（round 首局恒为 1）或 openingStage
  // （instantOpening 下阶段瞬变，watch 会错过中间态）。
  let lastPhase = game.phase.value
  const stopWatch = watch(() => game.phase.value, (phase) => {
    if (phase === 'opening' && lastPhase !== 'opening') {
      applySeatProfiles()
      sendRoundStart()
    }
    lastPhase = phase
    // 相位变化立即广播（waiting/thinking 由 broadcastAll 守卫拦截）。
    broadcastAll()
  })

  // 关键状态变化立即广播快照，降低 200ms 兜底轮询带来的「两边不同步」延迟。
  const stopImmediateWatchers = [
    watch(() => game.lastDiscard.value, () => broadcastAll()),
    watch(() => game.currentPlayer.value, () => broadcastAll()),
    watch(() => game.wallHeadDrawn.value, () => broadcastAll()),
  ]

  // 启动本地引擎：instantOpening 下开局瞬间完成（发牌无动画），随后广播全量手牌快照。
  game.startGame(mode)
  // 首局覆盖昵称/头像（后续每局由 phase→opening 的 watch 重新覆盖）。
  applySeatProfiles()

  // 周期快照广播：对局状态下每帧兜底同步（客户端 reconciler 取最新快照，幂等）。
  const intervalId = window.setInterval(broadcastAll, broadcastIntervalMs)

  return {
    game,
    stop() {
      window.clearInterval(intervalId)
      stopWatch()
      stopEventWatchers.forEach((stop) => stop())
      stopImmediateWatchers.forEach((stop) => stop())
    },
  }
}
