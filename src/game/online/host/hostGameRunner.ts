// 房主权威对局编排（Phase 3）：开局后房主跑本地引擎 + 事件驱动快照 + 桥接远端玩家输入。
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
import { serializeRevealedPlayers, serializeStateToSnapshot, type SnapshotContext, type SnapshotSource } from './localStateToSnapshot'
import type { RoundStartMessage, ServerMessage, SettlementSyncRequest, WinEffectMessage } from '../protocol/messages'
import type { ServerSnapshot } from '../protocol/dto'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import type { DisconnectableController, RemoteRequestContext } from './remotePlayerController'
import { createHostOpeningBarrier } from './openingBarrier'
import { verifySnapshot } from '../antiCheat/publicStateVerifier'

export interface HostGameRunnerOptions<TController> {
  room: VibeHubSDK.Room
  rulesetId: RuleVariant
  /** 场次（east / hanchan）。 */
  mode: MatchType
  /** peerId → 座位（seat 0 为房主自己，不在本映射中）。 */
  seatByPeer: Map<string, number>
  /** 远端控制器工厂：广麻用 RemotePlayerController，莲花用 LotusRemotePlayerController。
   * onAIControlledChange 在「AI 接管/归还」变化时回调（true=接管，false=归还）。 */
  createController: (room: VibeHubSDK.Room, peerId: string, onPending: (pending: boolean) => void, onAIControlledChange: (ai: boolean) => void, requestContext: RemoteRequestContext) => TController
  /** 本地引擎工厂：传入非本家座位控制器，返回 GamePort（同时作为快照源）。 */
  createGame: (
    remoteControllers: Array<TController | undefined>,
    waitForOpeningReady?: () => Promise<void>,
  ) => GamePort & SnapshotSource
  /** seat → 昵称（覆盖默认 PLAYER_SEED；房主 + 远端真人）。 */
  seatNames?: Map<number, string>
  /** seat → 头像（SDK 用户头像；房主 + 远端真人）。 */
  seatAvatars?: Map<number, string>
  /** seat → 二次元角色（房主本家形象 + 远端真人 lobby_character）。 */
  seatCharacters?: Map<number, string>
  /** 当前大厅座位表（peerId → seat）：重连恢复时优先按大厅分配恢复（比昵称可靠）。 */
  getSeatByPeer?: () => Map<string, number>
  /** 房主自视快照（seat 0 脱敏视图）：喂给房主自己的表现层 viewer。 */
  onLocalSnapshot?: (snapshot: ServerSnapshot) => void
  /** 房主自视事件（round_start/table_action/score_flow）：喂给房主自己的表现层 viewer。 */
  onLocalEvent?: (message: ServerMessage) => void
  /** 对局中的 peer 恢复/重进后，重放仍在进行的瞬时协议（如 round_shuffle_start）。 */
  onPeerRecovered?: (peerId: string) => void
  /** 生产 vibehub 房主启用 opening_done 屏障；单元测试/旧调用可保持即时引擎。 */
  openingBarrier?: boolean
  /** SDK 承诺洗牌完成后注入的确定性开局数据。 */
  opening?: HostOpeningData | PromiseLike<HostOpeningData>
}

export interface HostOpeningData {
    initialWall: import('../../core/contracts/types').TileType[]
    openingDice: [number, number]
    openingSecondDice?: [number, number]
}

export function startHostGame<TController>(options: HostGameRunnerOptions<TController>): {
  game: GamePort & SnapshotSource
  authorityEpoch: string
  stop(): void
  aiControlledSeats: Set<number>
  /** 接管/归还版本号（ref）：外部据此 watch 到 AI 接管变化（raw Set 的 mutation 无法响应式跟踪）。 */
  aiControlledSeatsVersion: { value: number }
  /** 当前可用且非 AI 真人座位表（peerId → seat，reconnecting 暂不参与续局屏障）。 */
  getLivePeerSeats(): Map<string, number>
  /** 当前已绑定控制器且尚未被 AI 接管的座位表（包含恢复宽限中的 peer）。 */
  getPeerSeats(): Map<string, number>
  /** 结算确认屏障使用的座位表：包含所有尚未明确标记为 AI 的真人，
   * 即使 SDK 当前处于 reconnecting/Relay 切换，也不能从确认要求中移除。 */
  getConfirmationSeats(): Map<string, number>
  /** 当前仍在 reconnecting 的座位；恢复窗口结束后才会切 AI。 */
  getDisconnectedSeats(): Set<number>
  /** 业务事件触发的单次权威事实补发。 */
  resendCurrentState(): void
  /** 大厅完成身份校验后，同步最新 peerId → seat 并定向补齐当前权威事实。 */
  syncVerifiedPeerSeats(seats: Map<string, number>): void
  /** 房主 viewer 的开局动画结束后，确认当前 round。 */
  markLocalOpeningReady(round: number, honba: number): void
  /** 外部强制 AI 接管某座位（续接安全网），成功返回 true。 */
  enableAIForSeat(seat: number, options?: { requireRecoveryExpired?: boolean }): boolean
} {
  const { room, rulesetId, mode, seatByPeer, createController, createGame, seatNames, seatAvatars, seatCharacters, onLocalSnapshot, onLocalEvent, onPeerRecovered, openingBarrier: openingBarrierEnabled = false } = options
  let active = true

  // 这是一次房主引擎生命周期的唯一代次。刷新/重新创建房主后即使 roomId
  // 恰好相同，旧请求和旧终局也不能再被当前客户端接受。
  const authorityEpoch = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  // 远端玩家请求超时（客户端 12s 回合倒计时 + 开局动画/网络抖动余量）：超时判定掉线
  // → AI 接管，游戏不卡死。放宽到 25s：客户端开局动画（发牌/翻精 ≈4s）期间到达的
  // turn_request 会被 isBlocked 缓存，动画结束才收到请求、倒计时 12s → 响应约 16s；
  // 过短的超时会把「响应慢」误判成「掉线」，反复触发 AI 代打（重进玩家「AI 夺舍」）。
  const REMOTE_REQUEST_TIMEOUT_MS = 25000
  // SDK 的 reconnecting 可能只是 P2P → Relay 切路。先留出恢复窗口，Relay 也不可用
  // 时才 AI 接管；有挂起请求时仍由上面的响应超时负责兜底。
  const CONNECTION_RECOVERY_GRACE_MS = 12000
  const isConfirmationBarrierPhase = () => (
    game.phase.value === 'win-effect'
    || game.phase.value === 'revealing'
    || game.phase.value === 'settled'
    || game.phase.value === 'finished'
  )
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
  const recoveryTimers = new Map<number, ReturnType<typeof setTimeout>>()
  const settlementReplayTimers = new Map<number, ReturnType<typeof setTimeout>>()
  const asDisconnectable = (controller: TController) => controller as TController & DisconnectableController
  const openingBarrier = createHostOpeningBarrier(
    () => seatStates
      // reconnecting 是软掉线：恢复窗口内不立即切 AI，但当前开局也不能等待
      // 一个不可用的 DataChannel。恢复后 recoverPeer 会重新补发快照/请求。
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
        if (ai) openingBarrier.removePeer(seatState.peerId)
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
            if (controller && !controller.isAIControlled() && !isConfirmationBarrierPhase()) controller.enableAI()
          }, REMOTE_REQUEST_TIMEOUT_MS)
        } else if (seatState.timeout != null) {
          window.clearTimeout(seatState.timeout)
          seatState.timeout = null
        }
        waitingCount += pending ? 1 : -1
      }, onAIControlledChange, {
        authorityEpoch,
        seat,
        getRound: () => game.round.value,
      })
    }
  }

  game = createGame(
    remoteControllers,
    openingBarrierEnabled ? () => openingBarrier.wait(game.round.value, game.honba.value) : undefined,
  )
  let snapshotSequence = 0
  const context: SnapshotContext = { roomId: room.roomId, rulesetId, authorityEpoch }
  let roundStartSequence = 0
  let roundStartMessage: RoundStartMessage | null = null

  function seatName(seat: number): string {
    return game.players[seat]?.name ?? `座位${seat}`
  }

  // 诊断：只记录消息类型、目标与当前局/相位，不记录牌面、分数或凭据。
  // 用于判定「房主已发出、客户端 SDK 未投递」与「客户端收到但被门禁丢弃」。
  function diagTx(kind: string, target?: string) {
    console.log(`[diag] host-tx kind=${kind} target=${target ? target.slice(0, 10) : 'broadcast'} round=${game.round.value} honba=${game.honba.value} phase=${game.phase.value}`)
  }

  function sendAnnouncement(text: string, tone: string) {
    if (!active) return
    const message: ServerMessage = { kind: 'announcement', text, tone, id: Date.now(), authorityEpoch, round: game.round.value }
    diagTx('announcement')
    room.send(message)
    onLocalEvent?.(message)
  }

  // P2P 没有后端替房主收集 opening_done，房主直接接收远端确认。
  room.onMessage((message, fromPeerId) => {
    if (!active) return
    if (!openingBarrierEnabled) return
    if (typeof message !== 'object' || message === null) return
    const value = message as { type?: unknown; round?: unknown; honba?: unknown; authorityEpoch?: unknown }
    // opening_done 只是客户端表现层完成的确认，不是客户端可以推进引擎的命令。
    // 必须同时绑定当前房主代次和当前引擎轮次；旧 Room 的迟到确认、NaN/小数轮次
    // 以及下一局的提前确认都不能满足当前开局屏障。
    if (
      value.type !== 'opening_done'
      || typeof value.round !== 'number'
      || !Number.isInteger(value.round)
      || value.round !== game.round.value
      || typeof value.honba !== 'number'
      || !Number.isInteger(value.honba)
      || value.honba !== game.honba.value
      || value.authorityEpoch !== authorityEpoch
    ) return
    openingBarrier.markPeerReady(fromPeerId, value.round, value.honba)
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
      if (controller && !controller.isAIControlled() && !isConfirmationBarrierPhase()) controller.enableAI()
    }, REMOTE_REQUEST_TIMEOUT_MS)
  }

  function clearRecoveryTimer(seatState: (typeof seatStates)[number]) {
    const timer = recoveryTimers.get(seatState.seat)
    if (timer != null) {
      window.clearTimeout(timer)
      recoveryTimers.delete(seatState.seat)
    }
  }

  function scheduleConnectionRecovery(seatState: (typeof seatStates)[number]) {
    clearRecoveryTimer(seatState)
    const peerIdAtDisconnect = seatState.peerId
    recoveryTimers.set(seatState.seat, window.setTimeout(() => {
      recoveryTimers.delete(seatState.seat)
      // Relay/connecting/hello 期间已恢复，或 peer 已被大厅重定向，不得误接管新连接。
      if (!seatState.disconnected || seatState.peerId !== peerIdAtDisconnect) return
      // 胡牌表现开始后，真人确认是下一局的硬屏障。此时把断线座位转 AI 会让
      // maybeAdvanceRound 合法跳过该真人，出现一端还没看到结算、房主已进下一局。
      if (isConfirmationBarrierPhase()) {
        console.warn('[host] 真人确认是下一局的硬屏障，结算阶段禁止自动 AI 接管', {
          seat: seatState.seat,
        })
        return
      }
      const controller = asDisconnectable(seatState.controller!)
      if (!controller.isAIControlled()) controller.enableAI()
    }, CONNECTION_RECOVERY_GRACE_MS))
  }

  function recoverPeer(seatState: (typeof seatStates)[number], peerId: string, forceSync = false) {
    if (!active) return
    const controller = asDisconnectable(seatState.controller!)
    const wasDisconnected = seatState.disconnected
    const wasAI = controller.isAIControlled()
    clearRecoveryTimer(seatState)
    seatState.disconnected = false
    if (wasAI) controller.disableAI()
    if (!forceSync && !wasDisconnected && !wasAI) return
    diagTx('rejoin_ok', peerId)
    room.send({
      kind: 'rejoin_ok',
      seat: seatState.seat,
      rejoin: true,
      roomId: room.roomId,
      mode,
      rulesetId,
      nickname: seatName(seatState.seat),
      rejoinCode: '',
      authorityEpoch,
    } satisfies ServerMessage, peerId)
    // SDK 恢复事件到达后，按事件定向补齐持久事实；不周期重发。
    if (game.phase.value === 'opening' && roundStartMessage) {
      diagTx('round_start', peerId)
      room.send(roundStartMessage, peerId)
    }
    broadcastAll(true)
    if (controller.resendPending()) restartTimeout(seatState)
    onPeerRecovered?.(peerId)
  }

  function scheduleSettlementReplay(seatState: (typeof seatStates)[number], peerId: string) {
    const previous = settlementReplayTimers.get(seatState.seat)
    if (previous != null) window.clearTimeout(previous)
    if (!isConfirmationBarrierPhase()) return
    settlementReplayTimers.set(seatState.seat, window.setTimeout(() => {
      settlementReplayTimers.delete(seatState.seat)
      if (!active || seatState.peerId !== peerId || !isConfirmationBarrierPhase()) return
      console.log('[host] 已验证重进握手稳定后，单次延迟重放结算权威事实', {
        seat: seatState.seat,
      })
      recoverPeer(seatState, peerId, true)
    }, 500))
  }

  function retargetVerifiedPeer(fromPeerId: string, assignedSeat: number): boolean {
    const seatState = seatStates.find((state) => state.seat === assignedSeat)
    const controller = seatState?.controller ? asDisconnectable(seatState.controller) : null
    if (!seatState || !controller) return false
    const previousPeerId = seatState.peerId
    const changed = previousPeerId !== fromPeerId
    const wasDisconnected = seatState.disconnected
    const wasAI = controller.isAIControlled()
    clearRecoveryTimer(seatState)
    if (changed) {
      console.log('[host] 大厅验证的新 peer 已恢复原座位，单次补发当前权威事实', {
        seat: assignedSeat,
      })
      controller.retargetPeer(fromPeerId)
      seatState.peerId = fromPeerId
      if (seatByPeer.get(previousPeerId) === assignedSeat) seatByPeer.delete(previousPeerId)
      seatByPeer.set(fromPeerId, assignedSeat)
    }
    seatState.disconnected = false
    if (wasAI) controller.disableAI()
    if (!changed && !wasDisconnected && !wasAI) return false
    diagTx('rejoin_ok', fromPeerId)
    room.send({
      kind: 'rejoin_ok',
      seat: assignedSeat,
      rejoin: true,
      roomId: room.roomId,
      mode,
      rulesetId,
      nickname: seatName(assignedSeat),
      rejoinCode: '',
      authorityEpoch,
    } satisfies ServerMessage, fromPeerId)
    if (game.phase.value === 'opening' && roundStartMessage) {
      diagTx('round_start', fromPeerId)
      room.send(roundStartMessage, fromPeerId)
    }
    broadcastAll(true)
    if (controller.resendPending()) restartTimeout(seatState)
    onPeerRecovered?.(fromPeerId)
    scheduleSettlementReplay(seatState, fromPeerId)
    return true
  }

  // 掉线接管 / 重连恢复：对局中 peer 离开 → AI 接管；peer 重新加入（刷新页面重进）→
  // 恢复真人决策 + 补发座位身份（rejoin_ok），客户端据此恢复本家座位映射。
  room.onPeer((event) => {
    if (!active) return
    if (event.type === 'leave') {
      // SDK 的 leave 也可能只是旧 RTCPeerConnection 被刷新流程关闭；不要立即
      // AI 接管，否则正常刷新/Relay 切换会在下一局结算边界误报掉线。统一走恢复
      // 宽限，真正长期失联后再由计时器接管；有挂起请求时仍由请求超时兜底。
      const seatState = seatStates.find((state) => state.peerId === event.id)
      if (!seatState?.controller) return
      seatState.disconnected = true
      scheduleConnectionRecovery(seatState)
      return
    }
    if (event.type === 'reconnecting') {
      const seatState = seatStates.find((state) => state.peerId === event.id)
      if (!seatState?.controller) return
      // reconnecting 可能只是 P2P → Relay 切路，先留出恢复窗口，不立即 AI 接管。
      seatState.disconnected = true
      scheduleConnectionRecovery(seatState)
      return
    }
    if (event.type === 'relay' && event.active) {
      const seatState = seatStates.find((state) => state.peerId === event.id)
      if (!seatState?.controller) return
      recoverPeer(seatState, event.id)
      return
    }
    if (event.type === 'join' || event.type === 'connecting') {
      const seatState = seatStates.find((state) => state.peerId === event.id)
      if (!seatState?.controller) return
      clearRecoveryTimer(seatState)
      seatState.disconnected = false
      const controller = asDisconnectable(seatState.controller)
      if (controller.isAIControlled()) controller.disableAI()
      diagTx('rejoin_ok', event.id)
      room.send({
        kind: 'rejoin_ok',
        seat: seatState.seat,
        rejoin: true,
        roomId: room.roomId,
        mode,
        rulesetId,
        nickname: seatName(seatState.seat),
        rejoinCode: '',
        authorityEpoch,
      } satisfies ServerMessage, event.id)
      if (game.phase.value === 'opening' && roundStartMessage) {
        diagTx('round_start', event.id)
        room.send(roundStartMessage, event.id)
      }
      // 立即补发一帧快照：重连客户端不应等待下一次引擎状态变化才能看到牌桌。
      broadcastAll(true)
      // 快照之后再重发挂起请求：客户端先有 players/手牌，收到 turn_request 才能
      // 同步手牌并出牌；若请求先到而手牌为空，客户端无法出牌 → 15s 被 AI 代打，
      // 只能等下一轮才恢复（「重进后第一次无法出牌」）。
      // 重发成功 → 从这一刻重新计算掉线超时（旧计时器会误判刚重进的在线玩家掉线）。
      if (controller.resendPending()) restartTimeout(seatState)
      onPeerRecovered?.(event.id)
    }
  })

  // 客户端 join 完成（消息处理链挂好后）会发 lobby_hello；房主据此再补发一次
  // rejoin_ok，避免 join 事件（发生在客户端 join settle 期间、其处理器挂载前）时
  // 直发的 rejoin_ok 被漏掉（刷新页面重进的客户端会因漏收而丢失本家座位）。
  // 同时做 peerId 兜底：刷新后 peerId 可能变化（新标签页），优先按大厅座位表恢复
  room.onMessage((message, fromPeerId) => {
    if (!active) return
    if (typeof message !== 'object' || message === null) return
    if ((message as { type?: unknown }).type !== 'lobby_hello') return
    let seatState = seatStates.find((state) => state.peerId === fromPeerId)
    if (!seatState) {
      // 大厅座位表是权威（hostLobby 已把该座位分配给新 peerId，旧 peerId 已退场），
      // 无需等 AI 接管即可重定向——否则掉线未满 15s（座位还没被 AI 接管）时重连
      // 的新 peerId 永远对不上控制器，直到超时被 AI 接管才恢复，白挨一次代打。
      const assignedSeat = options.getSeatByPeer?.().get(fromPeerId)
      if (assignedSeat !== undefined) {
        if (retargetVerifiedPeer(fromPeerId, assignedSeat)) return
        seatState = seatStates.find((state) => state.seat === assignedSeat)
      }
    }
    // 仅保留无大厅座位表的旧单测/离线调用兼容路径；生产 SDK 流程总是提供
    // getSeatByPeer，身份恢复必须由 vibeLobby 的 playerId 匹配完成，不能按昵称接管座位。
    if (!seatState && !options.getSeatByPeer) {
      const nickname = (message as { nickname?: unknown }).nickname
      const fallback = seatStates.find((state) => {
        if (!state.controller || state.peerId === fromPeerId) return false
        if (seatName(state.seat) !== nickname) return false
        const controller = asDisconnectable(state.controller)
        return state.disconnected || controller.isAIControlled()
      })
      if (fallback) {
        const previousPeerId = fallback.peerId
        seatState = fallback
        const controller = asDisconnectable(fallback.controller!)
        controller.disableAI()
        controller.retargetPeer(fromPeerId)
        fallback.peerId = fromPeerId
        if (seatByPeer.get(previousPeerId) === fallback.seat) seatByPeer.delete(previousPeerId)
        seatByPeer.set(fromPeerId, fallback.seat)
        fallback.disconnected = false
        if (controller.resendPending()) restartTimeout(fallback)
      }
    }
    if (!seatState) return
    const restoredController = seatState.controller ? asDisconnectable(seatState.controller) : null
    const wasDisconnected = seatState.disconnected
    const wasAI = Boolean(restoredController?.isAIControlled())
    clearRecoveryTimer(seatState)
    seatState.disconnected = false
    if (wasAI) restoredController?.disableAI()
    diagTx('rejoin_ok', fromPeerId)
    room.send({
      kind: 'rejoin_ok',
      seat: seatState.seat,
      rejoin: true,
      roomId: room.roomId,
      mode,
      rulesetId,
      nickname: seatName(seatState.seat),
      rejoinCode: '',
      authorityEpoch,
    } satisfies ServerMessage, fromPeerId)
    if (game.phase.value === 'opening' && roundStartMessage) {
      diagTx('round_start', fromPeerId)
      room.send(roundStartMessage, fromPeerId)
    }
    // 同上：补发一帧全量快照，让重连客户端立即看到牌桌（含正在等待中的请求局面）。
    broadcastAll(true)
    // 快照之后再重发挂起请求（见 onPeer('join') 注释：先给手牌、再收回合请求，
    // 否则重进后第一次无法出牌）。重发成功 → 从这一刻重新计算掉线超时。
    const restored = asDisconnectable(seatState.controller!)
    if (restored.resendPending()) restartTimeout(seatState)
    if (wasDisconnected || wasAI) broadcastAll(true)
    onPeerRecovered?.(fromPeerId)
    scheduleSettlementReplay(seatState, fromPeerId)
  })

  // 临时诊断：定位「刷新重进后操作回不去」——客户端动作是否到达房主、是否对上座位。
  room.onMessage((message, fromPeerId) => {
    if (!active) return
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

  // 客户端已收到胡牌特效但缺失最终结算时，按业务事件请求一次权威事实补发。
  // 只接受当前真人座位、当前引擎代次和当前手牌标识；不建立周期同步。
  room.onMessage((message, fromPeerId) => {
    if (!active || typeof message !== 'object' || message === null) return
    const request = message as Partial<SettlementSyncRequest>
    if (request.type !== 'settlement_sync_request') return
    const seatState = seatStates.find((state) => state.peerId === fromPeerId)
    if (!seatState || request.authorityEpoch !== authorityEpoch) return
    if (request.round !== game.round.value || request.honba !== game.honba.value) return
    if (game.phase.value !== 'settled' || game.result.value == null) return
    console.warn('[host] 收到结算事实单次补发请求', {
      seat: seatState.seat, round: request.round, honba: request.honba,
    })
    broadcastAll(true)
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
    if (seatCharacters) {
      for (const [seat, characterId] of seatCharacters) {
        const player = game.players[seat]
        if (player) player.characterId = characterId
      }
    }
    // 临时诊断：定位「闲家方位是房主方位」的座位映射问题。
    console.log('[host] engine seats:', game.players.map((p) => `${p.seat}:${p.name}`).join(' | '))
  }


  // 状态签名去重：引擎 watcher 可能在一次动作里连续触发，避免重复发送同一快照。
  let lastBroadcastKey = ''
  function broadcastAll(force = false) {
    if (!active) return
    // opening 数据可能来自 SDK 的承诺洗牌，在它 resolve 之前引擎仍处于
    // 初始 lobby，players 为空。重连/hello 事件可能先到，此时不能把空玩家表
    // 序列化成 state_snapshot：客户端会把它正确地当成非法快照丢弃，随后开局
    // 看起来就像“房主没有同步”。等 startGame 的 resetPlayers 完成后，首个
    // dealing/opening 快照会正常广播。
    if (game.players.length !== 4) return
    // 等待远端玩家响应（出牌/碰杠胡）或本地引擎 thinking 时不广播普通快照：
    // 否则快照 applyNow 会 clearCountdown、清空 actionPrompt 并把 phase 重置为 playing，
    // 覆盖客户端 requestCoordinator 刚设的 discard/prompt 相位、倒计时与碰杠胡按钮。
    // force（重连补发）除外：新 peerId 必须立刻拿到当前局面，否则永远看不到牌桌。
    const presentationPhase = ['win-effect', 'revealing', 'settled', 'finished'].includes(game.phase.value)
    // 胡牌裁决可能在其他座位的 claim promise 尚未全部执行 finally/onPending(false)
    // 时先进入表现/结算阶段。此时 waitingCount 只是旧请求尾声，不能阻止权威结果
    // 快照；否则点炮等竞争响应会出现“房主结算、客端永远停在旧牌桌”。
    if (!force && !presentationPhase && (waitingCount > 0 || game.phase.value === 'thinking')) return
    // 切局/终局收尾会先清空旧手牌，再把 phase 从 settled 切走。若在这两个同步
    // 写入之间广播，客户端会收到 revealHands=true 但四家手牌全空的“结算事实”，
    // 最终排名出现前会闪现空桌；普通切局也可能在继续倒计时末尾复现同类消失。
    // 亮牌事实必须是完整终态，任一座位为空就保留上一帧，等待 opening/finished
    // 的下一条权威相位覆盖。force 重发也不能绕过这条完整性门槛。
    const requiresCompleteRevealedHands = game.revealHands.value
      && (game.phase.value === 'revealing' || game.phase.value === 'settled')
    if (requiresCompleteRevealedHands && game.players.some((player) => player.hand.length === 0)) {
      console.log('[host] 跳过亮牌已清空但相位尚未切换的过渡快照', {
        phase: game.phase.value,
        round: game.round.value,
        honba: game.honba.value,
      })
      return
    }
    const key = [
      game.phase.value,
      game.round.value,
      game.dealer.value,
      game.honba.value,
      game.currentPlayer.value,
      game.lastDiscard.value?.id ?? 0,
      game.wallHeadDrawn.value,
      game.wall.value.length,
      game.announcement.value?.text ?? '',
      game.result.value?.winnerIndex ?? -1,
      game.winPresentation.value?.winnerIndex ?? -1,
      game.revealHands.value ? 1 : 0,
      game.matchFinished.value ? 1 : 0,
      game.players.map((p) => `${p.hand.join('')}|${p.discards.join('')}|${p.melds.map((m) => m.type + m.tiles.join('')).join('')}|${p.score}|${p.redCount}`).join('~'),
    ].join('#')
    if (!force && key === lastBroadcastKey) return
    // 公共结算/终局事实不含手牌，定向快照才含完整亮牌。两类消息不能共用
    // sequence：若公共事实先到，客户端会把随后同序的定向快照当重复包丢弃，
    // revealHands 开启后就只剩本家手牌、另外三家看起来凭空消失。
    // 公共事实使用较小序号，完整快照紧随其后使用更大序号；无论 SDK 以何种
    // 顺序投递，完整快照都能作为更完整的新事实落地。
    snapshotSequence += 1
    const publicFactSequence = snapshotSequence
    const settledResult = game.phase.value === 'settled' ? game.result.value : null
    const hasPublicFallback = Boolean(settledResult || game.matchFinished.value)
    if (hasPublicFallback) snapshotSequence += 1
    const detailedSnapshotSequence = snapshotSequence
    const localSnapshot = serializeStateToSnapshot(game, 0, {
      ...context,
      sequence: detailedSnapshotSequence,
      requestId: null,
      requestSeq: null,
      includeWall: true,
    })
    const violations = verifySnapshot(localSnapshot)
    if (violations.length) {
      console.warn('[host] 跳过非法权威快照', {
        codes: violations.map((violation) => violation.code),
        messages: violations.map((violation) => violation.message),
        phase: localSnapshot.phase,
        round: localSnapshot.round,
        players: localSnapshot.players.length,
      })
      return
    }
    lastBroadcastKey = key
    if (settledResult) {
      // 完整快照必须按座位定向发送；但公网 SDK 的定向 peer 通道可能在 peers()
      // 仍显示 open 时半开。同步广播一条不含牌墙、但包含结算公开手牌的公共事实，
      // 让当前 Room 内客户端仍能进入胡牌表现、亮明四家手牌和结算。
      diagTx(`round_settled seq=${publicFactSequence}`)
      room.send({
        kind: 'round_settled',
        roomId: room.roomId,
        authorityEpoch,
        sequence: publicFactSequence,
        mode,
        rulesetId,
        round: game.round.value,
        honba: game.honba.value,
        dealer: game.dealer.value,
        result: settledResult,
        winPresentation: game.winPresentation.value,
        winningPlayerIndex: game.winningPlayerIndex.value,
        players: serializeRevealedPlayers(game.players),
        scores: game.players.map((player) => ({
          seat: player.seat,
          name: player.name,
          score: player.score,
        })),
      } satisfies ServerMessage)
    }
    if (game.matchFinished.value) {
      // 终局公共广播不含手牌/牌墙，不能依赖 seatStates 中可能已被 AI 接管、
      // peerId 暂时不可用的定向通道。仍在 Room 中的客户端可凭它可靠进入最终排名。
      diagTx(`match_finished seq=${publicFactSequence}`)
      room.send({
        kind: 'match_finished',
        roomId: room.roomId,
        mode,
        rulesetId,
        finalScores: game.players.map((player, seat) => ({
          seat,
          name: player.name,
          score: player.score,
        })),
        authorityEpoch,
        sequence: publicFactSequence,
        round: game.round.value,
      } satisfies ServerMessage)
    }
    // 用 seatStates 而非开局静态 seatByPeer：刷新重连的客户端 peerId 会变化，
    // seatState.peerId 在恢复时被 retarget 更新。若按旧 map 发送，重连后的新 peerId
    // 永远收不到快照（客户端 players 为空 → 无法响应 turn_request → 14s 被 AI 接管）。
    const sent = new Set<number>()
    for (const state of seatStates) {
      if (state.peerId && !sent.has(state.seat)) {
        sent.add(state.seat)
        const pending = typeof (asDisconnectable(state.controller!).getPendingRequestMeta) === 'function'
          ? asDisconnectable(state.controller!).getPendingRequestMeta()
          : null
        const seatSnapshot = serializeStateToSnapshot(game, state.seat, {
          ...context,
          sequence: detailedSnapshotSequence,
          requestId: pending?.requestId ?? null,
          requestSeq: pending?.requestSeq ?? null,
          includeWall: false,
        })
        const seatViolations = verifySnapshot(seatSnapshot)
        if (seatViolations.length) {
          // 每个座位的暗牌脱敏视图也属于房主权威输出。单个座位序列化异常时
          // 宁可让该座位继续等待当前快照，也不能发送可能泄露牌墙/他人手牌的包。
          console.warn('[host] 跳过非法座位快照', {
            seat: state.seat,
            peerId: state.peerId,
            codes: seatViolations.map((violation) => violation.code),
            messages: seatViolations.map((violation) => violation.message),
          })
          continue
        }
        room.send(seatSnapshot, state.peerId)
        diagTx(`snapshot seat=${state.seat} seq=${detailedSnapshotSequence}`, state.peerId)
      }
    }
    onLocalSnapshot?.(localSnapshot)
  }

  // ── 瞬时事件广播：碰/杠/吃和胡牌表现；settled 快照随后补齐最终结果。──
  let lastTableActionId = -1
  let lastScoreFlowId = -1
  let winEffectSequence = 0

  function broadcastWinEffect(message: WinEffectMessage) {
    if (!active) return
    diagTx(`win_effect seq=${message.sequence}`)
    room.send(message)
  }

  function sendWinEffect(presentation: NonNullable<typeof game.winPresentation.value>) {
    const message: WinEffectMessage = {
      kind: 'win_effect',
      roomId: room.roomId,
      authorityEpoch,
      sequence: ++winEffectSequence,
      round: game.round.value,
      honba: game.honba.value,
      winPresentation: presentation,
      winningPlayerIndex: game.winningPlayerIndex.value,
    }
    broadcastWinEffect(message)
  }

  const stopEventWatchers = [
    watch(() => game.tableActionEvent.value, (event) => {
      if (!active) return
      if (!event || event.id === lastTableActionId) return
      lastTableActionId = event.id
      const message: ServerMessage = { kind: 'table_action', event, authorityEpoch, round: game.round.value }
      diagTx('table_action')
      room.send(message)
      onLocalEvent?.(message)
      broadcastAll()
    }),
    watch(() => game.scoreFlowEvent.value, (event) => {
      if (!active) return
      if (!event || event.id === lastScoreFlowId) return
      lastScoreFlowId = event.id
      const message: ServerMessage = { kind: 'score_flow', deltas: event.deltas, authorityEpoch, round: game.round.value }
      diagTx('score_flow')
      room.send(message)
      onLocalEvent?.(message)
    }),
    watch(() => game.winPresentation.value, (presentation, previous) => {
      if (!active || !presentation || presentation === previous) return
      sendWinEffect(presentation)
    }),
  ]

  function sendRoundStart() {
    if (!active) return
    // 莲花麻将 diceValues 在第二次掷骰时被覆盖，一骰须取 firstDice（对齐单人模式）；
    // 广麻无 firstDice，回退 diceValues（单骰）。flipSeat 让客户端二骰由翻精目标方
    // 投出（对齐单人模式），否则两骰都显示庄家投。
    const dice = game.firstDice?.value ?? game.diceValues.value
    const message: RoundStartMessage = {
      kind: 'round_start',
      roomId: room.roomId,
      authorityEpoch,
      sequence: ++roundStartSequence,
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
    roundStartMessage = message
    diagTx(`round_start seq=${message.sequence}`)
    room.send(message)
    onLocalEvent?.(message)
    broadcastAll()
  }

  // round_start：发牌完成后（phase 进入 opening，此时手牌已齐）广播，触发客户端发牌/骰点动画。
  // watch 须在 startGame 之前注册；用 phase 而非 round（round 首局恒为 1）或 openingStage
  // （instantOpening 下阶段瞬变，watch 会错过中间态）。
  let lastPhase = game.phase.value
  const stopWatch = watch(() => game.phase.value, (phase) => {
    if (!active) return
    if (phase === 'opening' && lastPhase !== 'opening') {
      applySeatProfiles()
      sendRoundStart()
    }
    lastPhase = phase
    // 相位变化立即广播（waiting/thinking 由 broadcastAll 守卫拦截）。
    broadcastAll()
  })

  // 关键状态变化即时广播快照；不使用周期轮询同步牌局。
  const stopImmediateWatchers = [
    watch(() => game.lastDiscard.value, () => { if (active) broadcastAll() }),
    watch(() => game.currentPlayer.value, () => { if (active) broadcastAll() }),
    watch(() => game.wallHeadDrawn.value, () => { if (active) broadcastAll() }),
    // 摸牌瞬间广播：drawFor 在 phase='drawing' 阶段就把摸到的牌推入本家手牌并设置
    // drawnTileIndex，该 Vue flush 先于 beginTurn 把 phase 切成 'thinking'，因此这里
    // 的广播能通过 thinking 守卫。否则各端永远只看到出牌后的 13 张（及碰/杠后的
    // 13-3k），看不到别人摸上来的第 14 张。仅当有人持有摸牌位（drawnTileIndex >= 0）
    // 时广播；换庄复位（全部 -1）不广播，避免把上一局的 settled 结果带回新开局。
    watch(
      () => game.players.map((player) => player.drawnTileIndex).join(','),
      (value) => {
        if (active && value !== '-1,-1,-1,-1') broadcastAll()
      },
    ),
  ]

  function startOpening(opening?: HostOpeningData) {
    if (!active) return
    // 启动本地引擎：先完成逻辑发牌并广播全量快照，再等待房主 viewer 与所有
    // 在线 peer 的 opening_done，最后才进入庄家首回合。
    if (openingBarrierEnabled) {
      const startGameWithBarrier = game.startGame as unknown as (
        mode?: MatchType,
        options?: {
          waitForOpeningReady?: () => Promise<void>
          initialWall?: import('../../core/contracts/types').TileType[]
          openingDice?: [number, number]
          openingSecondDice?: [number, number]
        },
      ) => unknown
      startGameWithBarrier(mode, {
        ...opening,
        waitForOpeningReady: () => openingBarrier.wait(game.round.value, game.honba.value),
      })
    } else {
      game.startGame(mode, opening)
    }
    // 首局覆盖昵称/头像（后续每局由 phase→opening 的 watch 重新覆盖）。
    applySeatProfiles()
  }

  if (options.opening && typeof (options.opening as PromiseLike<HostOpeningData>).then === 'function') {
    void Promise.resolve(options.opening).then(startOpening).catch((error) => {
      if (!active) return
      console.error('[host] 承诺洗牌失败，取消开局:', error)
    })
  } else {
    startOpening(options.opening as HostOpeningData | undefined)
  }

  return {
    game,
    authorityEpoch,
    aiControlledSeats,
    aiControlledSeatsVersion,
    /**
     * 当前可用且非 AI 真人座位表（peerId → seat）：与开局静态 seatByPeer 不同，
     * 重连恢复（retarget）会更新 seatStates 里的 peerId。reconnecting 在恢复窗口内
     * 不触发 AI，但暂不参与续局屏障，避免正常玩家已确认却被旧连接拖住。
     */
    getLivePeerSeats(): Map<string, number> {
      const live = new Map<string, number>()
      for (const state of seatStates) {
        if (state.peerId && !state.disconnected && !asDisconnectable(state.controller!).isAIControlled()) live.set(state.peerId, state.seat)
      }
      return live
    },
    getPeerSeats(): Map<string, number> {
      const peers = new Map<string, number>()
      for (const state of seatStates) {
        if (state.peerId && !asDisconnectable(state.controller!).isAIControlled()) peers.set(state.peerId, state.seat)
      }
      return peers
    },
    getConfirmationSeats(): Map<string, number> {
      const peers = new Map<string, number>()
      for (const state of seatStates) {
        // 这里故意不读取 controller.isAIControlled()，也不排除 disconnected。
        // aiControlledSeats 是房主确认屏障唯一认可的 AI 事实；如果两份状态在
        // 重连竞态中短暂不一致，宁可等待真人确认，也不能错误推进下一局。
        if (state.peerId && !aiControlledSeats.has(state.seat)) peers.set(state.peerId, state.seat)
      }
      return peers
    },
    getDisconnectedSeats(): Set<number> {
      return new Set(seatStates.filter((state) => state.disconnected).map((state) => state.seat))
    },
    /** 业务事件触发的单次权威事实补发；不建立定时广播。 */
    resendCurrentState() {
      broadcastAll(true)
    },
    syncVerifiedPeerSeats(seats: Map<string, number>) {
      // hostLobby 只会把通过稳定 playerId + seatToken 校验的连接放进这个表。
      // roster 更新发生在它处理 lobby_hello 之后；主动消费该事件可消除两个
      // onMessage 监听器的先后竞态。大厅验证的新 peer 无需再碰巧发送第二条 hello。
      for (const [peerId, seat] of seats) retargetVerifiedPeer(peerId, seat)
    },
    markLocalOpeningReady(round: number, honba: number) {
      if (openingBarrierEnabled) openingBarrier.markLocalReady(round, honba)
    },
    /** 外部（续接安全网）强制 AI 接管某座位：掉线但无挂起请求（局末断线）时，
     * 座位永远不会被 15s 超时接管，continue 屏障会永久等待——由安全网兜底接管。 */
    enableAIForSeat(seat: number, options?: { requireRecoveryExpired?: boolean }): boolean {
      if (!active) return false
      const seatState = seatStates.find((state) => state.seat === seat)
      const controller = seatState?.controller ? asDisconnectable(seatState.controller) : null
      if (!seatState || !controller || controller.isAIControlled()) return false
      if (isConfirmationBarrierPhase()) return false
      // 承诺洗牌的超时回调可能晚于一次旧连接事件到达。只有 SDK 已明确把座位标记为
      // disconnected 且恢复宽限计时器已经结束，才允许这条旧回调接管 AI；否则保留
      // 真人控制器，下一次重试使用当前 peerId，避免 P2P → Relay/刷新竞态造成夺舍。
      if (options?.requireRecoveryExpired && (!seatState.disconnected || recoveryTimers.has(seat))) return false
      controller.enableAI()
      return true
    },
    stop() {
      if (!active) return
      active = false
      recoveryTimers.forEach((timer) => window.clearTimeout(timer))
      recoveryTimers.clear()
      settlementReplayTimers.forEach((timer) => window.clearTimeout(timer))
      settlementReplayTimers.clear()
      for (const state of seatStates) {
      if (state.timeout != null) window.clearTimeout(state.timeout)
        asDisconnectable(state.controller!).reset?.()
      }
      roundStartMessage = null
      openingBarrier.cancel()
      stopWatch()
      stopEventWatchers.forEach((stop) => stop())
      stopImmediateWatchers.forEach((stop) => stop())
    },
  }
}
