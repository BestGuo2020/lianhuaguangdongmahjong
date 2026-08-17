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
import { ref, watch } from 'vue'
import type { GamePort } from '../../core/contracts/gamePort'
import type { MatchType } from '../../core/contracts/types'
import { serializeStateToSnapshot, type SnapshotContext, type SnapshotSource } from './localStateToSnapshot'
import type { RoundStartMessage, ServerMessage } from '../protocol/messages'
import type { ServerSnapshot } from '../protocol/dto'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import type { DisconnectableController } from './remotePlayerController'
import { createHostOpeningBarrier } from './openingBarrier'

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
  createGame: (
    remoteControllers: Array<TController | undefined>,
    waitForOpeningReady?: () => Promise<void>,
  ) => GamePort & SnapshotSource
  /** seat → 昵称（覆盖默认 PLAYER_SEED；房主 + 远端真人）。 */
  seatNames?: Map<number, string>
  /** seat → 头像（SDK 用户头像；房主 + 远端真人）。 */
  seatAvatars?: Map<number, string>
  /** 当前大厅座位表（peerId → seat）：重连恢复时优先按大厅分配恢复（比昵称可靠）。 */
  getSeatByPeer?: () => Map<string, number>
  /** 快照广播间隔（ms）。 */
  broadcastIntervalMs?: number
  /** 房主自视快照（seat 0 脱敏视图）：喂给房主自己的表现层 viewer。 */
  onLocalSnapshot?: (snapshot: ServerSnapshot) => void
  /** 房主自视事件（round_start/table_action/score_flow）：喂给房主自己的表现层 viewer。 */
  onLocalEvent?: (message: ServerMessage) => void
  /** 生产 vibehub 房主启用 opening_done 屏障；单元测试/旧调用可保持即时引擎。 */
  openingBarrier?: boolean
}

export function startHostGame<TController>(options: HostGameRunnerOptions<TController>): {
  game: GamePort & SnapshotSource
  stop(): void
  aiControlledSeats: Set<number>
  /** 接管/归还版本号（ref）：外部据此 watch 到 AI 接管变化（raw Set 的 mutation 无法响应式跟踪）。 */
  aiControlledSeatsVersion: { value: number }
  /** 当前真人座位表（peerId → seat，重连后 peerId 已 retarget）。 */
  getLivePeerSeats(): Map<string, number>
  /** 房主 viewer 的开局动画结束后，确认当前 round。 */
  markLocalOpeningReady(round: number): void
  /** 外部强制 AI 接管某座位（续接安全网），成功返回 true。 */
  enableAIForSeat(seat: number): boolean
} {
  const { room, rulesetId, mode, seatByPeer, createController, createGame, seatNames, seatAvatars, broadcastIntervalMs = 200, onLocalSnapshot, onLocalEvent, openingBarrier: openingBarrierEnabled = false } = options

  // 远端玩家请求超时（客户端 12s 回合倒计时 + 开局动画/网络抖动余量）：超时判定掉线
  // → AI 接管，游戏不卡死。放宽到 25s：客户端开局动画（发牌/翻精 ≈4s）期间到达的
  // turn_request 会被 isBlocked 缓存，动画结束才收到请求、倒计时 12s → 响应约 16s；
  // 过短的超时会把「响应慢」误判成「掉线」，反复触发 AI 代打（重进玩家「AI 夺舍」）。
  const REMOTE_REQUEST_TIMEOUT_MS = 25000
  // 被 AI 接管的座位（seat 1-3），供 UI 标记「AI 代打」。
  const aiControlledSeats = new Set<number>()
  // 接管/归还版本号（ref 才能被 Vue watch 感知；raw Set 的 mutation 无法被响应式跟踪）。
  const aiControlledSeatsVersion = ref(0)

  // 构建远端控制器（seat 1-3 对应远端 peer；未映射座位留 undefined → 引擎回退 AI）
  let waitingCount = 0
  let game!: GamePort & SnapshotSource
  const remoteControllers: Array<TController | undefined> = [undefined, undefined, undefined]
  const seatStates: Array<{
    peerId: string
    seat: number
    controller: TController | undefined
    timeout: ReturnType<typeof setTimeout> | null
    /** 失联标记：SDK 报 reconnecting（对端断开、重连中）置 true；恢复（join/hello）清 false。 */
    disconnected: boolean
  }> = []
  const asDisconnectable = (controller: TController) => controller as TController & DisconnectableController
  const openingBarrier = createHostOpeningBarrier(
    () => seatStates
      .filter((state) => !state.disconnected && !asDisconnectable(state.controller!).isAIControlled())
      .map((state) => state.peerId),
  )
  for (const [peerId, seat] of seatByPeer) {
    if (seat >= 1 && seat <= 3) {
      const seatState = {
        peerId,
        seat,
        controller: undefined as TController | undefined,
        timeout: null as ReturnType<typeof setTimeout> | null,
        disconnected: false,
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
        if (ai) openingBarrier.removePeer(peerId)
        aiControlledSeatsVersion.value += 1
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

  game = createGame(
    remoteControllers,
    openingBarrierEnabled ? () => openingBarrier.wait(game.round.value) : undefined,
  )
  const context: SnapshotContext = { roomId: room.roomId, rulesetId }

  function seatName(seat: number): string {
    return game.players[seat]?.name ?? `座位${seat}`
  }

  function sendAnnouncement(text: string, tone: string) {
    const message: ServerMessage = { kind: 'announcement', text, tone, id: Date.now() }
    room.send(message)
    onLocalEvent?.(message)
  }

  // P2P 没有后端替房主收集 opening_done，房主直接接收远端确认。
  room.onMessage((message, fromPeerId) => {
    if (!openingBarrierEnabled) return
    if (typeof message !== 'object' || message === null) return
    const value = message as { type?: unknown; round?: unknown }
    if (value.type !== 'opening_done' || typeof value.round !== 'number') return
    openingBarrier.markPeerReady(fromPeerId, value.round)
  })

  // 重连恢复后重设计时：清掉旧 18s 掉线计时器，从「重发请求」这一刻重新给客户端
  // 完整 18s 响应窗口。否则客户端掉线期间请求已计时，重进后 resendPending 重发但
  // 计时器仍按旧时刻跑——客户端刚重进、倒计时刚开始（人还在思考）就被旧计时器
  // 误判掉线 AI 代打。
  function restartTimeout(seatState: (typeof seatStates)[number]) {
    if (seatState.timeout != null) window.clearTimeout(seatState.timeout)
    seatState.timeout = window.setTimeout(() => {
      seatState.timeout = null
      const controller = asDisconnectable(seatState.controller!)
      if (controller && !controller.isAIControlled()) controller.enableAI()
    }, REMOTE_REQUEST_TIMEOUT_MS)
  }

  // 掉线接管 / 重连恢复：对局中 peer 离开 → AI 接管；peer 重新加入（刷新页面重进）→
  // 恢复真人决策 + 补发座位身份（rejoin_ok），客户端据此恢复本家座位映射。
  room.onPeer((event) => {
    if (event.type === 'leave' || event.type === 'reconnecting') {
      // 真实 SDK 对「对端关闭页面」通常只报 reconnecting（连接中断、等待恢复）而非
      // leave——两者都视为掉线：立即 AI 接管（不必等 18s 请求超时，游戏不卡），
      // 并标记失联（重进恢复时昵称兜底据此匹配，即使座位还没被 18s 超时接管）。
      const seatState = seatStates.find((state) => state.peerId === event.id)
      if (!seatState?.controller) return
      seatState.disconnected = true
      const controller = asDisconnectable(seatState.controller)
      if (!controller.isAIControlled()) controller.enableAI()
      return
    }
    if (event.type === 'join' || event.type === 'connecting') {
      const seatState = seatStates.find((state) => state.peerId === event.id)
      if (!seatState?.controller) return
      seatState.disconnected = false
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
      // 立即补发一帧快照：等待中的座位 pending 会挡住周期广播，不主动补发的话
      // 重连客户端只能干等下一次状态变化（甚至永远等不到）才能看到牌桌。
      broadcastAll(true)
      // 快照之后再重发挂起请求：客户端先有 players/手牌，收到 turn_request 才能
      // 同步手牌并出牌；若请求先到而手牌为空，客户端无法出牌 → 15s 被 AI 代打，
      // 只能等下一轮才恢复（「重进后第一次无法出牌」）。
      // 重发成功 → 从这一刻重新计算掉线超时（旧计时器会误判刚重进的在线玩家掉线）。
      if (controller.resendPending()) restartTimeout(seatState)
    }
  })

  // 客户端 join 完成（消息处理链挂好后）会发 lobby_hello；房主据此再补发一次
  // rejoin_ok，避免 join 事件（发生在客户端 join settle 期间、其处理器挂载前）时
  // 直发的 rejoin_ok 被漏掉（刷新页面重进的客户端会因漏收而丢失本家座位）。
  // 同时做 peerId 兜底：刷新后 peerId 可能变化（新标签页），优先按大厅座位表恢复
  room.onMessage((message, fromPeerId) => {
    if (typeof message !== 'object' || message === null) return
    if ((message as { type?: unknown }).type !== 'lobby_hello') return
    let seatState = seatStates.find((state) => state.peerId === fromPeerId)
    if (!seatState) {
      // 大厅座位表是权威（hostLobby 已把该座位分配给新 peerId，旧 peerId 已退场），
      // 无需等 AI 接管即可重定向——否则掉线未满 15s（座位还没被 AI 接管）时重连
      // 的新 peerId 永远对不上控制器，直到超时被 AI 接管才恢复，白挨一次代打。
      const assignedSeat = options.getSeatByPeer?.().get(fromPeerId)
      if (assignedSeat !== undefined) {
        const bySeat = seatStates.find((state) => state.seat === assignedSeat)
        const controller = bySeat?.controller ? asDisconnectable(bySeat.controller) : null
        if (bySeat && controller) {
          seatState = bySeat
          controller.disableAI()
          controller.retargetPeer(fromPeerId)
          bySeat.peerId = fromPeerId
          bySeat.disconnected = false
          // 恢复后清除挂起请求的掉线计时器并重新计时（见 restartTimeout 注释：
          // 防刚重进的在线玩家被旧计时器误判掉线）。
          if (controller.resendPending()) restartTimeout(bySeat)
        }
      }
    }
    if (!seatState) {
      // 昵称兜底：刷新后 peerId 变化时按昵称匹配座位。放宽到「失联中或已 AI 接管」
      // 的座位：客户端掉线重进时，若掉线时间短（<18s 请求超时）座位尚未被 AI 接管，
      // 只认 isAIControlled 会恢复失败 → 座位保持 AI 状态 → continue 屏障把它当掉线
      // 过滤 → 房主无视等待直接进下一局（客户端明明重进回来了）。
      const nickname = (message as { nickname?: unknown }).nickname
      const fallback = seatStates.find((state) => {
        if (!state.controller || state.peerId === fromPeerId) return false
        if (seatName(state.seat) !== nickname) return false
        const controller = asDisconnectable(state.controller)
        return state.disconnected || controller.isAIControlled()
      })
      if (fallback) {
        seatState = fallback
        const controller = asDisconnectable(fallback.controller!)
        controller.disableAI()
        controller.retargetPeer(fromPeerId)
        fallback.peerId = fromPeerId
        fallback.disconnected = false
        // 恢复后清除挂起请求的掉线计时器并重新计时（见 restartTimeout 注释：
        // 防刚重进的在线玩家被旧计时器误判掉线）。
        if (controller.resendPending()) restartTimeout(fallback)
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
    // 同上：补发一帧全量快照，让重连客户端立即看到牌桌（含正在等待中的请求局面）。
    broadcastAll(true)
    // 快照之后再重发挂起请求（见 onPeer('join') 注释：先给手牌、再收回合请求，
    // 否则重进后第一次无法出牌）。重发成功 → 从这一刻重新计算掉线超时。
    const restored = asDisconnectable(seatState.controller!)
    if (restored.resendPending()) restartTimeout(seatState)
  })

  // 临时诊断：定位「刷新重进后操作回不去」——客户端动作是否到达房主、是否对上座位。
  room.onMessage((message, fromPeerId) => {
    if (typeof message !== 'object' || message === null) return
    const type = (message as { type?: unknown }).type
    if (type !== 'discard' && type !== 'pass' && type !== 'claim' && type !== 'gang' && type !== 'hu') return
    const known = seatStates.some((state) => state.peerId === fromPeerId)
    if (!known) {
      console.warn(
        `[host] 收到动作 ${String(type)} 来自未知 peer ${fromPeerId}（座位表: ${seatStates.map((s) => `${s.seat}=${s.peerId}`).join(' | ')}）——客户端动作没对上任何真人座位`,
      )
    }
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
  function broadcastAll(force = false) {
    // 等待远端玩家响应（出牌/碰杠胡）或本地引擎 thinking 时不广播周期快照：
    // 否则快照 applyNow 会 clearCountdown、清空 actionPrompt 并把 phase 重置为 playing，
    // 覆盖客户端 requestCoordinator 刚设的 discard/prompt 相位、倒计时与碰杠胡按钮。
    // force（重连补发）除外：新 peerId 必须立刻拿到当前局面，否则永远看不到牌桌。
    if (!force && (waitingCount > 0 || game.phase.value === 'thinking')) return
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
    if (!force && key === lastBroadcastKey) return
    lastBroadcastKey = key
    // 用 seatStates 而非开局静态 seatByPeer：刷新重连的客户端 peerId 会变化，
    // seatState.peerId 在恢复时被 retarget 更新。若按旧 map 发送，重连后的新 peerId
    // 永远收不到快照（客户端 players 为空 → 无法响应 turn_request → 14s 被 AI 接管）。
    const sent = new Set<number>()
    for (const state of seatStates) {
      if (state.peerId && !sent.has(state.seat)) {
        sent.add(state.seat)
        room.send(serializeStateToSnapshot(game, state.seat, context), state.peerId)
      }
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

  // 启动本地引擎：先完成逻辑发牌并广播全量快照，再等待房主 viewer 与所有
  // 在线 peer 的 opening_done，最后才进入庄家首回合。
  if (openingBarrierEnabled) {
    const startGameWithBarrier = game.startGame as unknown as (
      mode?: MatchType,
      options?: { waitForOpeningReady?: () => Promise<void> },
    ) => unknown
    startGameWithBarrier(mode, {
      waitForOpeningReady: () => openingBarrier.wait(game.round.value),
    })
  } else {
    game.startGame(mode)
  }
  // 首局覆盖昵称/头像（后续每局由 phase→opening 的 watch 重新覆盖）。
  applySeatProfiles()

  // 周期快照广播：对局状态下每帧兜底同步（客户端 reconciler 取最新快照，幂等）。
  const intervalId = window.setInterval(broadcastAll, broadcastIntervalMs)

  return {
    game,
    aiControlledSeats,
    aiControlledSeatsVersion,
    /**
     * 当前真人座位表（peerId → seat）：与开局静态 seatByPeer 不同，重连恢复（retarget）
     * 会更新 seatStates 里的 peerId。续接确认关卡（continue 屏障）必须用它来判定
     * 「要等谁确认」——若用大厅静态表，重连后的新 peerId 发来 continue 也对不上旧
     * peerId，全员永远卡在「已确认，等待其他玩家」。
     */
    getLivePeerSeats(): Map<string, number> {
      const live = new Map<string, number>()
      for (const state of seatStates) {
        if (state.peerId) live.set(state.peerId, state.seat)
      }
      return live
    },
    markLocalOpeningReady(round: number) {
      if (openingBarrierEnabled) openingBarrier.markLocalReady(round)
    },
    /** 外部（续接安全网）强制 AI 接管某座位：掉线但无挂起请求（局末断线）时，
     * 座位永远不会被 15s 超时接管，continue 屏障会永久等待——由安全网兜底接管。 */
    enableAIForSeat(seat: number): boolean {
      const seatState = seatStates.find((state) => state.seat === seat)
      const controller = seatState?.controller ? asDisconnectable(seatState.controller) : null
      if (!seatState || !controller || controller.isAIControlled()) return false
      controller.enableAI()
      return true
    },
    stop() {
      window.clearInterval(intervalId)
      openingBarrier.cancel()
      stopWatch()
      stopEventWatchers.forEach((stop) => stop())
      stopImmediateWatchers.forEach((stop) => stop())
    },
  }
}
