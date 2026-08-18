import type {
  Announcement,
  DealAnimation,
  ActionPrompt,
  GamePhase,
  LastDiscard,
  OpeningStage,
  RefLike,
  RoundResult,
  WinEffect,
} from '../../core/contracts/gamePort'
import type { GamePlayer, TileType, WinPresentation } from '../../core/contracts/types'
import { WALL_TOTAL } from '../../core/rules/wallLayout'
import { tileName } from '../../core/rules/tiles'
import type { ServerPlayerDto, ServerSnapshot } from '../protocol/dto'
import type { RoundStartMessage } from '../protocol/messages'
import { createOpeningSnapshotGate } from './openingGate'

export interface OpeningTimelineState {
  phase: RefLike<GamePhase>
  players: GamePlayer[]
  wall: RefLike<TileType[]>
  wallCount: RefLike<number>
  wallHeadDrawn: RefLike<number>
  currentPlayer: RefLike<number>
  selectedIndex: RefLike<number>
  actionPrompt: RefLike<ActionPrompt | null>
  lastDiscard: RefLike<LastDiscard | null>
  result: RefLike<RoundResult | null>
  winEffect: RefLike<WinEffect | null>
  winPresentation: RefLike<WinPresentation | null>
  revealHands: RefLike<boolean>
  winningPlayerIndex: RefLike<number>
  round: RefLike<number>
  dealer: RefLike<number>
  honba: RefLike<number>
  diceValues: RefLike<number[]>
  secondDice: RefLike<[number, number]>
  flipTile: RefLike<TileType | null>
  jokerTiles: RefLike<TileType[]>
  wildcardTiles: RefLike<TileType[]>
  flipStack: RefLike<number | null>
  openingStack: RefLike<number | null>
  wallBreakIndex: RefLike<number>
  diceThrowerIndex: RefLike<number>
  openingStage: RefLike<OpeningStage | null>
  dealAnimation: RefLike<DealAnimation>
  announcement: RefLike<Announcement | null>
}

export interface OpeningTimelineOptions {
  state: OpeningTimelineState
  toLocalSeat: (seat: number) => number
  mapPlayers: (players: ServerPlayerDto[]) => GamePlayer[]
  /** 生产联机开局确认必须绑定当前房主生命周期；单测/本地表现层可省略。 */
  getAuthorityEpoch?: () => string | undefined
  playSound: (name: string, volume?: number) => unknown
  playSoundAndWait: (name: string, volume?: number) => Promise<void>
  send: (message: Record<string, unknown>) => void
  onFinished: () => void
  onOpeningDone?: (round: number) => void
  waitForTableReady?: () => Promise<void>
  waitForOpeningSnapshot?: boolean
  openingSnapshotTimeoutMs?: number
}

export function createOpeningTimeline({
  state,
  toLocalSeat,
  mapPlayers,
  getAuthorityEpoch,
  playSound,
  playSoundAndWait,
  send,
  onFinished,
  onOpeningDone,
  waitForOpeningSnapshot = false,
  openingSnapshotTimeoutMs = 15000,
}: OpeningTimelineOptions) {
  let sequence = 0
  let running = false
  let startMessage: RoundStartMessage | null = null
  let openingSnapshot: ServerSnapshot | null = null
  let primedSnapshot: ServerSnapshot | null = null
  let hasSecondDice = false
  let hasFlip = false
  let flipSeat = -1
  let dealStarted = false
  let firstDice: number[] = []
  let flipTileValue: TileType | null = null
  let flipStackValue: number | null = null
  const timers = new Set<number>()
  const openingSnapshotGate = createOpeningSnapshotGate(openingSnapshotTimeoutMs)

  function wait(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        timers.delete(timer as unknown as number)
        resolve()
      }, delay) as unknown as number
      timers.add(timer)
    })
  }

  function playOpeningSound(name: string) {
    // 音频是装饰层；资源加载或浏览器自动播放策略不能阻塞开局协议。
    // 例外：game_start 在 run() 中单独 await（对齐单机，等播完再掷骰）。
    void playSoundAndWait(name).catch(() => {})
  }

  function announce(text: string, tone: string = 'gold') {
    // 开局期间的「翻精」由客户端在翻精阶段播报（对齐单机，用中文牌名）；
    // 服务端在 round_start 阶段广播的公告会因 opening.isRunning 被丢弃。
    state.announcement.value = { text, tone, id: Date.now() }
    const id = state.announcement.value.id
    void wait(1500).then(() => {
      if (state.announcement.value?.id === id) state.announcement.value = null
    })
  }

  function cancel() {
    sequence += 1
    timers.forEach((timer) => globalThis.clearTimeout(timer))
    timers.clear()
    running = false
    startMessage = null
    openingSnapshot = null
    primedSnapshot = null
    hasSecondDice = false
    hasFlip = false
    flipSeat = -1
    dealStarted = false
    firstDice = []
    flipTileValue = null
    flipStackValue = null
    openingSnapshotGate.cancel()
    state.openingStage.value = null
  }

  function isRunning() {
    return running
  }

  function isWaitingForSnapshot() {
    return running && waitForOpeningSnapshot && openingSnapshot == null
  }

  function hasSnapshotForRound(round: number) {
    return openingSnapshot?.round === round || primedSnapshot?.round === round
  }

  /**
   * state_snapshot 可能先于 round_start 抵达。先把同轮 opening 快照暂存，
   * 等 round_start 到达后仍播放客户端动画；动画结束时再由 reconciler 用这份
   * 已验收的房主快照落地，避免为了顺序而牺牲客户端表现层。
   */
  function primeSnapshot(snapshot: ServerSnapshot) {
    if (snapshot.phase !== 'opening') return
    if (running) {
      captureSnapshot(snapshot)
      return
    }
    if (snapshot.round >= state.round.value) primedSnapshot = snapshot
  }

  function captureSnapshot(snapshot: ServerSnapshot) {
    if (!running) return
    // 发牌动画开始后，普通回合快照可能已经到达；它们应留在 reconciler
    // 的 pendingSnapshot 中，不能重建正在播放的手牌/牌墙，否则动画会回到首批牌。
    if (dealStarted) return
    if (waitForOpeningSnapshot && !openingSnapshotGate.capture(snapshot)) return
    // 只保留「开局后第一份」快照（opening 全量手牌）；无头房主推进极快，
    // 等待发牌动画期间会陆续到达 drawing/checking 等快照，若继续覆盖会把发牌手牌冲掉。
    if (openingSnapshot) return
    openingSnapshot = snapshot
    // 立即填充座位骨架（players 非空 → GameTableHud/3D 场景挂载），
    // 让骰子 presenter 在开局动画开始前就绪；手牌留空由发牌动画填充。
    const wallTotal = snapshot.rulesetId === 'lotus-legacy' ? WALL_TOTAL - 2 : WALL_TOTAL
    state.wallCount.value = wallTotal
    const snapshotWall = snapshot.wall ?? []
    const placeholders = Math.max(0, wallTotal - snapshotWall.length)
    state.wall.value = [...Array<TileType>(placeholders).fill('m1'), ...snapshotWall]
    state.wallHeadDrawn.value = 0
    state.secondDice.value = snapshot.secondDice ?? snapshot.dice ?? [1, 1]
    state.jokerTiles.value = snapshot.jokerTiles ?? []
    state.wildcardTiles.value = snapshot.wildcardTiles ?? []
    state.flipStack.value = snapshot.flipStack ?? null
    state.openingStack.value = snapshot.openingStack ?? null
    state.wallBreakIndex.value = snapshot.wallBreakIndex ?? 0
    const skeleton = mapPlayers(snapshot.players)
    state.players.splice(0, state.players.length, ...skeleton.map((player) => ({
      ...player, hand: [], concealedTileCount: 0, discards: [], melds: [], drawnTileIndex: -1,
    })))
  }

  async function deal(currentSequence: number): Promise<boolean> {
    const snapshot = openingSnapshot
    if (!snapshot) return true
    dealStarted = true
    state.openingStage.value = 'deal'
    state.phase.value = 'dealing'
    const source = mapPlayers(snapshot.players)
    const hands = source.map((player) => [...player.hand])
    const concealedRemaining = source.map((player) => player.concealedTileCount ?? player.hand.length)
    state.players.splice(0, state.players.length, ...source.map((player) => ({
      ...player, hand: [], concealedTileCount: 0, discards: [], melds: [], drawnTileIndex: -1,
    })))
    const localDealer = state.dealer.value
    const seatOrder = Array.from(
      { length: state.players.length },
      (_, index) => (localDealer + index) % state.players.length,
    )
    let serial = 0
    const dealBatch = async (playerIndex: number, count: number): Promise<boolean> => {
      if (currentSequence !== sequence) return false
      const dealCount = Math.min(count, concealedRemaining[playerIndex])
      concealedRemaining[playerIndex] -= dealCount
      const remaining = hands[playerIndex].length
      const slice = hands[playerIndex].splice(Math.max(0, remaining - dealCount), dealCount)
      state.players[playerIndex].hand.push(...slice)
      state.players[playerIndex].concealedTileCount = (state.players[playerIndex].concealedTileCount ?? 0) + dealCount
      state.wallCount.value = Math.max(0, state.wallCount.value - dealCount)
      state.wall.value.splice(0, dealCount)
      state.wallHeadDrawn.value += dealCount
      state.dealAnimation.value = { playerIndex, count: dealCount, serial: serial + 1 }
      serial += 1
      playSound('deal.mp3', 0.72)
      await wait(count === 4 ? 260 : 150)
      return true
    }
    for (let batch = 0; batch < 3; batch += 1) {
      for (const playerIndex of seatOrder) {
        if (!(await dealBatch(playerIndex, 4))) return false
      }
    }
    if (!(await dealBatch(localDealer, 2))) return false
    for (const playerIndex of seatOrder) {
      if (playerIndex !== localDealer && !(await dealBatch(playerIndex, 1))) return false
    }
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: serial + 1 }
    return true
  }

  async function run(currentSequence: number) {
    // 骰子动画（dicePresenter 1050ms）+ 渲染余量：3D 场景在首次开局时需完成
    // WebGL 初始化和首帧渲染，等待过短会让骰子看起来"还没播完就进入下一步"。
    // 莲花开局有两次掷骰与翻精，经典只有一次投骰。
    const diceWait = hasSecondDice || hasFlip ? 1900 : 1500
    running = true
    if (waitForOpeningSnapshot && !openingSnapshot) {
      // 牌桌 3D 资源是表现层依赖，不能成为开局协议的门槛。房主的 opening
      // 快照已经在 reconciler 中先挂好了四家座位骨架；这里必须先按权威开局
      // 时间线进入 start/dice/deal。若等待 WebGL/牌面资源，客户端会在慢网下
      // 一直停在 loading，随后被 playing 快照覆盖，最终只有房主看得到动画。
      const capturedSnapshot = await openingSnapshotGate.wait()
      if (capturedSnapshot && !openingSnapshot) openingSnapshot = capturedSnapshot
      if (!openingSnapshot) {
        if (currentSequence !== sequence) return
        state.openingStage.value = null
        running = false
        onFinished()
        return
      }
    }
    if (currentSequence !== sequence) return
    // round_start 只描述房主要求播放哪一轮动画；真正的轮次、庄家和局面
    // 要等同轮 state_snapshot 到达后才写入本地状态。否则旧 Room 的 round_start
    // 先到时，客户端会先把 state.round 改成未来轮次，随后把当前房主快照当成旧包丢弃。
    if (startMessage) {
      state.round.value = startMessage.round
      state.dealer.value = toLocalSeat(startMessage.dealer)
      state.honba.value = startMessage.honba
      state.secondDice.value = startMessage.secondDice ?? [1, 1]
      state.diceValues.value = [1, 1]
      state.flipTile.value = null
      state.jokerTiles.value = []
      state.wildcardTiles.value = []
      state.flipStack.value = startMessage.flipStack ?? null
      state.openingStack.value = null
      state.wallBreakIndex.value = 0
      state.players.forEach((player) => {
        player.hand.splice(0)
        player.discards.splice(0)
        player.melds.splice(0)
        player.drawnTileIndex = -1
      })
      state.currentPlayer.value = -1
      state.selectedIndex.value = -1
      state.actionPrompt.value = null
      state.lastDiscard.value = null
      state.result.value = null
      state.winEffect.value = null
      state.winPresentation.value = null
      state.revealHands.value = false
      state.winningPlayerIndex.value = -1
      state.phase.value = 'dealing'
    }
    state.openingStage.value = 'start'
    state.diceThrowerIndex.value = state.dealer.value
    // 等 game_start 播完再掷骰（与单机 lotusOpening/localOpening 对齐）。
    // playEffectAndWait 自带 4s 兜底超时、静音/异常时立即返回，不会阻塞开局协议。
    await Promise.all([playSoundAndWait('game_start.mp3').catch(() => {}), wait(1250)])
    if (currentSequence !== sequence) return
    state.openingStage.value = 'dice'
    state.diceValues.value = [...firstDice]
    playOpeningSound('dice.mp3')
    await wait(diceWait)
    if (currentSequence !== sequence) return
    if (hasFlip) {
      state.openingStage.value = 'flip'
      state.flipTile.value = flipTileValue
      state.flipStack.value = flipStackValue
      if (flipTileValue) announce(`翻精 ${tileName(flipTileValue)}`)
      await wait(1200)
      if (currentSequence !== sequence) return
    }
    if (hasSecondDice) {
      if (flipSeat >= 0) state.diceThrowerIndex.value = toLocalSeat(flipSeat)
      // 第二次掷骰要切回骰子阶段，dicePresenter 才会显示并起势（对齐单机 lotusOpening）。
      state.openingStage.value = 'dice'
      state.diceValues.value = [...state.secondDice.value]
      playOpeningSound('dice.mp3')
      await wait(diceWait)
      if (currentSequence !== sequence) return
    }
    if (openingSnapshot && !(await deal(currentSequence))) return
    // 开牌后留出 650ms 停顿再放行首回合（对齐单机 lotusOpening/localOpening 节奏）。
    await wait(650)
    if (currentSequence !== sequence) return
    state.openingStage.value = null
    running = false
    sendOpeningDone()
    onFinished()
  }

  function sendOpeningDone(round = startMessage?.round ?? state.round.value) {
    onOpeningDone?.(round)
    const authorityEpoch = getAuthorityEpoch?.()
    send(waitForOpeningSnapshot
      ? { type: 'opening_done', round, ...(authorityEpoch ? { authorityEpoch } : {}) }
      : { type: 'opening_done', ...(authorityEpoch ? { authorityEpoch } : {}) })
  }

  /**
   * state_snapshot 先于 round_start 到达时，表现层已经不需要再重播开局动画，
   * 但房主的 opening barrier 仍然必须收到当前连接的完成确认。这个确认只发送
   * 协议 ack，不修改任何本地牌局状态；牌局状态仍以刚刚验收的房主快照为准。
   */
  function confirm(message: RoundStartMessage) {
    sendOpeningDone(message.round)
  }

  function start(message: RoundStartMessage, options: { instant?: boolean } = {}) {
    const preparedSnapshot = primedSnapshot?.round === message.round ? primedSnapshot : null
    cancel()
    startMessage = message
    if (preparedSnapshot) openingSnapshot = preparedSnapshot
    if (waitForOpeningSnapshot && !options.instant && !preparedSnapshot) openingSnapshotGate.begin(message.round)
    firstDice = [...message.dice]
    flipTileValue = message.flipTile ?? null
    flipStackValue = message.flipStack ?? null
    hasSecondDice = message.secondDice != null
    hasFlip = message.flipTile != null && message.flipStack != null
    flipSeat = message.flipSeat ?? -1
    if (options.instant) {
      // 重进快照会在同一轮的 state_snapshot 中落地；instant 路径不播放动画，
      // 但仍立即应用 round_start 的表现参数以保持旧兼容行为。
      state.round.value = message.round
      state.dealer.value = toLocalSeat(message.dealer)
      state.honba.value = message.honba
      state.secondDice.value = message.secondDice ?? [1, 1]
      state.flipStack.value = flipStackValue
      state.phase.value = 'dealing'
      // 重进（对局中再加入）：跳过骰子/翻精/发牌动画，直接放行快照驱动——重进玩家
      // 手牌由快照提供，不需要发牌动画。若照常播 8s 动画，期间到达的 turn_request
      // 会被 isBlocked 缓存，客户端响应晚于房主掉线超时 → 在线玩家被误判「掉线
      // AI 代打」（提示一闪而过，AI 夺舍）。
      state.openingStage.value = null
      running = false
      sendOpeningDone()
      onFinished()
      return
    }
    const currentSequence = sequence
    void run(currentSequence)
  }

  return {
    start,
    cancel,
    isRunning,
    isWaitingForSnapshot,
    hasSnapshotForRound,
    primeSnapshot,
    captureSnapshot,
    confirm,
  }
}
