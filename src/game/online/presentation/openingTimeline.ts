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
  onOpeningDone?: (round: number, honba: number) => void
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
  waitForTableReady,
  waitForOpeningSnapshot = false,
  openingSnapshotTimeoutMs = 15000,
}: OpeningTimelineOptions) {
  let sequence = 0
  let running = false
  let gateActive = false
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
    if (running || gateActive || openingSnapshot || primedSnapshot) {
      console.log(`[client] opening cancel: running=${running} gateActive=${gateActive} snapshot=${openingSnapshot ? `${openingSnapshot.round}:${openingSnapshot.honba}` : '(空)'} primed=${primedSnapshot ? `${primedSnapshot.round}:${primedSnapshot.honba}` : '(空)'}`)
    }
    sequence += 1
    timers.forEach((timer) => globalThis.clearTimeout(timer))
    timers.clear()
    running = false
    gateActive = false
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

  /**
   * 当前开局动画的目标手（round_start 的轮次）。reconciler 判断「未来轮次
   * 快照」时必须与动画目标手比较，而不是与滞后的 state.round 比较——动画
   * gate 等待期间 state.round 仍是上一手，同手 opening 快照会被误判成未来轮
   * 并取消刚启动的开局动画（自动确认路径东2局无动画）。
   */
  function getTargetHand(): { round: number; honba: number } | null {
    return startMessage ? { round: startMessage.round, honba: startMessage.honba } : null
  }

  function isWaitingForSnapshot() {
    // gate 已 begin（round_start 已到、正在等 opening 快照）即视为等待中：
    // run() 是异步启动，running 标志可能尚未置位，但 gate 已 active——
    // 此时到达的同局 opening 快照必须能 capture 喂给 gate，否则 15 秒
    // 超时后静默跳过整个开局动画。
    return (running || gateActive) && waitForOpeningSnapshot && openingSnapshot == null
  }

  function hasSnapshotForHand(round: number, honba: number) {
    return (openingSnapshot?.round === round && openingSnapshot.honba === honba)
      || (primedSnapshot?.round === round && primedSnapshot.honba === honba)
  }

  /**
   * state_snapshot 可能先于 round_start 抵达。先把同轮 opening 快照暂存，
   * 等 round_start 到达后仍播放客户端动画；动画结束时再由 reconciler 用这份
   * 已验收的房主快照落地，避免为了顺序而牺牲客户端表现层。
   */
  function primeSnapshot(snapshot: ServerSnapshot) {
    if (snapshot.phase !== 'opening') return
    // 动画已运行时不再提前 capture：reconciler 的 capture 分支（未来轮/结算屏障/
    // 动画运行中）会在同一次 apply 里把快照喂给 gate。若在这里先 capture，
    // openingSnapshot 被提前置位 → isWaitingForSnapshot() 变为 false →
    // reconciler 的「未来轮快照」分支会误判成「动画未在等快照」而取消动画并
    // applyNow 直接落地（自动确认路径的东2局无开局动画）。只在动画未启动时
    // 暂存，等 round_start 到达后由 opening.start 使用。
    if (snapshot.round >= state.round.value) primedSnapshot = snapshot
  }

  function captureSnapshot(snapshot: ServerSnapshot) {
    // run() 是异步启动，快照可能在 running 置位前到达；gate 已 active 时
    // 仍必须接受同局 opening 快照，否则 15 秒超时静默跳过整个开局动画。
    if (!running && !gateActive) return
    // 发牌动画开始后，普通回合快照可能已经到达；它们应留在 reconciler
    // 的 pendingSnapshot 中，不能重建正在播放的手牌/牌墙，否则动画会回到首批牌。
    if (dealStarted) return
    if (waitForOpeningSnapshot && !openingSnapshotGate.capture(snapshot)) {
      console.log(`[client] opening gate 拒绝快照: round=${snapshot.round} honba=${snapshot.honba} phase=${snapshot.phase}`)
      return
    }
    gateActive = false
    // 只保留「开局后第一份」快照（opening 全量手牌）；无头房主推进极快，
    // 等待发牌动画期间会陆续到达 drawing/checking 等快照，若继续覆盖会把发牌手牌冲掉。
    if (openingSnapshot) return
    openingSnapshot = snapshot
    console.log(`[client] opening capture 成功: round=${snapshot.round} honba=${snapshot.honba} phase=${snapshot.phase} running=${running} gateActive=${gateActive}`)
    // 立即填充座位骨架（players 非空 → GameTableHud/3D 场景挂载），
    // 让骰子 presenter 在开局动画开始前就绪；手牌留空由发牌动画填充。
    const wallTotal = snapshot.rulesetId === 'lotus-legacy' ? WALL_TOTAL - 2 : WALL_TOTAL
    // 开局最初是完整立墙：莲花麻将可摸牌数组虽已排除翻精墩，但 3D 会用
    // flipStack 补回该墩的上下两张占位牌。LCD 也应先显示 136，等 flip 阶段
    // 真正翻出指示牌时才变为 134，不能一进牌桌就提前少两张。
    state.wallCount.value = WALL_TOTAL
    const snapshotWall = snapshot.wall ?? []
    const placeholders = Math.max(0, wallTotal - snapshotWall.length)
    state.wall.value = [...Array<TileType>(placeholders).fill('m1'), ...snapshotWall]
    state.wallHeadDrawn.value = 0
    state.secondDice.value = snapshot.secondDice ?? snapshot.dice ?? [1, 1]
    if (!hasSecondDice && snapshot.secondDice) hasSecondDice = true
    if (!hasFlip && snapshot.flipTile != null && snapshot.flipStack != null) {
      hasFlip = true
      flipTileValue = snapshot.flipTile
      flipStackValue = snapshot.flipStack
    }
    state.jokerTiles.value = snapshot.jokerTiles ?? []
    state.wildcardTiles.value = snapshot.wildcardTiles ?? []
    state.flipStack.value = snapshot.flipStack ?? null
    // 开门断点必须等二骰结束、进入 deal 时才应用；提前写入会让完整牌山
    // 在一骰/翻精过程中就瞬移到未来的摸牌起点。
    state.openingStack.value = null
    state.wallBreakIndex.value = 0
    const skeleton = mapPlayers(snapshot.players)
    state.players.splice(0, state.players.length, ...skeleton.map((player) => ({
      ...player, hand: [], concealedTileCount: 0, discards: [], melds: [], drawnTileIndex: -1,
    })))
  }

  async function deal(currentSequence: number): Promise<boolean> {
    const snapshot = openingSnapshot
    if (!snapshot) return true
    dealStarted = true
    // 与单机莲花时间线一致：二骰决定开门位置，发牌从该断点开始。
    state.openingStack.value = snapshot.openingStack ?? null
    state.wallBreakIndex.value = snapshot.wallBreakIndex ?? 0
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
      // 先取得权威开局快照并挂载四家座位骨架，GameTableHud 才会创建 3D 场景。
      const capturedSnapshot = await openingSnapshotGate.wait()
      if (capturedSnapshot && !openingSnapshot) openingSnapshot = capturedSnapshot
      console.log(`[client] opening gate wait 结束: snapshot=${openingSnapshot ? `${openingSnapshot.round}:${openingSnapshot.honba}` : '(超时)'} seq=${currentSequence} vs ${sequence}`)
      if (!openingSnapshot) {
        if (currentSequence !== sequence) return
        state.openingStage.value = null
        running = false
        onFinished()
        return
      }
    }
    if (currentSequence !== sequence) return
    // 正式开场必须晚于牌面下载/解码、图集构建、着色器编译和合成首帧。
    // 加载失败时该 Promise 保持等待，界面显示可重试错误；绝不能先进入
    // start/dice/deal 或发送 opening_done，让房主误以为客户端已完成开场。
    if (waitForTableReady) await waitForTableReady()
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
      state.wallCount.value = openingSnapshot?.rulesetId === 'lotus-legacy'
        ? WALL_TOTAL - 2
        : WALL_TOTAL
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

  function sendOpeningDone(
    round = startMessage?.round ?? state.round.value,
    honba = startMessage?.honba ?? state.honba.value,
  ) {
    onOpeningDone?.(round, honba)
    const authorityEpoch = getAuthorityEpoch?.()
    send(waitForOpeningSnapshot
      ? { type: 'opening_done', round, honba, ...(authorityEpoch ? { authorityEpoch } : {}) }
      : { type: 'opening_done', ...(authorityEpoch ? { authorityEpoch } : {}) })
  }

  /**
   * state_snapshot 先于 round_start 到达时，表现层已经不需要再重播开局动画，
   * 但房主的 opening barrier 仍然必须收到当前连接的完成确认。这个确认只发送
   * 协议 ack，不修改任何本地牌局状态；牌局状态仍以刚刚验收的房主快照为准。
   */
  function confirm(message: RoundStartMessage) {
    sendOpeningDone(message.round, message.honba)
  }

  function start(message: RoundStartMessage, options: { instant?: boolean } = {}) {
    const preparedSnapshot = primedSnapshot?.round === message.round
      && primedSnapshot.honba === message.honba
      ? primedSnapshot
      : null
    console.log(`[client] opening.start round=${message.round} honba=${message.honba} prepared=${Boolean(preparedSnapshot)} primed=${primedSnapshot ? `${primedSnapshot.round}:${primedSnapshot.honba}` : '(空)'} instant=${Boolean(options.instant)} waitForSnapshot=${waitForOpeningSnapshot}`)
    cancel()
    startMessage = message
    if (preparedSnapshot) openingSnapshot = preparedSnapshot
    if (waitForOpeningSnapshot && !options.instant && !preparedSnapshot) {
      openingSnapshotGate.begin(message.round, message.honba)
      gateActive = true
    }
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
    getTargetHand,
    hasSnapshotForHand,
    primeSnapshot,
    captureSnapshot,
    confirm,
  }
}
