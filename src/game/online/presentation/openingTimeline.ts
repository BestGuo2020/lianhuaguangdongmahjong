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
  let openingSnapshot: ServerSnapshot | null = null
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
    openingSnapshot = null
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
    if (waitForOpeningSnapshot) {
      const tableReady = waitForTableReady ? waitForTableReady() : Promise.resolve()
      const [, capturedSnapshot] = await Promise.all([tableReady, openingSnapshotGate.wait()])
      if (capturedSnapshot && !openingSnapshot) openingSnapshot = capturedSnapshot
      if (!openingSnapshot) {
        if (currentSequence !== sequence) return
        state.openingStage.value = null
        running = false
        sendOpeningDone()
        onFinished()
        return
      }
    } else if (waitForTableReady) {
      await waitForTableReady()
    }
    if (currentSequence !== sequence) return
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

  function sendOpeningDone() {
    onOpeningDone?.(state.round.value)
    send(waitForOpeningSnapshot
      ? { type: 'opening_done', round: state.round.value }
      : { type: 'opening_done' })
  }

  function start(message: RoundStartMessage, options: { instant?: boolean } = {}) {
    cancel()
    if (waitForOpeningSnapshot && !options.instant) openingSnapshotGate.begin(message.round)
    state.round.value = message.round
    state.dealer.value = toLocalSeat(message.dealer)
    state.honba.value = message.honba
    firstDice = [...message.dice]
    flipTileValue = message.flipTile ?? null
    flipStackValue = message.flipStack ?? null
    hasSecondDice = message.secondDice != null
    hasFlip = message.flipTile != null && message.flipStack != null
    flipSeat = message.flipSeat ?? -1
    state.secondDice.value = message.secondDice ?? [1, 1]
    // 骰子值 / 指示牌在对应阶段才展示；翻精墩（flipStack）从开局就保留（补足 136 张牌山），
    // 指示牌仅在翻精阶段翻出（面朝上），故此处只复位 diceValues 与 flipTile。
    state.diceValues.value = [1, 1]
    state.flipTile.value = null
    state.jokerTiles.value = []
    state.wildcardTiles.value = []
    state.flipStack.value = flipStackValue
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
    if (options.instant) {
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

  return { start, cancel, isRunning, captureSnapshot }
}
