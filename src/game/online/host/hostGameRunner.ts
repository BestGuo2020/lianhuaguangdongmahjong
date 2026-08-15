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
import type { DisconnectableController } from './remotePlayerController'

export interface HostGameRunnerOptions<TController> {
  room: VibeHubSDK.Room
  rulesetId: RuleVariant
  /** 场次（east / hanchan）。 */
  mode: MatchType
  /** peerId → 座位（seat 0 为房主自己，不在本映射中）。 */
  seatByPeer: Map<string, number>
  /** 远端控制器工厂：广麻用 RemotePlayerController，莲花用 LotusRemotePlayerController。
   * onAIControlledChange 在「AI 接管/归还」变化时回调（true=接管，false=归还）。 */
  createController: (room: VibeHubSDK.Room, peerId: string, onPending: (pending: boolean) => void, onAIControlledChange: (ai: boolean) => void) => TController
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

export function startHostGame<TController>(options: HostGameRunnerOptions<TController>): { game: GamePort & SnapshotSource; stop(): void; aiControlledSeats: Set<number> } {
  const { room, rulesetId, mode, seatByPeer, createController, createGame, seatNames, seatAvatars, broadcastIntervalMs = 200, onLocalSnapshot, onLocalEvent } = options

  // 远端玩家请求超时（客户端 12s 回合倒计时 + 余量）：超时判定掉线 → AI 接管，游戏不卡死。
  const REMOTE_REQUEST_TIMEOUT_MS = 15000
  // 被 AI 接管的座位（seat 1-3），供 UI 标记「AI 代打」。
  const aiControlledSeats = new Set<number>()

  // 构建远端控制器（seat 1-3 对应远端 peer；未映射座位留 undefined → 引擎回退 AI）
  let waitingCount = 0
  let game!: GamePort & SnapshotSource
  const remoteControllers: Array<TController | undefined> = [undefined, undefined, undefined]
  const seatStates: Array<{
    peerId: string
    seat: number
    controller: TController | undefined
    timeout: ReturnType<typeof setTimeout> | null
  }> = []
  const asDisconnectable = (controller: TController) => controller as TController & DisconnectableController
  for (const [peerId, seat] of seatByPeer) {
    if (seat >= 1 && seat <= 3) {
      const seatState = {
        peerId,
        seat,
        controller: undefined as TController | undefined,
        timeout: null as ReturnType<typeof setTimeout> | null,
      }
      seatStates.push(seatState)
      // AI 接管/归还状态变化：同步 aiControlledSeats（下一局确认关卡据此跳过掉线座位）
      // 并播报。玩家恢复响应（控制器内部兜底归还）也会走到这里。
      const onAIControlledChange = (ai: boolean) => {
        if (ai) {
          aiControlledSeats.add(seat)
          sendAnnouncement(`玩家「${seatName(seat)}」掉线，AI 代打`, 'gold')
        } else {
          aiControlledSeats.delete(seat)
          sendAnnouncement(`玩家「${seatName(seat)}」已重连`, 'gold')
        }
      }
      remoteControllers[seat - 1] = seatState.controller = createController(room, peerId, (pending) => {
        if (pending) {
          // 等待远端响应前，先把当前状态广播出去（含刚发生的弃牌/杠），
          // 否则客户端会先收到 claim/turn_request 却看不到触发它的那张牌。
          broadcastAll()
          // 掉线超时：客户端消失（不响应）→ 超时后 AI 接管该座位。
          if (seatState.timeout != null) window.clearTimeout(seatState.timeout)
          seatState.timeout = window.setTimeout(() => {
            seatState.timeout = null
            const controller = asDisconnectable(seatState.controller!)
            if (controller && !controller.isAIControlled()) controller.enableAI()
          }, REMOTE_REQUEST_TIMEOUT_MS)
        } else if (seatState.timeout != null) {
          window.clearTimeout(seatState.timeout)
          seatState.timeout = null
        }
        waitingCount += pending ? 1 : -1
      }, onAIControlledChange)
    }
  }

  game = createGame(remoteControllers)
  const context: SnapshotContext = { roomId: room.roomId, rulesetId }

  function seatName(seat: number): string {
    return game.players[seat]?.name ?? `座位${seat}`
  }

  function sendAnnouncement(text: string, tone: string) {
    const message: ServerMessage = { kind: 'announcement', text, tone, id: Date.now() }
    room.send(message)
    onLocalEvent?.(message)
  }

  // 掉线接管 / 重连恢复：对局中 peer 离开 → AI 接管；peer 重新加入（刷新页面重进）→
  // 恢复真人决策 + 补发座位身份（rejoin_ok），客户端据此恢复本家座位映射。
  room.onPeer((event) => {
    if (event.type === 'leave') {
      const seatState = seatStates.find((state) => state.peerId === event.id)
      if (!seatState?.controller) return
      const controller = asDisconnectable(seatState.controller)
      if (!controller.isAIControlled()) controller.enableAI()
      return
    }
    if (event.type === 'join') {
      const seatState = seatStates.find((state) => state.peerId === event.id)
      if (!seatState?.controller) return
      const controller = asDisconnectable(seatState.controller)
      if (controller.isAIControlled()) controller.disableAI()
      room.send({
        kind: 'rejoin_ok',
        seat: seatState.seat,
        rejoin: true,
        roomId: room.roomId,
        mode,
        rulesetId,
        nickname: seatName(seatState.seat),
        rejoinCode: '',
      } satisfies ServerMessage, event.id)
    }
  })

  // 客户端 join 完成（消息处理链挂好后）会发 lobby_hello；房主据此再补发一次
  // rejoin_ok，避免 join 事件（发生在客户端 join settle 期间、其处理器挂载前）时
  // 直发的 rejoin_ok 被漏掉（刷新页面重进的客户端会因漏收而丢失本家座位）。
  // 同时做 peerId 兜底：刷新后 peerId 可能变化（新标签页），按昵称匹配 AI 接管中的座位。
  room.onMessage((message, fromPeerId) => {
    if (typeof message !== 'object' || message === null) return
    if ((message as { type?: unknown }).type !== 'lobby_hello') return
    let seatState = seatStates.find((state) => state.peerId === fromPeerId)
    if (!seatState) {
      const nickname = (message as { nickname?: unknown }).nickname
      const fallback = seatStates.find((state) => {
        if (!state.controller || state.peerId === fromPeerId) return false
        const controller = asDisconnectable(state.controller)
        return controller.isAIControlled() && seatName(state.seat) === nickname
      })
      if (fallback) {
        seatState = fallback
        const controller = asDisconnectable(fallback.controller!)
        controller.disableAI()
        controller.retargetPeer(fromPeerId)
        fallback.peerId = fromPeerId
      }
    }
    if (!seatState) return
    room.send({
      kind: 'rejoin_ok',
      seat: seatState.seat,
      rejoin: true,
      roomId: room.roomId,
      mode,
      rulesetId,
      nickname: seatName(seatState.seat),
      rejoinCode: '',
    } satisfies ServerMessage, fromPeerId)
  })

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
    // 莲花麻将 diceValues 在第二次掷骰时被覆盖，一骰须取 firstDice（对齐单人模式）；
    // 广麻无 firstDice，回退 diceValues（单骰）。flipSeat 让客户端二骰由翻精目标方
    // 投出（对齐单人模式），否则两骰都显示庄家投。
    const dice = game.firstDice?.value ?? game.diceValues.value
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
      flipSeat: game.flipSeat?.value ?? undefined,
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
    // 摸牌瞬间广播：drawFor 在 phase='drawing' 阶段就把摸到的牌推入本家手牌并设置
    // drawnTileIndex，该 Vue flush 先于 beginTurn 把 phase 切成 'thinking'，因此这里
    // 的广播能通过 thinking 守卫。否则各端永远只看到出牌后的 13 张（及碰/杠后的
    // 13-3k），看不到别人摸上来的第 14 张。仅当有人持有摸牌位（drawnTileIndex >= 0）
    // 时广播；换庄复位（全部 -1）不广播，避免把上一局的 settled 结果带回新开局。
    watch(
      () => game.players.map((player) => player.drawnTileIndex).join(','),
      (value) => {
        if (value !== '-1,-1,-1,-1') broadcastAll()
      },
    ),
  ]

  // 启动本地引擎：instantOpening 下开局瞬间完成（发牌无动画），随后广播全量手牌快照。
  game.startGame(mode)
  // 首局覆盖昵称/头像（后续每局由 phase→opening 的 watch 重新覆盖）。
  applySeatProfiles()

  // 周期快照广播：对局状态下每帧兜底同步（客户端 reconciler 取最新快照，幂等）。
  const intervalId = window.setInterval(broadcastAll, broadcastIntervalMs)

  return {
    game,
    aiControlledSeats,
    stop() {
      window.clearInterval(intervalId)
      stopWatch()
      stopEventWatchers.forEach((stop) => stop())
      stopImmediateWatchers.forEach((stop) => stop())
    },
  }
}
