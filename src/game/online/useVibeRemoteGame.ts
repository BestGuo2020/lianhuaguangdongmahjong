// VibeHub P2P 远程对局 composable（Phase 1/2 组装）：与 useRemoteGame 返回兼容的 GamePort，
// 但房间生命周期走 vibeRoomSession（SDK rooms + vibeLobby），实时对局走 vibeRoomTransport
// （SDK Room P2P 消息）。客户端角色复用 useRemoteGame 的快照驱动逻辑；房主角色另由
// hostGameRunner 组装（后续接入）。
//
// 与 useRemoteGame 的关键差异：
// - 无 rejoin_ok/rejoin_err 握手：mySeat 由大厅 roster 分配（vibeRoomSession）。
// - 座位表用 LobbySeat（含 peerId），isHost 取代 isCreator/creatorSeat。
// - 传输层在 join 后由 vibeRoomTransport 绑定一次（getRoom 返回已加入的 Room）。
import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { defineGamePort, type GamePhase, type GamePort } from '../core/contracts/gamePort'
import type { RoundResult } from '../core/contracts/gamePort'
import { tileName } from '../core/rules/tiles'
import type { MatchType, TileType, WinPresentation } from '../core/contracts/types'
import { createWall } from '../core/rules/tiles'
import { advanceMatchState } from '../core/local/matchProgress'
import { LOTUS_RULESET } from '../variants/lotus/lotusRules'
import { createPlayerSelectors } from '../core/selectors/playerSelectors'
import type { ServerPlayerDto, ServerSnapshot } from './protocol/dto'
import type { ServerMessage, SettlementSyncRequest } from './protocol/messages'
import { decodeServerMessage } from './protocol/decoder'
import { createRemoteSessionStore, generateGuestId } from './session/remoteSessionStore'
import { createVibeRoomSession } from './vibe/vibeRoomSession'
import { getMockPeerId } from './vibe/mockVibeHub'
import { createMatchStatsRecorder } from './vibe/matchStatsRecorder'
import { updatePlayerStats } from './vibe/vibeStats'
import { createVibeRoomTransport } from './transport/vibeRoomTransport'
import { createOpeningTimeline } from './presentation/openingTimeline'
import { createSettlementTimeline } from './presentation/settlementTimeline'
import { createRemoteGameState } from './state/remoteGameState'
import { createSnapshotReconciler } from './orchestration/snapshotReconciler'
import { createServerMessageRouter } from './orchestration/serverMessageRouter'
import { createRequestCoordinator } from './orchestration/requestCoordinator'
import { createRemoteActionController, type RemotePlayerActionMessage } from './orchestration/remoteActionController'
import { createTransientEventPresenter } from './presentation/transientEventPresenter'
import { createRemoteMatchLifecycle } from './orchestration/remoteMatchLifecycle'
import type { LobbySeat } from './vibe/vibeLobby'
import { useGame } from '../core/local/useGame'
import { useLotusGame } from '../variants/lotus/lotusGame'
import { startHostGame, type HostOpeningData } from './host/hostGameRunner'
import { RemotePlayerController } from './host/remotePlayerController'
import { LotusRemotePlayerController } from './host/lotusRemotePlayerController'
import { verifySnapshot } from './antiCheat/publicStateVerifier'
import { runCommittedShuffle, type ShuffleStartMessage } from './antiCheat/committedShuffle'
import type { SnapshotSource } from './host/localStateToSnapshot'
import {
  mapPlayersToLocal,
  mapRoundResultToLocal,
  mapWinPresentationToLocal,
  toLocalSeat,
} from './protocol/mapper'

const MATCH_NAMES = { east: '东风场', hanchan: '半庄场' }
const AUTHORITY_SILENCE_TIMEOUT_MS = 25000

/** 房主自视：把远程动作消息映射到本地权威引擎的动作方法（房主自己就是权威，不走网络）。 */
function sendToEngine(game: GamePort, message: RemotePlayerActionMessage) {
  switch (message.type) {
    case 'discard':
      game.userDiscard(message.handIndex)
      return
    case 'pass':
      game.userPass()
      return
    case 'claim':
      if (message.action === 'peng') game.userPeng()
      else if (message.action === 'gang') game.userGangFromDiscard()
      else if (message.action === 'chi') game.capabilities.value.chi?.choose(message.optionIndex ?? 0)
      return
    case 'gang':
      if (message.kind === 'wind') game.capabilities.value.windKong?.execute()
      else game.userGang(message.tile)
      return
    case 'hu':
      game.userHu()
      return
  }
}

export function isShuffleStartMessage(message: unknown): message is ShuffleStartMessage {
  const value = message as {
    type?: unknown
    round?: unknown
    honba?: unknown
    roundId?: unknown
    roomId?: unknown
    seats?: unknown
    participants?: unknown
    seatCount?: unknown
    authorityEpoch?: unknown
  }
  const seats = Array.isArray(value.seats) ? value.seats : []
  const participants = Array.isArray(value.participants) ? value.participants : []
  const seatCount = value.seatCount
  const participantSeats = participants.map((item) => (
    typeof item === 'object' && item !== null ? (item as { seat?: unknown }).seat : undefined
  ))
  const participantPeers = participants.map((item) => (
    typeof item === 'object' && item !== null ? (item as { peerId?: unknown }).peerId : undefined
  ))
  return typeof message === 'object' && message !== null
    && value.type === 'round_shuffle_start'
    && typeof value.roomId === 'string' && value.roomId.length > 0
    && Number.isInteger(value.round) && (value.round as number) >= 1
    && Number.isInteger(value.honba) && (value.honba as number) >= 0
    && typeof value.roundId === 'string' && value.roundId.length > 0
    && seats.length > 0
    && new Set(seats).size === seats.length
    && Number.isInteger(seatCount) && (seatCount as number) >= 1 && (seatCount as number) <= 4
    && participants.length === seats.length
    && new Set(participantSeats).size === participantSeats.length
    && new Set(participantPeers).size === participantPeers.length
    && seats.every((seat) => Number.isInteger(seat) && (seat as number) >= 0 && (seat as number) < (seatCount as number))
    && participants.every((item) => typeof item === 'object' && item !== null
      && Number.isInteger((item as { seat?: unknown }).seat)
      && ((item as { seat: number }).seat >= 0)
      && ((item as { seat: number }).seat < (seatCount as number))
      && seats.includes((item as { seat: number }).seat)
      && typeof (item as { peerId?: unknown }).peerId === 'string'
      && (item as { peerId: string }).peerId.length > 0)
    && typeof value.authorityEpoch === 'string' && value.authorityEpoch.length > 0
}

/** 后续局承诺洗牌按 `(round, honba)` 单调推进；连庄是同 round 的新手。 */
export function isFutureShuffleHand(
  message: Pick<ShuffleStartMessage, 'round' | 'honba'>,
  currentRound: number,
  currentHonba: number,
): boolean {
  return message.round > currentRound
    || (message.round === currentRound && message.honba > currentHonba)
}

export function isSettlementPresentationReady(
  phase: GamePhase,
  result: RoundResult | null,
): boolean {
  return phase === 'settled' && result != null
}

export function shouldRecoverDowngradedSettlement(
  expectedHand: { round: number; honba: number } | null,
  currentHand: { round: number; honba: number },
  phase: GamePhase,
  result: RoundResult | null,
  wasReady: boolean,
): boolean {
  return expectedHand != null
    && expectedHand.round === currentHand.round
    && expectedHand.honba === currentHand.honba
    && wasReady
    && !isSettlementPresentationReady(phase, result)
}

/**
 * rejoin_ok 只恢复身份，不能把同一房间、同一局已经接受的当前阶段降级回大厅。
 * 这覆盖快照先到、握手后到的消息乱序，也覆盖手机切网后 SDK 重建 Room 的窗口。
 */
export function shouldPreserveRejoinState(
  currentRoomId: string,
  messageRoomId: string,
  currentPhase: GamePhase,
  currentRound: number,
): boolean {
  return currentRoomId.length > 0
    && currentRoomId === messageRoomId
    && currentRound >= 1
    && currentPhase !== 'lobby'
}

export function settlementRecoveryDecision(
  expectedHand: { round: number; honba: number } | null,
  currentHand: { round: number; honba: number },
  timerActive: boolean,
  presentationReady: boolean,
): 'start' | 'keep' | 'retry' | 'idle' {
  if (expectedHand == null
    || expectedHand.round !== currentHand.round
    || expectedHand.honba !== currentHand.honba) return 'start'
  if (timerActive) return 'keep'
  return presentationReady ? 'idle' : 'retry'
}

export function shouldArmAuthoritySilenceTimer(options: {
  isHost: boolean
  matchFinished: boolean
  phase: GamePhase
  openingRunning: boolean
}): boolean {
  return !options.isHost
    && !options.matchFinished
    && options.phase !== 'lobby'
    && options.phase !== 'settled'
    && !options.openingRunning
}

/** 仍需等待「下一局确认」的远端 peer：排除已被 AI 接管（掉线）的座位——
 * 否则掉线玩家永远不会发 continue，全员卡死在「已确认，等待其他玩家」。 */
export function liveContinuePeers(seatByPeer: Map<string, number>, aiControlledSeats: Set<number>): string[] {
  return [...seatByPeer.keys()].filter((peerId) => {
    const seat = seatByPeer.get(peerId)
    return !(seat != null && aiControlledSeats.has(seat))
  })
}

/** 续局屏障按稳定座位判断确认，不能按会变化的 SDK peerId 判断。 */
export function allLiveSeatsConfirmed(
  seatByPeer: Map<string, number>,
  aiControlledSeats: Set<number>,
  confirmedSeats: Set<number>,
): boolean {
  return [...seatByPeer.values()].every((seat) => aiControlledSeats.has(seat) || confirmedSeats.has(seat))
}

interface UseVibeRemoteGameOptions {
  playSound?: (name: string, volume?: number, onFinish?: () => void) => unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  waitForTableReady?: () => Promise<void>
}

export function useVibeRemoteGame({ playSound = () => {}, playSoundAndWait = async () => {}, waitForTableReady }: UseVibeRemoteGameOptions = {}) {
  // 本地 Mock 的多个标签页共享 localStorage，但每个标签页的 SDK peer 是独立的。
  // 用 peer 隔离应用层会话，避免旧会话恢复把不同标签页误合并成同一玩家。
  const sessionNamespace = import.meta.env.DEV ? `mock:${getMockPeerId()}` : undefined
  const sessionStore = createRemoteSessionStore(undefined, { namespace: sessionNamespace })
  // 首次进入生成并持久化访客身份：playerId 是重进时恢复原座位的稳定索引。
  // selfHost/真实 SDK 每次连接 peerId 都是新的（mock 的 peerId 才按标签页稳定），
  // 不能拿 peerId 当身份；若 playerId 恒为空，房主大厅会把座位记录回退成旧
  // peerId，重进的新 peerId 永远匹配不上 → 「重进后连座位都没收到」。
  if (!sessionStore.loadGuestId()) sessionStore.saveGuestId(generateGuestId())
  const state = createRemoteGameState({
    guestId: sessionStore.loadGuestId() || '',
  })
  const {
    sessionStatus, sessionError, roomId, mySeat, nickname, avatar, playerId,
    roomTimeLimit, rulesetId, autoPlay,
    phase, players, wallCount, wall, wallHeadDrawn, currentPlayer, selectedIndex,
    turnSeconds, lastDiscard, actionPrompt, announcement, tableActionEvent,
    scoreFlowEvent, result, winEffect, winPresentation, revealHands,
    winningPlayerIndex, round, dealer, honba, matchType, matchFinished,
    dealAnimation, openingStage, diceValues, diceThrowerIndex, userDrewThisTurn, waitingNextRound,
    secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex,
    turnCanHu, turnCanWindKong,
  } = state

  // SDK 大厅状态：isHost + LobbySeat 座位表（取代 isCreator/creatorSeat/rejoinCode）。
  const isHost = ref(false)
  const lobbySeats = ref<LobbySeat[]>([])

  // 房主对局引擎（开局后懒创建）：房主 UI 直接用它；客户端 UI 用快照状态。
  const hostGame = shallowRef<{
    game: GamePort & SnapshotSource
    authorityEpoch: string
    stop(): void
    aiControlledSeats: Set<number>
    aiControlledSeatsVersion: { value: number }
    getLivePeerSeats(): Map<string, number>
    getDisconnectedSeats(): Set<number>
    resendCurrentState(): void
    syncVerifiedPeerSeats(seats: Map<string, number>): void
    markLocalOpeningReady(round: number, honba: number): void
    getPeerSeats(): Map<string, number>
    getConfirmationSeats(): Map<string, number>
    enableAIForSeat(seat: number, options?: { requireRecoveryExpired?: boolean }): boolean
  } | null>(null)
  let handleRoundShuffleStart: (room: VibeHubSDK.Room, message: ShuffleStartMessage, fromPeerId: string) => void = () => {}
  // 刷新/手动重进不会再次收到大厅 lobby_start；保留一个独立的客户端洗牌处理器，
  // 让已经进入对局的新 Room 也能接收房主重放的 round_shuffle_start。
  let resumedShuffleRoom: VibeHubSDK.Room | null = null
  const resumedShuffleIds = new Set<string>()

  watch(lobbySeats, (seats) => {
    if (!isHost.value || !hostGame.value) return
    hostGame.value.syncVerifiedPeerSeats(new Map(
      seats.filter((seat) => seat.seat > 0).map((seat) => [seat.peerId, seat.seat]),
    ))
  })

  const roomSession = createVibeRoomSession({
    state: {
      roomId, mySeat, nickname, avatar, playerId,
      roomSeats: lobbySeats, sessionStatus, sessionError, rulesetId, matchType, isHost,
      phase,
    },
    loadSavedRoom: () => sessionStore.loadSession(),
    onSeatToken: (token) => sessionStore.saveSeatToken(token),
    onStart: (room, shuffleDetails) => {
      const seatByPeer = new Map<string, number>()
      // 首局参与者只能使用房主随 lobby_start 锁定的映射；本地 roster 可能因
      // SDK 消息乱序仍停留在上一帧，禁止用它反推承诺参与者或偷偷补本端座位。
      for (const participant of shuffleDetails.participants) {
        seatByPeer.set(participant.peerId, participant.seat)
      }
      // lobby_start 已由 createClientLobby 校验本端映射；这里再做一次防御性检查，
      // 保证任何未来绕过大厅控制器的调用都不会启动一套不完整的权威洗牌。
      if (!seatByPeer.has(room.peerId) || seatByPeer.get(room.peerId) !== mySeat.value) return
      function createShufflePromise(
        currentRoom: VibeHubSDK.Room,
        roundId: string,
        participants: Map<string, number>,
        seatCount: number,
        onTimeout?: (missingSeats: number[]) => void,
        authorityEpoch?: string,
      ) {
        return new Promise<HostOpeningData>((resolve, reject) => {
          runCommittedShuffle({
            room: currentRoom,
            roundId,
            seatCount,
            mySeat: mySeat.value,
            authorityEpoch,
            seatByPeer: participants,
            tiles: createWall(),
            onComplete: (initialWall, openingDice, openingSecondDice) => resolve({ initialWall, openingDice, openingSecondDice }),
            onTimeout,
            onError: reject,
          })
        })
      }
      const openingPromise = createShufflePromise(room, shuffleDetails.shuffleId, seatByPeer, shuffleDetails.seatCount)
      const consumedRoundShuffleIds = new Set<string>()
      let shuffleRoom: VibeHubSDK.Room | null = room
      // 后续局由房主先广播参与座位和令牌；客户端只接受真正来自 SDK hostId 的
      // 消息，并参与承诺/揭晓，不在本地创建权威引擎。
      handleRoundShuffleStart = (currentRoom, message, fromPeerId) => {
        if (!acceptPinnedHostMessage(currentRoom, fromPeerId, 'round_shuffle_start')) return
        if (message.roomId !== currentRoom.roomId) return
        if (!message.participants.some((participant) => participant.seat === 0 && participant.peerId === currentRoom.hostId)) return
        if (shuffleRoom !== currentRoom) {
          // 刷新重进后允许同一 roundId 在新 Room 再次参与，不能沿用旧 Room 的
          // consumed 集合把新的洗牌开始消息误判成重复消息。
          shuffleRoom = currentRoom
          consumedRoundShuffleIds.clear()
        }
        const currentEpoch = requestCoordinator.getAuthorityEpoch()
        if (!message.authorityEpoch || !currentEpoch || message.authorityEpoch !== currentEpoch) return
        if (!isFutureShuffleHand(message, round.value, honba.value)
          || message.seatCount < 1 || message.seats.length < 1) return
        if (consumedRoundShuffleIds.has(message.roundId)) return
        if (!message.seats.includes(mySeat.value)) return
        const participants = new Map(message.participants.map((participant) => [participant.peerId, participant.seat] as [string, number]))
        if (participants.get(currentRoom.peerId) !== mySeat.value) return
        // 已收到可信房主的新一轮承诺洗牌，说明“继续”之后仍在正常推进。
        // 一轮承诺最多 15s，房主还可能用新 roundId 重试；不能让固定 20s
        // 的结算看门狗在有效洗牌中途主动断开连接，反过来制造东2局卡死。
        noteNextRoundShuffleProgress()
        consumedRoundShuffleIds.add(message.roundId)
        void createShufflePromise(currentRoom, message.roundId, participants, message.seatCount, undefined, currentEpoch)
          .catch((error) => {
            // 自动重进会让旧 Room 的洗牌 Promise 迟到超时；旧会话已经失效，
            // 不能把这类收尾噪声当成当前房间的洗牌故障。
            consumedRoundShuffleIds.delete(message.roundId)
            if (roomSession.getRoom() === currentRoom) {
              console.warn('[client] 后续局承诺洗牌未完成:', error)
            }
          })
      }
      if (!isHost.value) {
        // 客户端：开局由房主广播的 round_start/state_snapshot 驱动。
        // （房主失联检测在 watch(roomId) 加入房间时已注册——开局时才注册的话，
        // 大厅阶段房主离开没有任何检测，客户端只能干等「网络断开，正在重连」。）
        transport.open()
        void openingPromise.catch((error) => {
          if (roomSession.getRoom() === room) console.warn('[client] 承诺洗牌未完成:', error)
        })
        return
      }
      const seatNames = new Map<number, string>()
      const seatAvatars = new Map<number, string>()
      // round_shuffle_start 是瞬时消息。对局中刷新/Relay 切换可能恰好发生在它发送
      // 前后，因此由房主保留当前消息，等 peer 恢复或 lobby_hello 绑定新 peerId 后
      // 定向重放，避免客户端永远没有机会发承诺。
      let activeRoundShuffle: { room: VibeHubSDK.Room; message: ShuffleStartMessage } | null = null
      let restartActiveRoundShuffle: (() => void) | null = null
      const replayActiveRoundShuffle = (peerId: string) => {
        if (activeRoundShuffle?.room !== room) return
        // peerId 可能是刷新后的新连接。当前承诺协调器已经把旧 peerId
        // 固定进来源校验，单独重放旧消息会让新连接永远无法提交；整轮用最新
        // seat→peer 映射重新开始，旧协调器的完成/超时结果会被 roundId 门禁丢弃。
        if (restartActiveRoundShuffle) {
          restartActiveRoundShuffle()
          return
        }
        room.send(activeRoundShuffle.message, peerId)
      }
      for (const seat of lobbySeats.value) {
        seatNames.set(seat.seat, seat.nickname)
        seatAvatars.set(seat.seat, seat.avatar)
        // 首局承诺映射已经由 lobby_start 锁定；不能把乱序到达的旧 roster
        // peer 混进当前房主的参与者集合。
      }
      // 房主自视：无头引擎的 seat 0 快照/事件喂给本地 viewer，与客户端走同一套表现层。
      const onLocalSnapshot = (snapshot: ServerSnapshot) => snapshotReconciler.apply(snapshot)
      const onLocalEvent = (message: ServerMessage) => handleMessage(message)
      if (rulesetId.value === 'lotus-legacy') {
        hostGame.value = startHostGame({
          room,
          rulesetId: rulesetId.value,
          mode: matchType.value,
          seatByPeer,
          seatNames,
          seatAvatars,
          createController: (r, peerId, onPending, onAI, requestContext) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI, requestContext),
          createGame: (controllers, waitForOpeningReady) => useLotusGame({
            remoteControllers: controllers,
            countdownEnabled: false,
            headless: true,
            waitForOpeningReady,
          }),
          opening: openingPromise,
          getSeatByPeer: () => new Map(lobbySeats.value.filter((s) => s.seat > 0).map((s) => [s.peerId, s.seat])),
          onLocalSnapshot,
          onLocalEvent,
          onPeerRecovered: replayActiveRoundShuffle,
          openingBarrier: true,
        })
      } else {
        hostGame.value = startHostGame({
          room,
          rulesetId: rulesetId.value,
          mode: matchType.value,
          seatByPeer,
          seatNames,
          seatAvatars,
           createController: (r, peerId, onPending, onAI, requestContext) => new RemotePlayerController(r, peerId, onPending, undefined, onAI, requestContext),
          createGame: (controllers, waitForOpeningReady) => useGame({
            remoteControllers: controllers,
            countdownEnabled: false,
            headless: true,
            waitForOpeningReady,
          }),
          opening: openingPromise,
          getSeatByPeer: () => new Map(lobbySeats.value.filter((s) => s.seat > 0).map((s) => [s.peerId, s.seat])),
          onLocalSnapshot,
          onLocalEvent,
          onPeerRecovered: replayActiveRoundShuffle,
          openingBarrier: true,
        })
      }
      // 新房主引擎即使复用了同一个房间号，也拥有全新的 authorityEpoch。
      // 房主自视快照不经过客户端 handleMessage 的 epoch 切换门禁，因此这里
      // 显式把两个本地协调器切到新生命周期，避免返回大厅后再次开局仍沿用旧序号。
      requestCoordinator.setAuthorityEpoch(hostGame.value.authorityEpoch)
      snapshotReconciler.setAuthorityEpoch(hostGame.value.authorityEpoch)
      // 临时诊断：定位「闲家方位是房主方位」的座位映射问题。
      console.log('[host] mySeat:', mySeat.value, 'seatByPeer:', [...seatByPeer.entries()].map(([p, s]) => `${p}->${s}`).join(' | '))
      // 房主动作改道本地权威引擎。
      sendAction = (message) => {
        const game = hostGame.value?.game
        if (game) sendToEngine(game, message)
      }
      // 回合续接：房主等所有「在线」玩家确认「下一局」后才推进；掉线被 AI 接管的
      // 座位不再要求确认（否则永远等不到，卡在「已确认，等待其他玩家」）。
      // 续局确认绑定的是房主锁定的座位，而不是 SDK 临时 peerId。
      // 刷新/Relay 恢复后 peerId 可能变化；若按 peerId 记账，同一个真人会被
      // 错误视为“未确认”，表现为房主一直等待、客户端各自继续重进。
      const continueReadySeats = new Set<number>()
      let hostReadyNext = false
      let advancingRound = false
      function maybeAdvanceRound() {
        const aiSeats = hostGame.value?.aiControlledSeats ?? new Set<number>()
        // reconnecting/leave 处于 hostGameRunner 的恢复宽限内时，该座位仍是真人，
        // 必须保留在确认屏障。只有宽限真正耗尽并切为 AI 后才允许排除；否则一次
        // SDK 短暂 reconnecting 就能绕过真人确认，客户端会从东2直接跳到东3。
        // 用引擎当前的真人座位表（seatStates，重连后 peerId 已 retarget）而非大厅
        // 静态表：重连客户端发来的 continue 携带新 peerId，若按大厅旧 peerId 判定，
        // 永远等不到确认 → 全员卡死在「已确认，等待其他玩家」。
        // 确认屏障必须包含恢复中的真人；getPeerSeats() 是控制器/参与者视图，
        // 可能在 P2P→Relay 或 AI 状态竞态中暂时漏掉座位，不能用来决定是否推进。
        const liveSeats = hostGame.value?.getConfirmationSeats()
          ?? new Map(lobbySeats.value.filter((s) => s.seat > 0).map((s) => [s.peerId, s.seat]))
        const livePeers = liveContinuePeers(liveSeats, aiSeats)
        // 临时诊断：定位「已确认，等待其他玩家」卡死——打印在等谁、谁已确认。
        console.log('[host] continue: ready=', hostReadyNext, 'live=', livePeers.join(','), 'confirmedSeats=', [...continueReadySeats].join(','), 'ai=', [...aiSeats].join(','))
        if (hostReadyNext && !advancingRound && allLiveSeatsConfirmed(liveSeats, aiSeats, continueReadySeats)) {
          hostReadyNext = false
          continueReadySeats.clear()
          const currentGame = hostGame.value?.game
          const result = currentGame?.result.value
          if (!currentGame || !result || currentGame.matchFinished.value) return
          const next = advanceMatchState({
            round: currentGame.round.value,
            dealer: currentGame.dealer.value,
            honba: currentGame.honba.value,
            matchType: currentGame.matchType.value,
            result,
            playerCount: currentGame.players.length,
          })
          // 最后一局无需再洗牌，沿用原有结算推进逻辑直接进入 finished。
          if (next.finished) {
            currentGame.nextRound()
            return
          }
          // 一轮续局最多逐个剔除 3 个远端座位（seat 1-3）。每次只处理本轮
          // 承诺超时明确报告的座位，避免一个玩家掉线后把整个续局永久暂停。
          const MAX_SHUFFLE_RECOVERY_ATTEMPTS = 3
          const startNextRoundShuffle = (participants: Map<string, number>, attempt = 0) => {
            const participantSeats = [...participants.values()].sort((a, b) => a - b)
            if (!participantSeats.includes(0)) participantSeats.unshift(0)
            const roundId = `${room.roomId}:round:${next.round}:honba:${next.honba}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
            const shuffleStart: ShuffleStartMessage = {
              type: 'round_shuffle_start',
              roomId: room.roomId,
              round: next.round,
              honba: next.honba,
              roundId,
              seats: participantSeats,
              participants: [...participants.entries()]
                .map(([peerId, seat]) => ({ peerId, seat }))
                .sort((a, b) => a.seat - b.seat),
              seatCount: 4,
              authorityEpoch: hostGame.value?.authorityEpoch,
            }
            let missingSeats: number[] = []
            advancingRound = true
            activeRoundShuffle = { room, message: shuffleStart }
            restartActiveRoundShuffle = () => {
              if (activeRoundShuffle?.message.roundId !== roundId) return
              const currentParticipants = new Map<string, number>([[room.peerId, 0]])
              for (const [peerId, seat] of (hostGame.value?.getPeerSeats() ?? new Map())) {
                if (!hostGame.value?.aiControlledSeats.has(seat)) currentParticipants.set(peerId, seat)
              }
              startNextRoundShuffle(currentParticipants, attempt)
            }
            room.send(shuffleStart)
            void createShufflePromise(
              room,
              roundId,
              participants,
              shuffleStart.seatCount,
              (missing) => { missingSeats = missing },
              hostGame.value?.authorityEpoch,
              )
              .then((opening) => {
                if (hostGame.value?.game !== currentGame || activeRoundShuffle?.message.roundId !== roundId) return
                if (activeRoundShuffle?.message.roundId === roundId) activeRoundShuffle = null
                restartActiveRoundShuffle = null
                advancingRound = false
                currentGame.nextRound(opening)
              })
              .catch((error) => {
                // 某个 peer 在承诺阶段断开时，第一轮等待可能已经开始，
                // 但 SDK 的 relay/reconnecting 事件要到超时后才到达。把未提交
                // 且当前仍不在线的座位切 AI，并以最新实时 peer 映射重发新的
                // roundId，避免把刚切到 Relay 或已换 peerId 的真人误判成 AI。
                if (
                  missingSeats.length > 0
                  && !missingSeats.includes(0)
                  && attempt < MAX_SHUFFLE_RECOVERY_ATTEMPTS
                ) {
                  if (activeRoundShuffle?.message.roundId === roundId) activeRoundShuffle = null
                  restartActiveRoundShuffle = null
                  // 不用 getLivePeerSeats()：其中会暂时排除 reconnecting/leave 的座位，
                  // 但这类座位仍可能在恢复宽限内通过 Relay 或新 peerId 回来。洗牌重试
                  // 必须保留当前控制器映射，避免把恢复中的真人当成离线 AI。
                  const liveParticipants = hostGame.value?.getPeerSeats() ?? new Map<string, number>()
                  const stillOffline = missingSeats.filter(
                    (seat) => ![...liveParticipants.values()].includes(seat),
                  )
                  for (const seat of stillOffline) {
                    hostGame.value?.enableAIForSeat(seat, { requireRecoveryExpired: true })
                  }
                  const retryParticipants = new Map(liveParticipants)
                  if (!retryParticipants.has(room.peerId)) retryParticipants.set(room.peerId, 0)
                  console.warn(
                    '[host] 后续局有参与者未完成承诺，按实时连接重试:',
                    { missingSeats, stillOffline, retrySeats: [...retryParticipants.values()] },
                  )
                  startNextRoundShuffle(retryParticipants, attempt + 1)
                  return
                }
                if (activeRoundShuffle?.message.roundId !== roundId) return
                if (activeRoundShuffle?.message.roundId === roundId) activeRoundShuffle = null
                restartActiveRoundShuffle = null
                advancingRound = false
                console.error('[host] 后续局承诺洗牌失败，暂停推进:', error)
                transientEventPresenter.announce('本局洗牌校验失败，暂不进入下一局', 'red')
              })
          }
          // 首轮承诺也保留恢复宽限中的真人；续局确认屏障已经只要求 live 座位，
          // 这里不能因为暂时 reconnecting 就把该座位从公平洗牌参与者中删掉。
          const liveParticipants = new Map<string, number>([[room.peerId, 0]])
          for (const [peerId, seat] of (hostGame.value?.getPeerSeats() ?? new Map())) {
            if (!hostGame.value?.aiControlledSeats.has(seat)) liveParticipants.set(peerId, seat)
          }
          startNextRoundShuffle(liveParticipants)
        }
      }
      // 等待确认期间有人被 AI 接管（掉线超时）→ 立即重新评估屏障，不能干等。
      watch(() => hostGame.value?.aiControlledSeatsVersion.value ?? 0, () => maybeAdvanceRound())
      continueAction = () => {
        // 房主明确确认当前结算时，再事件驱动补发一次权威结算事实。客户端必须
        // 先真正收到结算并发送 continue；不能因“20 秒未确认”就把在线真人转 AI
        // 并越过其确认，造成客户端从东2直接跳到东3。
        console.log('[host] 房主确认结算，单次补发当前权威事实；在线及恢复宽限中的真人必须明确确认')
        hostGame.value?.resendCurrentState()
        hostReadyNext = true
        maybeAdvanceRound()
      }
      room.onMessage((message, fromPeerId) => {
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'continue') {
          const value = message as { type?: unknown; round?: unknown; authorityEpoch?: unknown }
          const currentGame = hostGame.value?.game
          // 续局确认也是房主协议的一部分：必须绑定当前房主代次和当前结算轮次，
          // 旧 Room/旧局的 continue 不能提前满足下一局屏障。
          if (
            value.authorityEpoch !== hostGame.value?.authorityEpoch
            || value.round !== currentGame?.round.value
            || typeof value.round !== 'number'
            || !Number.isInteger(value.round)
            || currentGame?.phase.value !== 'settled'
            || currentGame.result.value == null
            || !hostGame.value?.getPeerSeats().has(fromPeerId)
          ) return
          const liveSeat = hostGame.value?.getPeerSeats().get(fromPeerId)
          if (liveSeat == null) return
          continueReadySeats.add(liveSeat)
          maybeAdvanceRound()
        }
      })
    },
    onClosed: () => {
      // 房主主动离开/解散房间（lobby_closed）：
      // - 大厅：提示「房主已关闭房间」并离开（不再干等「网络断开，正在重连」）；
      // - 对局中：只标记权威不可用并尝试恢复，不得在客户端本地伪造最终排名。
      //   最终结算只能来自房主的 finished 快照；否则一个短暂的 P2P/Relay
      //   切换就会把某个客户端永久写成 matchFinished，重进后还会继续落到结算页。
      clearHostGoneTimer()
      if (phase.value === 'lobby') {
        state.sessionError.value = '房主已关闭房间'
        void leaveRoom()
      } else {
        state.sessionError.value = '房主已关闭房间，本局未产生权威终局'
        void leaveRoom()
      }
    },
  })

  // ── 传输层：join 后由 vibeRoomTransport 绑定一次 ──
  const transport = createVibeRoomTransport({
    getRoom: () => roomSession.getRoom(),
    onMessage: handleMessage,
    // 单次 SDK reconnect 对仍标为 open 的半开 DataChannel 可能无效；传输层
    // 只有在 reconnect 后继续收不到匹配 pong 时才升级到完整 leave + resume。
    onHostConnectionLost: () => {
      if (isHost.value || state.matchFinished.value || rejoinInFlight) return
      if (!sessionStore.loadSession()?.roomId) return
      restartRoomSession('房主可靠通道持续无应答')
    },
  })
  const wsStatus = transport.status
  const signalQuality = transport.signalQuality

  // 动作发送：客户端走传输层；房主在 onStart 后改道本地引擎（房主自己就是权威）。
  let sendAction: (message: RemotePlayerActionMessage) => void = (message) => transport.send(message)
  let getCurrentClientRequestId: () => string | null = () => null
  const withCurrentRequestId = (message: RemotePlayerActionMessage): RemotePlayerActionMessage => {
    const requestId = getCurrentClientRequestId()
    return requestId ? { ...message, requestId } : message
  }

  // 房主自视：快照不带 actionPrompt，本家「碰/杠/胡/吃」提示由引擎镜像进本地 viewer。
  watch(() => hostGame.value?.game.actionPrompt.value, (prompt) => {
    if (isHost.value) actionPrompt.value = prompt ?? null
  })

  // 房主自视：引擎无头不计时，本家回合/提示倒计时由 viewer 表现层计时（超时自动出牌/过牌），
  // 与客户端 requestCoordinator 的 12s 倒计时对齐（发牌动画结束后才真正看到回合，故不能在引擎里起跑）。
  let hostCountdownHandle: number | null = null
  function clearHostCountdown() {
    if (hostCountdownHandle != null) {
      globalThis.clearInterval(hostCountdownHandle)
      hostCountdownHandle = null
    }
    turnSeconds.value = 0
  }
  function startHostCountdown(onExpire: () => void) {
    clearHostCountdown()
    turnSeconds.value = 12
    hostCountdownHandle = globalThis.setInterval(() => {
      if (!isHost.value) {
        clearHostCountdown()
        return
      }
      turnSeconds.value -= 1
      if (turnSeconds.value === 3) playSound('didu.ogg')
      if (turnSeconds.value <= 0) {
        clearHostCountdown()
        onExpire()
      }
    }, 1000)
  }
  watch(() => [phase.value, currentPlayer.value, actionPrompt.value] as const, () => {
    if (!isHost.value) return
    const hostTurn = phase.value === 'discard' && currentPlayer.value === 0
    const hostPrompt = phase.value === 'prompt' && actionPrompt.value != null
    if (hostTurn) {
      const last = Math.max(0, (players[0]?.hand.length ?? 1) - 1)
      startHostCountdown(() => sendAction({ type: 'discard', handIndex: last }))
    } else if (hostPrompt) {
      startHostCountdown(() => sendAction({ type: 'pass' }))
    } else {
      clearHostCountdown()
    }
  })

  // ── 内部：定时器 / 延迟队列 ──
  const timers = new Set<number>()

  // ── 座位映射（服务端/房主座位 → 本地索引）────────────────────
  const mySeatLocal = computed(() => (mySeat.value >= 0 ? mySeat.value : -1))
  const toLocal = (serverSeat: number) => toLocalSeat(serverSeat, mySeatLocal.value)

  const settlementTimeline = createSettlementTimeline({
    state: { phase, result, winEffect, winPresentation, revealHands, winningPlayerIndex },
    mapResult: (value) => mapResult(value),
    mapPresentation: (value) => mapWinPresentation(value),
    toLocalSeat: toLocal,
    playSound,
    onResultMissingAfterReveal: (settledRound, settledHonba) => {
      console.warn('[client] 亮牌动画结束仍缺少结算结果，单次请求房主补发结算事实')
      armSettlementRecovery(settledRound, settledHonba, 0, true)
    },
  })
  // win_effect 使用独立于快照的事件序号；新房主生命周期/新场次会显式归零。
  let lastWinEffectSequence = 0
  let settlementRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  let settlementRecoveryHand: { round: number; honba: number } | null = null
  let settlementPresentationWasReady = false
  function clearSettlementRecovery() {
    if (settlementRecoveryTimer != null) {
      window.clearTimeout(settlementRecoveryTimer)
      settlementRecoveryTimer = null
    }
  }
  function clearSettlementRecoveryHand() {
    clearSettlementRecovery()
    settlementRecoveryHand = null
    settlementPresentationWasReady = false
  }
  function armSettlementRecovery(round: number, currentHonba: number, delay = 5000, syncFirst = true) {
    clearSettlementRecovery()
    settlementRecoveryTimer = window.setTimeout(() => {
      settlementRecoveryTimer = null
      // SDK 连接波动时可能临时改变 isHost 视图；只有实际持有权威引擎才是房主。
      if (hostGame.value != null || state.matchFinished.value) return
      if (state.round.value !== round || state.honba.value !== currentHonba) return
      if (syncFirst) {
        // 每次胡牌至多确认一次当前权威结算。即使此刻本地短暂呈现 settled，
        // 也让房主返回一个新 sequence 的持久事实，避免随后到达的更高序非结算
        // 快照把 UI 覆盖后，原看门狗已经错误退出。
        const authorityEpoch = requestCoordinator.getAuthorityEpoch()
        if (authorityEpoch) {
          transport.send({
            type: 'settlement_sync_request', authorityEpoch, round, honba: currentHonba,
          } satisfies SettlementSyncRequest)
        }
        // 返回方向的数据通道半开时，send 可能成功但房主事实永远收不到。只等待
        // 一次 1s 响应窗口即完整重进，给 SDK leave/join 和双端结算 20s 门限留出余量。
        armSettlementRecovery(round, currentHonba, 1000, false)
        return
      }
      if (isSettlementPresentationReady(state.phase.value, state.result.value)) return
      restartRoomSession('胡牌特效后未收到结算事实：结算弹窗未完整就绪（settled/result）')
    }, delay)
  }
  function noteSettlementRecovery(round: number, currentHonba: number) {
    if (hostGame.value != null || state.matchFinished.value) return
    const hand = { round, honba: currentHonba }
    const decision = settlementRecoveryDecision(
      settlementRecoveryHand,
      hand,
      settlementRecoveryTimer != null,
      isSettlementPresentationReady(state.phase.value, state.result.value),
    )
    if (decision === 'start') {
      settlementPresentationWasReady = false
      settlementRecoveryHand = hand
      armSettlementRecovery(round, currentHonba)
      return
    }
    // 同一局的公共事实、定向快照和胡牌事件可能先后到达。它们只能确认同一个
    // 看门狗，不能反复把 5 秒截止时间向后推迟；否则终局密集状态变化会让恢复饥饿。
    if (decision === 'retry') armSettlementRecovery(round, currentHonba, 0, true)
  }
  watch(() => state.winPresentation.value, (presentation) => {
    if (!presentation || hostGame.value != null || state.matchFinished.value) return
    console.log('[client] 胡牌表现状态已出现，确保同局结算恢复截止时间不可延期')
    noteSettlementRecovery(state.round.value, state.honba.value)
  })
  watch(
    () => [state.phase.value, state.result.value, state.round.value, state.honba.value, state.matchFinished.value] as const,
    ([currentPhase, currentResult, currentRound, currentHonba, matchFinished]) => {
      const expectedHand = settlementRecoveryHand
      if (!expectedHand) return
      if (matchFinished || currentRound !== expectedHand.round || currentHonba !== expectedHand.honba) {
        clearSettlementRecoveryHand()
        return
      }
      const ready = isSettlementPresentationReady(currentPhase, currentResult)
      if (ready) {
        settlementPresentationWasReady = true
        return
      }
      if (shouldRecoverDowngradedSettlement(
        expectedHand,
        { round: currentRound, honba: currentHonba },
        currentPhase,
        currentResult,
        settlementPresentationWasReady,
      ) && settlementRecoveryTimer == null && !rejoinInFlight) {
        console.warn('[client] 结算事实已就绪后又被重进握手降级，立即恢复同局结算')
        armSettlementRecovery(currentRound, currentHonba, 0, true)
      }
    },
  )
  const resetWinEffectDedup = () => { lastWinEffectSequence = 0 }
  // openingTimeline 在 requestCoordinator 之前创建；用可后绑定的 getter，确保
  // 开局确认发送时已经拿到当前房主 epoch，而不是捕获旧/空代次。
  let getOpeningAuthorityEpoch = (): string | undefined => undefined
  const openingTimeline = createOpeningTimeline({
    state: {
      phase, players, wall, wallCount, wallHeadDrawn, currentPlayer, selectedIndex,
      actionPrompt, lastDiscard, result, winEffect, winPresentation, revealHands,
      winningPlayerIndex, round, dealer, honba, diceValues, secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex, diceThrowerIndex, openingStage, dealAnimation, announcement,
    },
    toLocalSeat: toLocal,
    mapPlayers: (value) => rotatePlayers(value),
    getAuthorityEpoch: () => getOpeningAuthorityEpoch(),
    playSound,
    playSoundAndWait,
    send: transport.send,
    onFinished: applyBufferedAfterOpening,
    onOpeningDone: (round, currentHonba) => {
      if (isHost.value) hostGame.value?.markLocalOpeningReady(round, currentHonba)
      else armAuthoritySilenceTimer()
    },
    waitForTableReady,
    waitForOpeningSnapshot: Boolean(waitForTableReady),
  })
  const snapshotReconciler = createSnapshotReconciler({
    state,
    getLocalSeat: () => mySeatLocal.value,
    isShowingRoundResult,
    opening: openingTimeline,
    settlement: settlementTimeline,
    clearCountdown,
    onFinishedSnapshot: clearPendingRequest,
    playSound,
    later,
    isLocalAuthority: () => isHost.value,
  })
  const transientEventPresenter = createTransientEventPresenter({
    state,
    getLocalSeat: () => mySeatLocal.value,
    isOpening: openingTimeline.isRunning,
    showServerAnnouncement: snapshotReconciler.showAnnouncement,
    playSound,
    later,
  })

  const user = computed(() => players[0])
  const isUserTurn = computed(() => currentPlayer.value === 0 && phase.value === 'discard')
  const { userCanHu, userKongs, userCurrentWaits, userTingOptions, userDiscardWaits } = createPlayerSelectors({
    players,
    user,
    phase,
    isUserTurn,
    userDrewThisTurn,
    selectedIndex,
    getRuleset: () => (rulesetId.value === 'lotus-legacy' ? LOTUS_RULESET : undefined),
    getJokers: () => jokerTiles.value,
    getWildcards: () => wildcardTiles.value,
  })
  const remoteUserKongs = computed<TileType[]>(() => {
    if (!user.value || !isUserTurn.value || !userDrewThisTurn.value) return []
    const concealed = rulesetId.value === 'lotus-legacy'
      ? LOTUS_RULESET.win.concealedKongs(user.value.hand, { jokers: jokerTiles.value })
      : userKongs.value
    const added = user.value.melds
      .filter((meld) => meld.type === 'peng' && user.value!.hand.includes(meld.tile))
      .map((meld) => meld.tile)
    return [...new Set([...concealed, ...added])]
  })
  // 房主自己的回合不会经过 requestCoordinator，因此快照状态里没有
  // turn_request 携带的 drawnThisTurn/canHu。换庄重新开局后，若继续用
  // viewer 的 userCanHu，房主可能看不到胡按钮，点击也会被拦截；房主
  // 必须直接读取权威引擎的判定。客户端则继续使用请求/快照状态。
  const remoteUserCanHu = computed(() => isHost.value
    ? (hostGame.value?.game.userCanHu.value ?? false)
    : (turnCanHu.value || userCanHu.value))
  // 房主自己的回合同样不走 requestCoordinator，风杠可用性必须镜像权威引擎的判定
  // （否则房主永远收不到 turn_request 的 canWindKong，风杠按钮要么不出现要么乱出现）。
  const remoteUserHasWindKong = computed(() => isHost.value
    ? (hostGame.value?.game.capabilities.value.windKong?.available ?? false)
    : turnCanWindKong.value)
  const windName = computed(() => (round.value > 4 ? '南' : '东'))
  const handNumber = computed(() => ((round.value - 1) % 4) + 1)
  const roundLabel = computed(() => `${windName.value}${handNumber.value}局`)
  const matchName = computed(() => MATCH_NAMES[matchType.value])
  const standings = computed(() => players
    .map((player, index) => ({ ...player, playerIndex: index }))
    .sort((a, b) => b.score - a.score || a.playerIndex - b.playerIndex)
    .map((player, index) => ({ ...player, rank: index + 1 })))
  const remoteActionController = createRemoteActionController({
    state,
    isUserTurn: () => isUserTurn.value,
    canUserHu: () => remoteUserCanHu.value,
    getUser: () => user.value,
    getUserKongs: () => remoteUserKongs.value,
    clearCountdown,
    playSound,
    send: (message) => sendAction(withCurrentRequestId(message)),
  })
  const {
    selectTile,
    clearUserSelection,
    userDiscard,
    pickDiscard: autoPickDiscard,
    toggleAutoPlay,
    userPass,
    userPeng,
    userChi,
    userGangFromDiscard,
    userGang,
    userWindKong,
    userHu,
  } = remoteActionController

  const requestCoordinator = createRequestCoordinator({
    state,
    isBlocked: () => isShowingRoundResult() || openingTimeline.isRunning(),
    isUserTurn: () => isUserTurn.value,
    canUserHu: () => remoteUserCanHu.value,
    getUserHandLength: () => user.value?.hand.length ?? 0,
    toLocalSeat: toLocal,
    announce: transientEventPresenter.announce,
    playSound,
    later,
    actions: {
      // 自动出牌（倒计时结束/autoPlay）：绕过本地 isUserTurn——重进后 phase/currentPlayer
      // 可能被快照覆盖导致 isUserTurn false，本地拒绝发送会让在线玩家永远响应不了，
      // 被房主 25s 超时误判掉线（「AI 夺舍」）。动作合法性由房主权威引擎校验。
      discard: (index) => {
        const me = user.value
        if (!me || index < 0 || index >= me.hand.length) return
        clearCountdown()
        sendAction(withCurrentRequestId({ type: 'discard', handIndex: index }))
      },
      pass: remoteActionController.userPass,
      hu: remoteActionController.userHu,
      pickDiscard: remoteActionController.pickDiscard,
    },
  })
  // ── 个人战绩（vibe.save）：每局结算累计本家手数/胡数/净胜分，终局一次性写入 ──
  // state.result 由 settlementTimeline 落地（winnerIndex/scoreChanges 均已映射到
  // 本家=0），房主自视与客户端都走同一条快照路径；重进补发的同手快照由记录器
  // 按 (epoch, round, honba) 去重，sessionStorage 保证刷新后去重游标不丢失。
  const statsRecorder = createMatchStatsRecorder({ writeStats: updatePlayerStats })
  watch(() => state.result.value, (current) => {
    if (!current || mySeat.value < 0) return
    statsRecorder.noteHandResult({
      result: current,
      epoch: requestCoordinator.getAuthorityEpoch() ?? '',
      round: state.round.value,
      honba: state.honba.value,
    })
  })
  // 回合续接：客户端发 continue 给房主；房主直接推进本地引擎。
  let continueAction: () => void = () => transport.send({
    type: 'continue',
    round: state.round.value,
    authorityEpoch: requestCoordinator.getAuthorityEpoch(),
  })
  getOpeningAuthorityEpoch = () => requestCoordinator.getAuthorityEpoch() ?? undefined
  const matchLifecycle = createRemoteMatchLifecycle({
    state,
    isShowingRoundResult,
    clearTimers,
    opening: openingTimeline,
    settlement: settlementTimeline,
    snapshots: snapshotReconciler,
    requests: requestCoordinator,
    transientEvents: transientEventPresenter,
    sendContinue: () => continueAction(),
    refreshRoom: () => {},
  })
  const { nextRound, returnToLobby: lifecycleReturnToLobby } = matchLifecycle
  function returnToLobby() {
    resetWinEffectDedup()
    if (isHost.value) {
      const runner = hostGame.value
      runner?.game.returnToLobby()
      runner?.stop()
      hostGame.value = null
    }
    lifecycleReturnToLobby()
    // “返回大厅”是回到当前房间大厅，不是离开房间。保留同一个 Room、transport
    // 和保存会话，房主可直接再次开始东风场。Room.onMessage 无退订能力；若这里
    // close 后在同一 Room reopen，会重复注册监听器，第二场每条消息会被处理多次。
    // 真正离开/关闭房间仍由 leaveRoom/closeRoom 统一关闭 transport 并清会话。
  }

  function clearPendingRequest() {
    requestCoordinator.clearPending()
    requestCoordinator.clearCountdown()
  }

  function later(callback: () => void, delay: number) {
    const id = window.setTimeout(() => {
      timers.delete(id)
      callback()
    }, delay)
    timers.add(id)
    return id
  }

  function clearTimers() {
    timers.forEach((id) => window.clearTimeout(id))
    timers.clear()
    requestCoordinator.clearCountdown()
    openingTimeline.cancel()
    settlementTimeline.cancel()
    transientEventPresenter.clear()
  }

  // ── 刷新重进的自愈：SDK 刷新后可能残留旧 RTCPeerConnection（setRemoteDescription
  // on closed PC 报错），数据通道建不起来 → 收不到任何消息。检测「已加入房间但连座位
  // 都没拿到（mySeat < 0，即完全没收到过房主消息）」→ 自动 leave + 重新 join（最多 2 次）。
  // 注意：拿到座位（mySeat >= 0）说明通道可用、已正常进房，绝不能重试（每次重试会换
  // 新 peerId，反而打断昵称兜底恢复）。房主在大厅时客户端本就停在 lobby，也属正常。
  // 重试耗尽仍失败：房间大概率已失效（对局散场/全员离开，旧房间号在 SDK 侧已不存在）——
  // 继续重试毫无意义，清除会话并提示，让用户回大厅重新创建/加入。
  const rejoining = ref(false)
  let rejoinRetries = 0
  let rejoinInFlight = false

  function waitForRejoinDelay(delay: number): Promise<void> {
    return new Promise((resolve) => later(resolve, delay))
  }

  function restartRoomSession(reason: string) {
    if (rejoinInFlight) return
    rejoinInFlight = true
    console.warn(`[client] ${reason}，先释放旧连接再重进`)
    // leave/join 之间旧 Room 仍可能把 setTimeout、pending request 和结算时间线
    // 留在当前 composable 里；先使它们失效，重进后只接受新 Room 的首个权威快照。
    clearTimers()
    requestCoordinator.reset()
    snapshotReconciler.clearPending()
    matchLifecycle.clearRoundBarrier()
    void (async () => {
      try {
        // SDK 的 room.leave() 不会等待旧 RTCPeerConnection 完全收尾；
        // 立即 join 会把迟到的 relay answer 投递到 closed PC，导致第一次重进
        // 经常收不到 lobby_roster。串行 leave → 缓冲 → join，避免半连接重叠。
        await roomSession.leaveRoom()
        await waitForRejoinDelay(2500)
        if (state.matchFinished.value || !sessionStore.loadSession()?.roomId) return
        await roomSession.resumeSession()
      } catch (error) {
        console.warn('[client] 自动重进失败，等待下一次重试:', error)
      } finally {
        rejoinInFlight = false
      }
    })()
  }

  function scheduleRejoinRetry() {
    const retry = () => {
      // restartRoomSession 会先清空 roomId，再等待旧 SDK 连接收尾；此时不能
      // 因 roomId 暂时为空而把后续重试短路，保存会话才是重进期间的依据。
      const savedRoom = sessionStore.loadSession()
      if ((!roomId.value && !savedRoom?.roomId) || mySeat.value >= 0 || state.matchFinished.value || isHost.value) return
      if (rejoinInFlight) {
        later(retry, 3000)
        return
      }
      rejoinRetries += 1
      if (rejoinRetries > 2) {
        rejoining.value = false
        clearSavedSession()
        state.sessionError.value = '房间已失效或无法连接，请重新创建或加入房间'
        return
      }
      rejoining.value = true
      console.warn(`[client] 尝试重新加入房间（第 ${rejoinRetries} 次）——重进后连座位都没收到`)
      restartRoomSession('重进后连座位都没收到')
      // 12s 再查：SDK relay 切换/消息排队时 roster 可能迟到，过短的间隔会自伤——
      // 每次重进都是新 peerId（旧连接在 SDK 里还要挂 120s 才释放），重进越多连接越乱。
      later(retry, 12000)
    }
    later(retry, 12000)
  }
  function resetRejoinRetry() {
    rejoinRetries = 0
    rejoining.value = false
  }
  // 重进成功（拿到座位或成为房主）→ 关闭「尝试重新加入」提示。
  watch([mySeat, isHost], () => {
    if (mySeat.value >= 0 || isHost.value) {
      resetRejoinRetry()
    }
  })

  // 「已确认」失联自愈：客户端确认「下一局」后 waitingNextRound=true，若长时间收不到
  // 推进信号（round_start → handleRoundStart 会把它清回 false），说明与房主的通道断了
  // （SDK relay 协商失败/消息丢失），round_start 永远到不了 → 客户端永远卡在
  // 「已确认，等待其他玩家」。超时自动重进：快照会重同步当前局面、waitingNextRound
  // 随 resetAll 清除，客户端回到新一局而不是干等。
  // 单边确认时，另一位真人可能仍在结算页等待几十秒；房主收到第二次确认后
  // 还要完成最多 3 轮、每轮 15s 的承诺洗牌重试。若从第一位确认就按 35s
  // 重进，会在合法屏障刚打开后打断洗牌，造成客户端回到初始局并让房主永远等不到
  // 当前座位的承诺。90s 覆盖完整重试预算，仍保留有界恢复失败。
  const CONFIRM_RECOVERY_IDLE_MS = 90_000
  const CONFIRM_RECOVERY_SHUFFLE_MS = 90_000
  let confirmRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  function clearConfirmRecovery() {
    if (confirmRecoveryTimer != null) {
      window.clearTimeout(confirmRecoveryTimer)
      confirmRecoveryTimer = null
    }
  }
  function armConfirmRecovery(delay: number) {
    clearConfirmRecovery()
    confirmRecoveryTimer = window.setTimeout(() => {
      confirmRecoveryTimer = null
      if (!state.waitingNextRound.value || state.matchFinished.value) return
      if (!roomId.value || isHost.value) return
      console.warn('[client] 确认后长时间未收到推进信号（通道可能断开），自动重进')
      rejoinRetries += 1
      if (rejoinRetries > 2) {
        rejoining.value = false
        clearSavedSession()
        state.sessionError.value = '房间已失效或无法连接，请重新创建或加入房间'
        return
      }
      rejoining.value = true
      restartRoomSession('确认后长时间未收到推进信号')
      // 本次恢复若仍未拿到座位，继续使用统一的重试退避；成功拿到座位时
      // watch(mySeat) 会把后续计时自然短路。
      scheduleRejoinRetry()
    }, delay)
  }
  function noteNextRoundShuffleProgress() {
    if (!state.waitingNextRound.value || !roomId.value || isHost.value) return
    // 房主每次承诺超时都会发一个新的 round_shuffle_start；每次可信重试都
    // 重新计算空闲窗口。90s 覆盖最多四轮 15s 协议重试及 Relay 抖动。
    armConfirmRecovery(CONFIRM_RECOVERY_SHUFFLE_MS)
  }
  watch(() => state.waitingNextRound.value, (waiting) => {
    if (!waiting || isHost.value || !roomId.value) {
      clearConfirmRecovery()
      return
    }
    armConfirmRecovery(CONFIRM_RECOVERY_IDLE_MS)
  })

  function clearCountdown() {
    requestCoordinator.clearCountdown()
    clearHostCountdown()
  }

  function isShowingRoundResult() {
    return phase.value === 'win-effect'
      || phase.value === 'revealing'
      || (phase.value === 'settled' && result.value != null)
  }

  function mapResult(raw: RoundResult | null): RoundResult | null {
    return mapRoundResultToLocal(raw, mySeatLocal.value)
  }

  function mapWinPresentation(wp: WinPresentation | null): WinPresentation | null {
    return mapWinPresentationToLocal(wp, mySeatLocal.value)
  }

  function rotatePlayers(snapshotPlayers: ServerPlayerDto[]) {
    return mapPlayersToLocal(snapshotPlayers, mySeatLocal.value)
  }

  function applyBufferedAfterOpening() {
    const appliedSnapshot = snapshotReconciler.flush()
    if (appliedSnapshot) requestCoordinator.syncSnapshot(appliedSnapshot)
    requestCoordinator.flush()
  }

  function handleError(code: string) {
    if (code === 'STALE_ACTION' || code === 'INVALID_ACTION') return
    sessionError.value = code
  }

  // 加入房间后保存会话（刷新页面据此自动重进）；模式/规则由快照/元数据校准后刷新。
  watch([roomId, matchType, rulesetId], () => {
    if (!roomId.value) return
    sessionStore.saveSession({
      roomId: roomId.value,
      rejoinCode: '',
      nickname: nickname.value,
      playerId: playerId.value,
      seatToken: sessionStore.loadSession()?.seatToken,
      mode: matchType.value,
      rulesetId: rulesetId.value,
    })
  })

  // 对局结束（正常打完/房主掉线）→ 清除保存的会话：即使没点「返回大厅」直接关页面，
  // 下次刷新/重新进入也是干净大厅，不再自动 resumeSession 加入旧房间号。
  watch(() => state.matchFinished.value, (finished) => {
    if (finished) {
      clearSavedSession()
      clearConfirmRecovery()
      resetRejoinRetry()
      // 终局落地 → 一次性写入个人战绩。记录器按代次去重：重进到终局页补发的
      // 同代次 finished 快照不会重复入账；没观察到任何一局结算的客户端自行跳过。
      void statsRecorder.flushMatch(requestCoordinator.getAuthorityEpoch() ?? '')
    }
  })
  getCurrentClientRequestId = requestCoordinator.getActiveRequestId

  function createResumedShufflePromise(
    currentRoom: VibeHubSDK.Room,
    roundId: string,
    participants: Map<string, number>,
    seatCount: number,
    authorityEpoch: string,
  ) {
    return new Promise<HostOpeningData>((resolve, reject) => {
      runCommittedShuffle({
        room: currentRoom,
        roundId,
        seatCount,
        mySeat: mySeat.value,
        authorityEpoch,
        seatByPeer: participants,
        tiles: createWall(),
        onComplete: (initialWall, openingDice, openingSecondDice) => resolve({ initialWall, openingDice, openingSecondDice }),
        onError: reject,
      })
    })
  }

  // 对局中刷新后没有 lobby_start，不能依赖 onStart 内部才安装的处理器。
  // 房主会在 peer 恢复/hello 后重放当前 round_shuffle_start，客户端在这里重新承诺。
  handleRoundShuffleStart = (currentRoom, message, fromPeerId) => {
    if (!acceptPinnedHostMessage(currentRoom, fromPeerId, 'round_shuffle_start')) return
    if (message.roomId !== currentRoom.roomId) return
    if (!message.participants.some((participant) => participant.seat === 0 && participant.peerId === currentRoom.hostId)) return
    if (resumedShuffleRoom !== currentRoom) {
      resumedShuffleRoom = currentRoom
      resumedShuffleIds.clear()
    }
    const currentEpoch = requestCoordinator.getAuthorityEpoch()
    if (!message.authorityEpoch || !currentEpoch || message.authorityEpoch !== currentEpoch) return
    if (!isFutureShuffleHand(message, round.value, honba.value)
      || message.seatCount < 1 || message.seats.length < 1) return
    if (resumedShuffleIds.has(message.roundId)) return
    if (!message.seats.includes(mySeat.value)) return
    const participants = new Map(message.participants.map((participant) => [participant.peerId, participant.seat] as [string, number]))
    if (participants.get(currentRoom.peerId) !== mySeat.value) return
    noteNextRoundShuffleProgress()
    resumedShuffleIds.add(message.roundId)
    void createResumedShufflePromise(currentRoom, message.roundId, participants, message.seatCount, currentEpoch)
      .catch((error) => {
        // 允许房主在同一 roundId 上重放：本次承诺已经结束，不能被去重集合挡住。
        resumedShuffleIds.delete(message.roundId)
        if (roomSession.getRoom() === currentRoom) console.warn('[client] 重进后承诺洗牌未完成:', error)
      })
  }

  // 重连/加入后绑定传输层：对局进行中刷新页面重进时没有 lobby_start（onStart 里的
  // transport.open() 不触发），必须在此挂上 room.onMessage 才能收到快照/turn_request。
  // 客户端：绑定业务消息；房主：signalOnly 只监听 SDK 连接事件，不转发业务消息，
  // 避免收到自己广播的回环；信号质量读取 SDK 的只读网络统计。
  // 同时注册房主失联检测：随「加入房间」生效（大厅/对局都覆盖）。
  watch(roomId, (value) => {
    if (!value) {
      // 内部完整重进直接调用 roomSession.leaveRoom，不经过外层 closeConnection。
      // roomId 清空时立即封存旧 Room 的监听代次，避免旧 SDK 队列污染新会话。
      transport.close()
      hostGoneBoundRoom = null
      pinnedHostPeerId = null
      hostRecovering = false
      clearHostGoneTimer()
      return
    }
    console.log('[client] 新 Room 状态写入时同步绑定业务监听，再发送大厅恢复握手')
    transport.open({ signalOnly: isHost.value })
    if (!isHost.value) {
      const room = roomSession.getRoom()
      if (room) {
        pinnedHostPeerId = room.hostId ?? null
        bindHostGoneDetection(room)
      }
    }
  }, { flush: 'sync' })

  // ── 消息分发（客户端：无 rejoin 握手，mySeat 由大厅 roster 分配）──
  // 注：重进后的发牌动画不再跳过——之前 instant（跳过动画）是为缓解「重进 AI 夺舍」
  // 而加（动画期间缓存的 turn_request 响应晚于 18s 掉线超时）；现在掉线超时已放宽到
  // 25s（动画 ≈8s + 客户端 12s 倒计时 ≈20s < 25s），正常播动画也不会误判掉线。
  const serverMessageRouter = createServerMessageRouter({
    rejoin_ok: (msg) => {
      // 刷新页面重进：房主补发的座位身份 → 恢复本家座位映射（对局进行中快照即重同步）。
      // 旧 Room 的房主失联回调可能曾把本地错误置为最终结算；收到当前房主的
      // rejoin_ok 说明会话已恢复，先清掉这个残留和旧 Room 的所有本地请求/计时器，
      // 随后只以当前房主快照及其重新下发的当前请求为准。不能保留旧 pending request，
      // 否则重进后旧回合的 countdown 会继续跑到 3 秒并自动弃牌。
      clearTimers()
      requestCoordinator.reset()
      requestCoordinator.setAuthorityEpoch(msg.authorityEpoch)
      resetWinEffectDedup()
      snapshotReconciler.setAuthorityEpoch(msg.authorityEpoch)
      snapshotReconciler.clearPending()
      matchLifecycle.clearRoundBarrier()
      const preserveCurrentState = shouldPreserveRejoinState(
        state.roomId.value,
        msg.roomId,
        state.phase.value,
        state.round.value,
      )
      // 若同房间当前局的快照已经先到，rejoin_ok 不能把 settled/playing/dealing
      // 降级回大厅；后续快照仍可继续校准。只有真正尚未收到当前局事实的 lobby
      // 状态才清理旧表现并保持大厅占位。
      if (!preserveCurrentState) {
        state.result.value = null
        state.winEffect.value = null
        state.winPresentation.value = null
        state.revealHands.value = false
        state.winningPlayerIndex.value = -1
        transientEventPresenter.clear()
        state.announcement.value = null
        state.actionPrompt.value = null
        state.waitingNextRound.value = false
        state.matchFinished.value = false
        state.phase.value = 'lobby'
      }
      state.mySeat.value = msg.seat
      if (msg.roomId) state.roomId.value = msg.roomId
      state.sessionStatus.value = 'connected'
    },
    rejoin_err: () => {},
    state_snapshot: (msg) => {
      // round_start 是瞬时消息。客户端刷新/重进期间可能只收到房主补发的
      // state_snapshot，若仍停留在上一局结算页，reconciler 会把新一局快照缓存起来，
      // waitingNextRound 也不会清掉，随后就会错误触发“确认后长时间未收到推进信号”。
      const previousRound = state.round.value
      const accepted = snapshotReconciler.apply(msg)
      if (accepted && msg.phase === 'settled' && msg.result != null) {
        noteSettlementRecovery(msg.round, msg.honba)
      }
      // round_start 是瞬时消息；若它在 P2P/Relay 切换窗口丢失，当前房主的
      // opening 快照仍可恢复同一套表现参数，不能直接跳过客户端开局动画。
      matchLifecycle.handleOpeningSnapshot(msg)
      // 必须先让 reconciler 完成房间/epoch/sequence 门禁，再清理本地结算残留。
      // 否则一条序列倒退但 round 较大的迟到快照，仍会在快照被拒绝后把本地 UI
      // 提前切到 playing，造成“房主等待、客户端已进入下一局”的分叉。
      const roundAdvanced = msg.round > previousRound
      if (accepted && roundAdvanced && state.waitingNextRound.value && !msg.matchFinished) {
        clearTimers()
        matchLifecycle.clearRoundBarrier()
        snapshotReconciler.clearPending()
      }
      // 快照明确了当前房主正在等待哪个请求；没有挂起请求则销毁客户端旧
      // request/autoPlay 代次。只有随后收到同 requestId 的房主请求才会启动倒计时。
      // 被序列号拒绝的迟到快照不能反过来清理当前请求。
      if (accepted) requestCoordinator.syncSnapshot(msg)
    },
    round_start: (msg) => matchLifecycle.handleRoundStart(msg),
    win_effect: (msg) => {
      if (msg.sequence <= lastWinEffectSequence) return
      lastWinEffectSequence = msg.sequence
      settlementTimeline.startEffect(msg)
      noteSettlementRecovery(msg.round, msg.honba)
    },
    round_settled: (msg) => {
      // 不要仅凭收到结算包就撤销恢复计时。公共 round_settled 与定向快照可能
      // 共用 sequence，前者会被幂等门禁拒绝；即使事实被接受，表现时间线也仍
      // 可能没有把 result 落到 UI。8 秒回调会以实际 settled/result 状态判定。
      if (snapshotReconciler.applySettlementNotice(msg)) {
        noteSettlementRecovery(msg.round, msg.honba)
      }
    },
    turn_request: requestCoordinator.apply,
    claim_request: requestCoordinator.apply,
    rob_kong_request: requestCoordinator.apply,
    table_action: transientEventPresenter.handleTableAction,
    score_flow: transientEventPresenter.handleScoreFlow,
    announcement: transientEventPresenter.handleAnnouncement,
    // 房主当前只通过 state_snapshot 广播结算结果；hand_result 是旧协议的瞬时
    // 事件，不能单独修改 phase/result。否则旧 Room 的迟到事件会让客户端提前
    // 进入结算页，随后与房主的下一局快照分叉。
    hand_result: () => {},
    continue_prompt: () => {},
    // vibehub 房主不发送独立终局事件，终局唯一以带 epoch/sequence 的
    // state_snapshot 为准。保留协议分支但不允许事件单独把客户端写成终局，
    // 终局用不含暗牌的公共消息可靠广播；即使该座位在房主侧临时被 AI 接管、
    // 定向 finished 快照没有可达 peerId，仍能进入最终排名。
    match_finished: (msg) => {
      clearTimers()
      requestCoordinator.reset()
      snapshotReconciler.clearPending()
      matchLifecycle.clearRoundBarrier()
      for (const entry of msg.finalScores) {
        const player = state.players[toLocal(entry.seat)]
        if (!player) continue
        player.name = entry.name
        player.score = entry.score
      }
      state.matchType.value = msg.mode
      if (msg.rulesetId) state.rulesetId.value = msg.rulesetId
      state.result.value = null
      state.winEffect.value = null
      state.winPresentation.value = null
      state.revealHands.value = false
      state.winningPlayerIndex.value = -1
      state.waitingNextRound.value = false
      state.actionPrompt.value = null
      state.matchFinished.value = true
      state.phase.value = 'finished'
    },
    room_closed: () => { void leaveRoom() },
    pong: () => {},
    error: (msg) => handleError(msg.code),
  })

  // 房主失联判定定时器（客户端）：加入房间即注册（见 bindHostGoneDetection）；
  // 收到房主任何业务消息（handleMessage）即取消——「房主恢复」以收到消息为准，
  // SDK 的 connecting/join 事件只是自身重连流程，不能当作恢复。
  let hostGoneTimer: ReturnType<typeof setTimeout> | null = null
  let authoritySilenceTimer: ReturnType<typeof setTimeout> | null = null
  let hostGoneBoundRoom: VibeHubSDK.Room | null = null
  // 牌局会话内固定最初的 SDK 房主；SDK 选出的新 peer 没有旧引擎状态，
  // 不能被客户端误认成可继续广播牌局的权威。
  let pinnedHostPeerId: string | null = null
  // Relay 切换期间等待 SDK 的 reconnecting/relay 事件结果，避免主动关闭仍在
  // 协商的 RTCPeerConnection。
  let hostRecovering = false

  /**
   * 所有会改变客户端对局语义的房主消息都必须走同一个身份门禁。
   *
   * `round_shuffle_start` 不属于 ServerMessage，不能经过下面的 decode/route
   * 链路，因此尤其容易漏掉“锁定的原始房主”校验。SDK 在 P2P 失联时可能更新
   * `room.hostId`，但这不等于新 peer 拥有当前引擎的隐藏牌墙和回合状态；此处
   * 必须把这种变化视为不可恢复的权威丢失，而不是接受新 host 的状态。
   */
  function acceptPinnedHostMessage(currentRoom: VibeHubSDK.Room, fromPeerId: string, kind: string): boolean {
    if (isHost.value || !fromPeerId || !currentRoom.hostId) return false
    const currentHostPeerId = currentRoom.hostId
    if (pinnedHostPeerId && currentHostPeerId !== pinnedHostPeerId) {
      console.warn('[client] 检测到房主身份变化，拒绝新房主状态', {
        previousHostId: pinnedHostPeerId, currentHostPeerId, kind,
      })
      requestAuthorityRecovery('房主身份发生变化')
      return false
    }
    if (pinnedHostPeerId == null) pinnedHostPeerId = currentHostPeerId
    if (fromPeerId !== pinnedHostPeerId) {
      console.warn('[client] 丢弃非房主游戏消息', fromPeerId, kind)
      return false
    }
    return true
  }

  function clearHostGoneTimer() {
    if (hostGoneTimer != null) {
      window.clearTimeout(hostGoneTimer)
      hostGoneTimer = null
    }
  }

  function clearAuthoritySilenceTimer() {
    if (authoritySilenceTimer != null) {
      window.clearTimeout(authoritySilenceTimer)
      authoritySilenceTimer = null
    }
  }

  function armAuthoritySilenceTimer() {
    clearAuthoritySilenceTimer()
    if (!shouldArmAuthoritySilenceTimer({
      isHost: isHost.value,
      matchFinished: state.matchFinished.value,
      phase: phase.value,
      openingRunning: openingTimeline.isRunning(),
    })) return
    authoritySilenceTimer = window.setTimeout(() => {
      authoritySilenceTimer = null
      if (!shouldArmAuthoritySilenceTimer({
        isHost: isHost.value,
        matchFinished: state.matchFinished.value,
        phase: phase.value,
        openingRunning: openingTimeline.isRunning(),
      })) return
      // 不是应用层心跳：只在连续静默达到一次性截止时间后，针对当前手牌请求一次
      // 权威事实。25s 严格大于正常真人 12s 回合倒计时，并与房主远程请求超时对齐；
      // 否则计时器会与玩家正常决策竞态，把在线玩家误判为半开通道。若通道
      // 半开，send 看似成功但 1s 内仍无任何房主消息，再完整 leave + resume。
      const authorityEpoch = requestCoordinator.getAuthorityEpoch()
      if (!authorityEpoch) {
        requestAuthorityRecovery('对局权威静默且缺少房主代次')
        return
      }
      console.warn('[client] 对局权威连续静默，单次请求当前手牌事实')
      const sent = transport.send({
        type: 'settlement_sync_request',
        authorityEpoch,
        round: state.round.value,
        honba: state.honba.value,
      } satisfies SettlementSyncRequest)
      if (!sent) return
      authoritySilenceTimer = window.setTimeout(() => {
        authoritySilenceTimer = null
        if (!shouldArmAuthoritySilenceTimer({
          isHost: isHost.value,
          matchFinished: state.matchFinished.value,
          phase: phase.value,
          openingRunning: openingTimeline.isRunning(),
        })) return
        requestAuthorityRecovery('当前手牌事实单次请求仍无响应')
      }, 1000)
    }, AUTHORITY_SILENCE_TIMEOUT_MS)
  }

  function requestAuthorityRecovery(reason: string) {
    if (isHost.value || state.matchFinished.value) return
    state.sessionStatus.value = 'reconnecting'
    transientEventPresenter.announce('房主连接中断，正在恢复牌局', 'gold')
    if (!rejoinInFlight && sessionStore.loadSession()?.roomId) restartRoomSession(reason)
  }

  /** 房主失联检测（客户端）：对局中 30s 无消息 → 结束对局；大厅 8s → 离开房间并提示。
   * 必须随「加入房间」注册（watch(roomId)），不能只在开局（onStart）注册——否则大厅
   * 阶段房主离开没有任何检测，客户端只能干等「网络断开，正在重连」几十秒。 */
  function bindHostGoneDetection(room: VibeHubSDK.Room) {
    if (hostGoneBoundRoom === room) return
    hostGoneBoundRoom = room
    room.onPeer((event) => {
      if (hostGoneBoundRoom !== room) return
      if (event.type === 'error') return
      if (event.type === 'relay') {
        if (event.active) {
          hostRecovering = false
          clearHostGoneTimer()
        }
        return
      }
      // 用 SDK 的 room.hostId 判定房主（权威），不用 roster 匹配——roster 可能因
      // 未同步/被清而缺失 seat 0，导致房主离开事件被跳过（客户端只看到「网络断开，
      // 正在重连」横幅，房间/房主却还显示着）。
      if (event.id !== room.hostId) return
      if (state.matchFinished.value) return
      const leaveLobby = () => {
        state.sessionError.value = '房主已关闭房间'
        void leaveRoom()
      }
      if (event.type === 'leave') {
        // 房主主动离开（含大厅解散房间）：立即判定，不等超时。
        hostRecovering = false
        clearHostGoneTimer()
        if (phase.value === 'lobby') leaveLobby()
        else {
          requestAuthorityRecovery('房主连接中断')
        }
        return
      }
      if (event.type === 'reconnecting') {
        // 房主失联：进入重连等待（对局 30s / 大厅 4s），超时仍无恢复即判定掉线。
        // 对局给 30s 是给房主「重新接管」的机会：房主页面还开着（网络抖动/断线）时
        // SDK 会重连，引擎状态还在房主内存里——期间收到房主任何业务消息（快照/请求）
        // 就取消判定（handleMessage），房主回来即恢复对局。只有刷新页面（引擎状态丢失）
        // 或彻底失联 30s，才结束对局。
        hostRecovering = true
        if (hostGoneTimer == null) {
          hostGoneTimer = window.setTimeout(() => {
            hostGoneTimer = null
            if (state.matchFinished.value) return
            if (phase.value === 'lobby') leaveLobby()
            else {
              requestAuthorityRecovery('房主长时间无响应')
            }
          }, phase.value === 'lobby' ? 15000 : 30000)
        }
        return
      }
      if (event.type === 'join' || event.type === 'connecting') {
        hostRecovering = false
        clearHostGoneTimer()
      }
    })
  }

  function handleMessage(raw: unknown, fromPeerId?: string) {
    // 房主的引擎是唯一事实来源。房主 viewer 的本地事件通过无 fromPeerId
    // 进入这里；任何来自远端的 ServerMessage 都不能反向写入房主表现层，
    // 更不能借 rejoin_ok/state_snapshot 改写房主自己的座位、房间或终局状态。
    // 远端动作、continue、洗牌承诺分别由 hostGameRunner 的专用监听器处理。
    if (isHost.value && fromPeerId) return
    const room = roomSession.getRoom()
    if (isShuffleStartMessage(raw)) {
      if (room && fromPeerId) handleRoundShuffleStart(room, raw, fromPeerId)
      return
    }
    const decoded = decodeServerMessage(raw)
    // 大厅 hello/ready/ping、continue 等消息也会经过同一个 Room handler，但它们
    // 不是游戏消息，不应被误报成「非房主游戏消息」。先解码筛出游戏协议，再做房主校验。
    if (!decoded) {
      if (!isHost.value && typeof raw === 'object' && raw != null && (raw as { kind?: unknown }).kind !== 'round_shuffle_start') {
        // 诊断：只打印消息类型与字段形状（key:类型），不打印任何牌面/分数/凭据值。
        // sourceIndex/winningPlayerIndex 等索引数字除外（它们本身不是牌面内容）。
        const record = raw as Record<string, unknown>
        const shape = Object.entries(record).map(([key, value]) => (
          `${key}:${value === null ? 'null' : Array.isArray(value) ? `array[${(value as unknown[]).length}]` : typeof value}`
        )).join(',')
        const presentation = record.winPresentation as Record<string, unknown> | null | undefined
        const wp = presentation ? ` wp=${['winnerIndex', 'sourceIndex', 'robbedKongPlayerIndex', 'robbedKongMeldIndex', 'robbedKong']
          .map((key) => `${key}=${JSON.stringify(presentation[key])}`).join(',')}` : ''
        console.log(`[diag] client-msg 解码失败 kind=${(raw as { kind?: unknown }).kind ?? 'unknown'} shape=${shape}${wp}`)
      }
      return
    }
    // SDK Room 的消息可以来自任意 peer；客户端只信任当前会话绑定的房主。
    // 房主自视事件通过本地调用进入，此时没有 fromPeerId。
    // ServerMessage 的所有类型都由当前房主发出：包括 room_closed/error 这类没有
    // authorityEpoch、但仍能改变客户端会话状态的消息，以及 pong/continue_prompt
    // 这类当前不改变状态的消息。统一门禁可避免以后新增 handler 时漏校验来源。
    if (!isHost.value && room && !acceptPinnedHostMessage(room, fromPeerId ?? '', decoded.kind)) return
    const authorityEpoch = 'authorityEpoch' in decoded
      ? (decoded.authorityEpoch as string | undefined)
      : undefined
    const authorityMessage = decoded.kind === 'state_snapshot'
      || decoded.kind === 'round_start'
      || decoded.kind === 'win_effect'
      || decoded.kind === 'round_settled'
      || decoded.kind === 'turn_request'
      || decoded.kind === 'claim_request'
      || decoded.kind === 'rob_kong_request'
      || decoded.kind === 'table_action'
      || decoded.kind === 'score_flow'
      || decoded.kind === 'announcement'
      || decoded.kind === 'hand_result'
      || decoded.kind === 'match_finished'
      || decoded.kind === 'rejoin_ok'
    if (!isHost.value && authorityMessage && !authorityEpoch) {
      console.warn('[client] 丢弃缺少房主代次的游戏消息', { fromPeerId, kind: decoded.kind })
      return
    }
    // 所有会改变本地牌桌/会话的 envelope 校验必须早于 epoch 切换；否则一条
    // 发给其他座位或其他房间的旧握手，可能先污染当前客户端的 authorityEpoch。
    const expectedSeat = mySeat.value >= 0
      ? mySeat.value
      : lobbySeats.value.find((seat) => seat.peerId === room?.peerId)?.seat
    if (!isHost.value && decoded.kind === 'state_snapshot') {
      if (room && decoded.roomId !== room.roomId) {
        console.warn('[client] 丢弃其他房间快照', { fromPeerId, roomId: decoded.roomId, currentRoomId: room.roomId })
        return
      }
      if (expectedSeat == null || decoded.seat !== expectedSeat) {
        // 房主快照包含按目标座位脱敏后的手牌；即使消息来自当前房主，也不能把
        // 发给另一座位的全量/半隐藏状态落到本地，避免误投递造成状态和信息泄露。
        console.warn('[client] 丢弃发给其他座位的房主快照', {
          fromPeerId, targetSeat: decoded.seat, expectedSeat,
        })
        return
      }
    }
    if (!isHost.value && (decoded.kind === 'win_effect' || decoded.kind === 'round_settled' || decoded.kind === 'match_finished' || decoded.kind === 'rejoin_ok')
      && room && decoded.roomId !== room.roomId) {
      console.warn('[client] 丢弃其他房间的房主消息', {
        fromPeerId, kind: decoded.kind, roomId: decoded.roomId, currentRoomId: room.roomId,
      })
      return
    }
    if (!isHost.value && decoded.kind === 'rejoin_ok'
      && expectedSeat != null && decoded.seat !== expectedSeat) {
      console.warn('[client] 丢弃发给其他座位的重进握手', {
        fromPeerId, targetSeat: decoded.seat, expectedSeat,
      })
      return
    }
    const requestMessage = decoded.kind === 'turn_request'
      || decoded.kind === 'claim_request'
      || decoded.kind === 'rob_kong_request'
    if (!isHost.value && requestMessage
      && (expectedSeat == null || decoded.targetSeat !== expectedSeat)) {
      console.warn('[client] 丢弃发给其他座位的房主请求', {
        fromPeerId, kind: decoded.kind, targetSeat: decoded.targetSeat, expectedSeat,
      })
      return
    }
    if (!isHost.value && decoded.kind === 'round_start'
      && (decoded.sequence == null || !Number.isInteger(decoded.sequence) || decoded.sequence < 1)) {
      // 轮次开局事件会清空本地结算/手牌并启动发牌动画；生产协议必须带序号，
      // 否则旧 SDK 队列里的重复 round_start 无法和当前轮次区分。
      console.warn('[client] 丢弃缺少开局序号的房主消息', { fromPeerId, round: decoded.round })
      return
    }
    if (!isHost.value && decoded.kind === 'round_start'
      && (!room || decoded.roomId !== room.roomId)) {
      console.warn('[client] 丢弃其他房间的房主开局消息', {
        fromPeerId, roomId: decoded.roomId, currentRoomId: room?.roomId,
      })
      return
    }
    // 同一房间第二场：返回大厅后房主再次开局会创建全新引擎（新 authorityEpoch）。
    // 新一局的首个 round_start（round=1、客户端尚在大厅）就是新生命周期的边界，
    // 必须允许代次切换；否则新引擎的所有消息（round_start/快照/请求）都会被
    // 「旧房主代次」门禁丢弃，客户端永远停在大厅而房主已进入新对局（线上双场
    // 第二场开局失败，4 连复现）。round=1 + lobby 相位双重限定：旧引擎已停止，
    // 其迟到消息不可能再以 round=1 + lobby 相位出现，杜绝代次回退。
    const newMatchBoundary = decoded.kind === 'round_start'
      && decoded.round === 1
      && state.phase.value === 'lobby'
      && authorityEpoch != null
    if (decoded.kind === 'rejoin_ok' && authorityEpoch) {
      // rejoin_ok 是当前 SDK 房主对新引擎生命周期的握手，允许它切换到新的
      // epoch；其它消息不能自行切换代次。
      requestCoordinator.setAuthorityEpoch(authorityEpoch)
      snapshotReconciler.setAuthorityEpoch(authorityEpoch)
    } else if (newMatchBoundary) {
      requestCoordinator.setAuthorityEpoch(authorityEpoch)
      snapshotReconciler.setAuthorityEpoch(authorityEpoch)
    } else if (authorityEpoch && !requestCoordinator.acceptAuthorityEpoch(authorityEpoch)) {
      console.warn('[client] 丢弃旧房主代次消息', { fromPeerId, kind: decoded.kind })
      return
    }
    if ('round' in decoded && typeof decoded.round === 'number' && decoded.round < state.round.value) {
      console.warn('[client] 丢弃旧轮次消息', { fromPeerId, kind: decoded.kind, round: decoded.round, currentRound: state.round.value })
      return
    }
    if (decoded?.kind === 'state_snapshot') {
      const violations = verifySnapshot(decoded)
      if (violations.length) {
        // 不要只打印数组对象：生产浏览器控制台经常把它折叠成空标题，
        // 导致无法判断是旧房主快照、玩家数不足，还是牌墙进度异常。
        console.warn('[client] 丢弃非法状态快照', {
          fromPeerId,
          roomHostId: room?.hostId,
          codes: violations.map((violation) => violation.code),
          messages: violations.map((violation) => violation.message),
          snapshot: {
            phase: decoded.phase,
            round: decoded.round,
            seat: decoded.seat,
            players: decoded.players.length,
            wallCount: decoded.wallCount,
            headDrawn: decoded.headDrawn,
          },
        })
        return
      }
    }
    // 收到可信房主的业务消息（快照/请求/announcement/roster）→ 房主在线，取消掉线判定。
    hostRecovering = false
    clearHostGoneTimer()
    armAuthoritySilenceTimer()
    if (decoded.kind === 'round_start') {
      if (decoded.authorityEpoch) snapshotReconciler.setAuthorityEpoch(decoded.authorityEpoch)
      if (decoded.round < state.round.value) return
    }
    serverMessageRouter(raw)
  }

  function closeConnection() {
    transport.close()
    clearTimers()
    clearHostGoneTimer()
    clearSettlementRecoveryHand()
    clearAuthoritySilenceTimer()
    hostGoneBoundRoom = null
    pinnedHostPeerId = null
    hostRecovering = false
  }

  function resetAll() {
    resetWinEffectDedup()
    matchLifecycle.resetAll()
  }

  async function leaveRoom() {
    hostGame.value?.stop()
    hostGame.value = null
    closeConnection()
    resetAll()
    // 未终局的对局不计入战绩：丢弃本场累计（终局前正常退出/房主解散都走这里）。
    statsRecorder.reset()
    roomSession.leaveRoom()
    // 主动退出房间 → 清除保存的会话：否则刷新页面、重新登录后 watch(vibeUser)
    // 会触发 resumeSession 自动加入旧房间（「退出了房间，登录后怎么又进旧房」）。
    clearSavedSession()
  }

  /** 房主关闭房间（closeRoom 也走 leaveRoom 的清理路径）。 */
  async function closeRoom() {
    await roomSession.closeRoom()
    await leaveRoom()
  }

  // 暴露给 lobby 控制器的房间动作：主动退出/关闭房间时清除保存的会话（内部重进路径
  // 用原始 roomSession，保留会话以便自动重进）。
  // sessionVersion 让 savedSessionExists 响应式：清会话后 App.vue 的 watch(vibeUser)
  // 立即读到「已无会话」，不会在退出房间后重新登录时又自动加入旧房间。
  const sessionVersion = ref(0)
  const savedSessionExists = computed(() => {
    void sessionVersion.value
    return sessionStore.loadSession() != null
  })
  function clearSavedSession() {
    sessionStore.clearSession()
    sessionVersion.value += 1
  }
  const remoteActions = {
    ...roomSession,
    async leaveRoom() {
      await roomSession.leaveRoom()
      clearSavedSession()
    },
    async closeRoom() {
      await roomSession.closeRoom()
      clearSavedSession()
    },
  }

  function cleanup() {
    hostGame.value?.stop()
    closeConnection()
    clearTimers()
  }
  const instance = getCurrentInstance()
  if (instance) onBeforeUnmount(cleanup)

  return defineGamePort({
    // 远程会话
    sessionStatus, wsStatus, sessionError, roomId, mySeat, nickname, avatar, playerId,
    isHost, hostGame, roomSeats: lobbySeats, roomTimeLimit, waitingNextRound, rulesetId,
    savedSessionExists,
    scheduleRejoinRetry,
    resetRejoinRetry,
    rejoining,
    secondDice, flipTile, jokerTiles, wildcardTiles, flipStack, openingStack, wallBreakIndex,
    signalQuality, autoPlay, toggleAutoPlay,
    remoteActions,
    // 游戏状态（useGame 兼容接口）
    phase, players, wall, wallHeadDrawn, wallCount, currentPlayer, selectedIndex, turnSeconds, lastDiscard,
    actionPrompt, announcement, tableActionEvent, scoreFlowEvent, result, winEffect,
    winPresentation, revealHands, winningPlayerIndex,
    round, dealer, user, isUserTurn, userCanHu: remoteUserCanHu,
    matchType, matchName, matchFinished, honba, roundLabel, standings,
    dealAnimation, openingStage, diceValues, diceThrowerIndex, userCurrentWaits, userTingOptions, userDiscardWaits,
    userKongs: remoteUserKongs,
    capabilities: computed(() => ({
      chi: { choose: userChi },
      windKong: { available: remoteUserHasWindKong.value, execute: userWindKong },
      lotusTable: {
        flipTile: flipTile.value,
        jokerTiles: jokerTiles.value,
        wildcardTiles: wildcardTiles.value,
        wallBreakIndex: wallBreakIndex.value,
        flipStack: flipStack.value,
      },
    })), startGame: resetAll, selectTile, clearUserSelection, userDiscard, userPass, userPeng,
    userGangFromDiscard, userGang, userChi, userWindKong, userHu,
    nextRound, returnToLobby, tileName, debugPreviewWin: () => {},
  })
}
