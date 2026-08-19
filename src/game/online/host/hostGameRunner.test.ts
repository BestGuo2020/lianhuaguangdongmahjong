import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../../core/local/useGame'
import { AiController, type PlayerController } from '../../core/controllers/playerController'
import type { ServerSnapshot } from '../protocol/dto'
import type { ServerMessage } from '../protocol/messages'
import { startHostGame } from './hostGameRunner'
import { createMockVibeRoom } from './mockVibeRoom'
import { createMockVibeClient } from '../vibe/mockVibeHub'
import { RemotePlayerController } from './remotePlayerController'
import { useLotusGame } from '../../variants/lotus/lotusGame'
import { LotusRemotePlayerController } from './lotusRemotePlayerController'
import { windKong } from '../../variants/lotus/lotusRules'
import type { LotusController } from '../../variants/lotus/lotusControllers'
import type { TileType } from '../../core/contracts/types'
import { createWall } from '../../core/rules/tiles'

const realSetTimeout = globalThis.setTimeout

function stubWindow() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
}

async function waitForMockMessage(
  messages: Array<{ kind?: string }>,
  kind: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && !messages.some((message) => message.kind === kind); attempt += 1) {
    await vi.advanceTimersByTimeAsync(50)
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 驱动房主（seat 0）行动：出牌或对碰/杠/胡/抢杠询问一律「过」。
 * 莲花引擎的 phase='prompt' 只由房主 humanBridge 设置（远端/ AI 座位的询问
 * 不进引擎相位），无人应答会永久卡死；是否触发看洗牌运气，必须自动过掉。 */
function driveHostSeat(runner: {
  game: {
    phase: { value: string }
    currentPlayer: { value: number }
    players: Array<{ hand: unknown[] }>
    userPass(): void
    userDiscard(index: number): void
  }
}) {
  if (runner.game.phase.value === 'prompt') {
    runner.game.userPass()
    return
  }
  if (runner.game.phase.value === 'discard' && runner.game.currentPlayer.value === 0) {
    runner.game.userDiscard((runner.game.players[0]?.hand.length ?? 1) - 1)
  }
}

describe('startHostGame 无头权威', () => {
  it('SDK 洗牌承诺未完成时不广播空玩家快照', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const hostRoom = await hostClient.room.join('OPENING_PENDING1')
    const guestRoom = await guestClient.room.join('OPENING_PENDING1')
    stubWindow()

    let resolveOpening!: (opening: { initialWall: TileType[]; openingDice: [number, number] }) => void
    const opening = new Promise<{ initialWall: TileType[]; openingDice: [number, number] }>((resolve) => {
      resolveOpening = resolve
    })
    const messages: Array<{ kind?: string; players?: unknown[] }> = []
    guestRoom.onMessage((message) => messages.push(message as never))

    const runner = startHostGame<PlayerController>({
      room: hostRoom,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map([[guestRoom.peerId, 1]]),
      createController: (r, peerId, onPending, onAI) => new RemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      opening,
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })

    // opening 仍 pending 时，重连/hello 的补发路径也不能泄露 players=[] 快照。
    guestRoom.send({ type: 'lobby_hello', nickname: '客人', avatar: '' })
    await vi.advanceTimersByTimeAsync(100)
    expect(messages.filter((message) => message.kind === 'state_snapshot')).toHaveLength(0)

    resolveOpening({ initialWall: createWall(), openingDice: [1, 1] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(messages.some((message) => message.kind === 'state_snapshot' && message.players?.length === 4)).toBe(true)
    runner.stop()
  })

  it('开局广播 round_start，并把 seat0 快照喂给 onLocalSnapshot', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const snapshots: ServerSnapshot[] = []
    const events: ServerMessage[] = []
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map(),
      createController: () => ({}) as PlayerController,
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: (snapshot) => snapshots.push(snapshot),
      onLocalEvent: (message) => events.push(message),
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(events.some((event) => event.kind === 'round_start')).toBe(true)
    expect(snapshots.some((snapshot) => snapshot.seat === 0 && snapshot.players.length === 4)).toBe(true)
    // 无头引擎：开局后即时进入回合（不等 PACE_MS/发牌动画）。
    expect(runner.game.phase.value).not.toBe('lobby')
    runner.stop()
  })

  it('玩家摸牌瞬间广播「已摸牌（14 张 + drawnTileIndex）」快照，其余玩家可见摸上来的牌', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const snapshots: ServerSnapshot[] = []
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map(),
      createController: () => ({}) as PlayerController,
      // 全 AI 控制器：headless 下 seat 0 默认为 HumanController（无人操作会卡住庄家回合），
      // 测试需要对局自动推进到有人摸牌。
      createGame: () => useGame({
        controllers: [
          new AiController(), new AiController(), new AiController(), new AiController(),
        ],
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: (snapshot) => snapshots.push(snapshot),
      onLocalEvent: () => {},
    })

    // 推进对局直到出现「摸牌中」快照：某家手牌 14 张且 drawnTileIndex >= 0。
    // 回归：drawFor 把牌推入手牌后、phase 切到 thinking（广播被守卫拦截）之前，
    // 房主必须补发一次快照，否则其余玩家永远看不到摸上来的第 14 张。
    let drawn: ServerSnapshot | undefined
    for (let i = 0; i < 400; i += 1) {
      await vi.advanceTimersByTimeAsync(50)
      drawn = snapshots.find((snapshot) => snapshot.players.some(
        (player) => player.hand.length >= 14 && player.drawnTileIndex >= 0,
      ))
      if (drawn) break
    }
    expect(drawn).toBeTruthy()
    runner.stop()
  })

  it('莲花麻将：远端 turn_request 的 canWindKong 按手牌实算，且只定向发给远端', async () => {
    // 两个 BroadcastChannel mock 客户端 = 同浏览器两个窗口（房主 + 一个远端玩家）。
    // 注意：join 内部有 setTimeout 等待，须在开 fake timers 之前完成。
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const hostRoom = await hostClient.room.join('LOTUS1')
    const guestRoom = await guestClient.room.join('LOTUS1')
    stubWindow()
    const guestMessages: Array<{ kind?: string; ctx?: { canWindKong?: boolean; hand?: TileType[]; jokers?: TileType[] } }> = []
    const hostRaw: unknown[] = []
    guestRoom.onMessage((message) => guestMessages.push(message as never))
    // 若闲家先被问碰/杠/吃：自动过，确保能推进到闲家自己的回合（否则不响应会被
    // 15s 掉线超时 AI 接管，turn_request 不再走 wire，测试抓不到）。
    guestRoom.onMessage((message) => {
      if ((message as { kind?: string })?.kind === 'claim_request') guestRoom.send({ type: 'pass' })
    })
    hostRoom.onMessage((message) => hostRaw.push(message))

    const runner = startHostGame<LotusController>({
      room: hostRoom,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([[guestRoom.peerId, 1]]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })

    let turnRequest: typeof guestMessages[number] | undefined
    for (let i = 0; i < 300 && !turnRequest; i += 1) {
      await vi.advanceTimersByTimeAsync(250)
      // 庄家（房主 seat 0）回合无人操作会卡住；测试代为出牌推进到闲家回合。
      driveHostSeat(runner)
      turnRequest = guestMessages.find((message) => message?.kind === 'turn_request')
    }
    expect(turnRequest).toBeTruthy()
    // 回归：风杠可用性按手牌实算（东南西北各 1），不能恒 true（否则每个回合都显示风杠按钮）。
    expect(turnRequest!.ctx!.canWindKong).toBe(
      windKong(turnRequest!.ctx!.hand as TileType[], turnRequest!.ctx!.jokers as TileType[]),
    )
    // turn_request 是定向发给远端的消息，房主 viewer 不应收到（否则房主的风杠状态会被污染）。
    expect(hostRaw.some((message) => (message as { kind?: string })?.kind === 'turn_request')).toBe(false)
    runner.stop()
  }, 20000)

  it('莲花麻将：round_start 的一骰取 firstDice（与单人模式一致，不是二骰）', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const hostRoom = await hostClient.room.join('LOTUS2')
    const guestRoom = await guestClient.room.join('LOTUS2')
    stubWindow()
    const events: ServerMessage[] = []
    const runner = startHostGame<LotusController>({
      room: hostRoom,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([[guestRoom.peerId, 1]]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: (message) => events.push(message),
    })

    let roundStart: Extract<ServerMessage, { kind: 'round_start' }> | undefined
    for (let i = 0; i < 200 && !roundStart; i += 1) {
      await vi.advanceTimersByTimeAsync(50)
      roundStart = events.find((event): event is Extract<ServerMessage, { kind: 'round_start' }> => (
        event.kind === 'round_start'
      ))
    }
    expect(roundStart).toBeTruthy()
    // 回归：diceValues 在第二次掷骰时被覆盖成二骰，一骰必须来自引擎保留的 firstDice。
    expect(runner.game.firstDice?.value).not.toBeNull()
    expect(roundStart!.dice).toEqual(runner.game.firstDice?.value)
    // 回归：二骰投掷方位 = 翻精目标方 flipSeat（对齐单人模式），必须随 round_start 下发，
    // 否则客户端两骰都显示庄家投。
    expect(runner.game.flipSeat?.value).not.toBeNull()
    expect(roundStart!.flipSeat).toBe(runner.game.flipSeat?.value)
    runner.stop()
  })

  it('客户端不响应 → 房主超时 AI 接管，游戏继续（P1）', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const hostRoom = await hostClient.room.join('TIMEOUT1')
    const guestRoom = await guestClient.room.join('TIMEOUT1')
    stubWindow()
    const guestMessages: Array<{ kind?: string }> = []
    guestRoom.onMessage((message) => guestMessages.push(message as never))
    // 闲家先被问碰/杠/吃时自动过，确保能轮到自己的回合（否则不响应被超时 AI 接管）。
    guestRoom.onMessage((message) => {
      if ((message as { kind?: string })?.kind === 'claim_request') guestRoom.send({ type: 'pass' })
    })
    const runner = startHostGame<LotusController>({
      room: hostRoom,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([[guestRoom.peerId, 1]]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })

    // 推进到闲家回合（turn_request 已发给客人），然后客人不再响应。
    let sawTurnRequest = false
    for (let i = 0; i < 300 && !sawTurnRequest; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      driveHostSeat(runner)
      sawTurnRequest = guestMessages.some((message) => message?.kind === 'turn_request')
    }
    expect(sawTurnRequest).toBe(true)

    // 客人不响应 → 超过房主 25s 超时 → AI 接管座位（轮询等待，见刷新重进测试注释）。
    let aiTook = false
    for (let i = 0; i < 600 && !aiTook; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      aiTook = runner.aiControlledSeats.has(1)
    }
    expect(aiTook).toBe(true)
    // AI 接管后游戏继续推进，不再卡死。
    await vi.advanceTimersByTimeAsync(2000)
    expect(runner.game.phase.value).not.toBe('lobby')
    runner.stop()
  }, 20000)

  it('客户端掉线 → AI 接管；同 peerId 重连 → 恢复真人并补发 rejoin_ok（P1）', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestA = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000, peerId: 'guest-x' })
    const hostRoom = await hostClient.room.join('REJOIN1')
    const guestRoomA = await guestA.room.join('REJOIN1')
    stubWindow()
    const runner = startHostGame<LotusController>({
      room: hostRoom,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([[guestRoomA.peerId, 1]]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    // 掉线：直接关闭标签页（leave）→ 先进入恢复宽限，避免刷新时误报 AI。
    guestRoomA.leave()
    await vi.advanceTimersByTimeAsync(200)
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(12000)
    expect(runner.aiControlledSeats.has(1)).toBe(true)

    // 重连：同一 peerId 的新窗口重新加入 → 房主恢复真人并补发座位身份。
    const guestB = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000, peerId: 'guest-x' })
    // fake timers 下 join 内部有 setTimeout 等待：先发起，再推进时钟完成 settle。
    const guestBJoin = guestB.room.join('REJOIN1')
    await vi.advanceTimersByTimeAsync(200)
    const guestRoomB = await guestBJoin
    const rejoinMessages: Array<{ kind?: string; seat?: number }> = []
    guestRoomB.onMessage((message) => rejoinMessages.push(message as never))
    // 客户端 join 完成、处理链挂好后发 hello，房主据此补发 rejoin_ok（避免 join
    // settle 期间直发的 rejoin_ok 因处理器未挂载被漏掉）。
    guestRoomB.send({ type: 'lobby_hello', nickname: '重连客', avatar: '' })
    await waitForMockMessage(rejoinMessages, 'rejoin_ok')
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    const rejoinOk = rejoinMessages.find((message) => message?.kind === 'rejoin_ok')
    expect(rejoinOk?.seat).toBe(1)
    runner.stop()
  })

  it('刷新后 peerId 变化时按昵称兜底恢复座位（P1 兜底）', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestA = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000, peerId: 'guest-x' })
    const hostRoom = await hostClient.room.join('FALLBACK1')
    const guestRoomA = await guestA.room.join('FALLBACK1')
    stubWindow()
    const runner = startHostGame<LotusController>({
      room: hostRoom,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([[guestRoomA.peerId, 1]]),
      seatNames: new Map([[1, '重连客A']]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    guestRoomA.leave()
    await vi.advanceTimersByTimeAsync(200)
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(12000)
    expect(runner.aiControlledSeats.has(1)).toBe(true)

    // 旧调用未提供大厅座位表，保留昵称兜底以兼容历史单测。
    const guestB = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000, peerId: 'guest-y' })
    const guestBJoin = guestB.room.join('FALLBACK1')
    await vi.advanceTimersByTimeAsync(200)
    const guestRoomB = await guestBJoin
    const rejoinMessages: Array<{ kind?: string; seat?: number }> = []
    guestRoomB.onMessage((message) => rejoinMessages.push(message as never))
    guestRoomB.send({ type: 'lobby_hello', nickname: '重连客A', avatar: '' })
    await waitForMockMessage(rejoinMessages, 'rejoin_ok')
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    const rejoinOk = rejoinMessages.find((message) => message?.kind === 'rejoin_ok')
    expect(rejoinOk?.seat).toBe(1)
    runner.stop()
  })

  it('刷新重进：新 peerId 按大厅座位表恢复，新窗口收到快照并正常响应（不被 AI 反复接管）', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestA = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000, peerId: 'guest-x' })
    const hostRoom = await hostClient.room.join('REFRESH1')
    const guestRoomA = await guestA.room.join('REFRESH1')
    stubWindow()
    // 模拟 hostLobby 的实时座位表：旧 peerId 先占座位 1，刷新后换成新 peerId（昵称也换了，
    // 昵称兜底必然失配，必须靠大厅座位表恢复——复刻生产「3 次提示回来 3 次 AI 接管」）。
    const roster = new Map<string, number>([[guestRoomA.peerId, 1]])
    const guestMessagesA: Array<{ kind?: string }> = []
    guestRoomA.onMessage((message) => guestMessagesA.push(message as never))
    guestRoomA.onMessage((message) => {
      if ((message as { kind?: string })?.kind === 'claim_request') guestRoomA.send({ type: 'pass' })
    })
    const runner = startHostGame<LotusController>({
      room: hostRoom,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([[guestRoomA.peerId, 1]]),
      seatNames: new Map([[1, '刷新客']]),
      getSeatByPeer: () => roster,
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })

    // 推进到闲家回合，不响应 → 25s 超时 AI 接管（轮询等待：引擎推进节奏受莲花随机
    // 洗牌影响，固定时长在并行负载下偶发不足）。
    let sawTurnRequest = false
    for (let i = 0; i < 600 && !sawTurnRequest; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      driveHostSeat(runner)
      sawTurnRequest = guestMessagesA.some((message) => message?.kind === 'turn_request')
    }
    expect(sawTurnRequest).toBe(true)
    let aiTook = false
    for (let i = 0; i < 600 && !aiTook; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      aiTook = runner.aiControlledSeats.has(1)
    }
    expect(aiTook).toBe(true)

    // 刷新：旧窗口关闭；新窗口 peerId 变化（新标签页），昵称与座位表记录不同。
    guestRoomA.leave()
    await vi.advanceTimersByTimeAsync(200)
    const guestB = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000, peerId: 'guest-y' })
    const guestBJoin = guestB.room.join('REFRESH1')
    await vi.advanceTimersByTimeAsync(200)
    const guestRoomB = await guestBJoin
    roster.delete(guestRoomA.peerId)
    roster.set(guestRoomB.peerId, 1)
    const rejoinMessages: Array<{ kind?: string; seat?: number }> = []
    guestRoomB.onMessage((message) => rejoinMessages.push(message as never))
    guestRoomB.onMessage((message) => {
      if ((message as { kind?: string })?.kind === 'claim_request') guestRoomB.send({ type: 'pass' })
    })
    guestRoomB.send({ type: 'lobby_hello', nickname: '全新昵称', avatar: '' })
    await waitForMockMessage(rejoinMessages, 'rejoin_ok')

    // 座位恢复 + rejoin_ok + 对局快照（此前按静态 seatByPeer 广播，新 peerId 永远收不到）。
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    const rejoinOk = rejoinMessages.find((message) => message?.kind === 'rejoin_ok')
    expect(rejoinOk?.seat).toBe(1)
    const snapshot = rejoinMessages.find((message) => message?.kind === 'state_snapshot')
    expect(snapshot).toBeTruthy()
    // continue 屏障按实时座位表判定：新 peerId 在表中、旧 peerId 消失，否则重连客户端
    // 发来的 continue 对不上旧 peerId，全员卡在「已确认，等待其他玩家」。
    expect(runner.getLivePeerSeats().get(guestRoomB.peerId)).toBe(1)
    expect(runner.getLivePeerSeats().has(guestRoomA.peerId)).toBe(false)

    // 新窗口收到回合请求并能正常响应 → 引擎接受弃牌，座位不再被 AI 反复接管。
    let responded = false
    for (let i = 0; i < 400 && !responded; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      driveHostSeat(runner)
      if (rejoinMessages.some((message) => message?.kind === 'turn_request')) {
        guestRoomB.send({ type: 'discard', handIndex: 0 })
        responded = true
      }
    }
    expect(responded).toBe(true)
    // 后续牌局可能再次轮到座位 1，不能用某个随机时刻的 currentPlayer 判断恢复。
    // 推过完整掉线窗口后仍是真人、且实时映射仍指向新 peer，才是稳定业务证据。
    await vi.advanceTimersByTimeAsync(26000)
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    expect(runner.getLivePeerSeats().get(guestRoomB.peerId)).toBe(1)
    runner.stop()
  }, 20000)

  it('SDK 报 reconnecting 后等待恢复窗口；超时才 AI 接管，新 peerId 可恢复', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const runner = startHostGame<LotusController>({
      room,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([['old-peer', 1]]),
      seatNames: new Map([[1, '玩家1']]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    // reconnecting 可能只是 P2P → Relay 切换，恢复窗口内不应立即 AI 接管。
    room.emitPeer({ type: 'reconnecting', id: 'old-peer' })
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    // 恢复窗口内不切 AI，但续局屏障暂不等待不可用的旧连接。
    expect(runner.getLivePeerSeats().has('old-peer')).toBe(false)
    // 洗牌重试仍须保留恢复中的控制器映射；旧的超时结果不能在宽限期内夺取座位。
    expect(runner.getPeerSeats().get('old-peer')).toBe(1)
    expect(runner.enableAIForSeat(1, { requireRecoveryExpired: true })).toBe(false)
    expect(runner.getDisconnectedSeats()).toEqual(new Set([1]))
    await vi.advanceTimersByTimeAsync(12000)
    expect(runner.aiControlledSeats.has(1)).toBe(true)
    expect(runner.getPeerSeats().has('old-peer')).toBe(false)
    // 新 peerId 重进（昵称匹配）→ 恢复座位。此测试不提供大厅座位表，走兼容兜底。
    room.emit('new-peer', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    expect(runner.getLivePeerSeats().get('new-peer')).toBe(1)
    // continue 屏障的判定输入：座位已归还真人 → 必须要求该新 peer 确认。
    expect(runner.getLivePeerSeats().has('old-peer')).toBe(false)
    // 推进时钟触发开局公告等 fake timer，避免 teardown 时 window 已还原报错。
    await vi.advanceTimersByTimeAsync(2000)
    runner.stop()
  })

  it('大厅先验证新 peerId 时无需第二条 hello 也能恢复座位和结算快照', async () => {
    stubWindow()
    const hostRoom = createMockVibeRoom(true)
    const runner = startHostGame<PlayerController>({
      room: hostRoom,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map([['old-peer', 1]]),
      createController: (room, peerId, onPending, onAI, requestContext) => new RemotePlayerController(
        room, peerId, onPending, undefined, onAI, requestContext,
      ),
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    hostRoom.emitPeer({ type: 'reconnecting', id: 'old-peer' })
    runner.syncVerifiedPeerSeats(new Map([['new-peer', 1]]))

    expect(runner.getPeerSeats().get('new-peer')).toBe(1)
    expect(runner.getPeerSeats().has('old-peer')).toBe(false)
    expect(hostRoom.sent.some(({ message, to }) => (
      to === 'new-peer' && (message as { kind?: string; seat?: number }).kind === 'rejoin_ok'
        && (message as { seat?: number }).seat === 1
    ))).toBe(true)
    expect(hostRoom.sent.some(({ message, to }) => (
      to === 'new-peer' && (message as { kind?: string }).kind === 'state_snapshot'
    ))).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    runner.stop()
  })

  it('胡牌结算阶段断线不能转 AI 跳过真人确认屏障', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map([['peer-1', 1]]),
      createController: (r, peerId, onPending, onAI, requestContext) => new RemotePlayerController(
        r, peerId, onPending, undefined, onAI, requestContext,
      ),
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    await vi.advanceTimersByTimeAsync(1000)
    runner.game.phase.value = 'settled'
    room.emitPeer({ type: 'reconnecting', id: 'peer-1' })
    const beforeHello = room.sent.filter(({ message }) => (
      (message as { kind?: string }).kind === 'rejoin_ok'
    )).length
    room.emit('peer-1', { type: 'lobby_hello', nickname: '玩家1', avatar: '' })
    await vi.advanceTimersByTimeAsync(499)
    expect(room.sent.filter(({ message }) => (
      (message as { kind?: string }).kind === 'rejoin_ok'
    ))).toHaveLength(beforeHello + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(room.sent.filter(({ message }) => (
      (message as { kind?: string }).kind === 'rejoin_ok'
    ))).toHaveLength(beforeHello + 2)
    await vi.advanceTimersByTimeAsync(12000)

    expect(runner.aiControlledSeats.has(1)).toBe(false)
    expect(runner.getPeerSeats().get('peer-1')).toBe(1)
    expect(runner.enableAIForSeat(1)).toBe(false)
    runner.stop()
  })

  it('终局状态变化只即时广播一次，不按时间周期重发', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const snapshots: ServerSnapshot[] = []
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map(),
      createController: () => ({}) as PlayerController,
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: (snapshot) => snapshots.push(snapshot),
      onLocalEvent: () => {},
    })
    await vi.advanceTimersByTimeAsync(1000)
    snapshots.splice(0)

    runner.game.matchFinished.value = true
    runner.game.phase.value = 'finished'
    await vi.advanceTimersByTimeAsync(2500)

    const finished = snapshots.filter((snapshot) => snapshot.matchFinished && snapshot.phase === 'finished')
    expect(finished).toHaveLength(1)
    runner.stop()
  })

  it('单局结算变化即时广播一次公共事实，不按时间周期重发', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const snapshots: ServerSnapshot[] = []
    let setPending!: (pending: boolean) => void
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map([['peer-1', 1]]),
      createController: (_room, _peerId, onPending) => {
        setPending = onPending
        return new AiController()
      },
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: (snapshot) => snapshots.push(snapshot),
      onLocalEvent: () => {},
    })
    await vi.advanceTimersByTimeAsync(1000)
    snapshots.splice(0)

    // 点炮/抢杠等竞争裁决中，胜者已经确定时其他 claim promise 可能仍在收尾。
    // 旧守卫会因为这个 pending 永久压住 settled 快照。
    setPending(true)
    runner.game.result.value = {
      winnerIndex: 0,
      winner: runner.game.players[0]?.name ?? 'P0',
      roundLabel: '东1局',
      honba: 0,
      horses: [],
      hits: 0,
      multiplier: 1,
      totalMultiplier: 1,
      points: 100,
      totalWon: 300,
      details: [],
      scoreChanges: [],
    }
    runner.game.phase.value = 'settled'
    await vi.advanceTimersByTimeAsync(2500)

    const settled = snapshots.filter((snapshot) => snapshot.phase === 'settled' && snapshot.result)
    expect(settled).toHaveLength(1)
    const publicSettled = room.sent.filter(({ message, to }) => (
      to == null && (message as { kind?: string }).kind === 'round_settled'
    ))
    expect(publicSettled).toHaveLength(1)
    for (const { message } of publicSettled) {
      expect(message).not.toHaveProperty('players')
      expect(message).not.toHaveProperty('wall')
      expect(message).toMatchObject({ roomId: 'ROOM', round: 1, honba: 0 })
    }

    room.sent.splice(0)
    runner.resendCurrentState()
    expect(room.sent.some(({ message, to }) => (
      to == null && (message as { kind?: string }).kind === 'round_settled'
    ))).toBe(true)
    expect(room.sent.some(({ message, to }) => (
      to === 'peer-1' && (message as { kind?: string }).kind === 'state_snapshot'
    ))).toBe(true)
    runner.stop()
  })

  it('客户端亮牌后可按当前代次和局次单次请求补发结算事实', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map([['peer-1', 1]]),
      createController: () => new AiController(),
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    await vi.advanceTimersByTimeAsync(1000)
    runner.game.result.value = { winnerIndex: 0 }
    runner.game.phase.value = 'settled'
    await vi.advanceTimersByTimeAsync(50)
    room.sent.splice(0)

    room.emit('peer-1', {
      type: 'settlement_sync_request', authorityEpoch: runner.authorityEpoch,
      round: runner.game.round.value, honba: runner.game.honba.value,
    })
    const publicNotice = room.sent.find(({ message, to }) => (
      to == null && (message as { kind?: string }).kind === 'round_settled'
    ))
    const directedSnapshot = room.sent.find(({ message, to }) => (
      to === 'peer-1' && (message as { kind?: string }).kind === 'state_snapshot'
    ))
    expect(publicNotice).toBeTruthy()
    expect(directedSnapshot).toBeTruthy()

    room.sent.splice(0)
    room.emit('peer-1', {
      type: 'settlement_sync_request', authorityEpoch: 'old-epoch',
      round: runner.game.round.value, honba: runner.game.honba.value,
    })
    room.emit('peer-1', {
      type: 'settlement_sync_request', authorityEpoch: runner.authorityEpoch,
      round: runner.game.round.value + 1, honba: runner.game.honba.value,
    })
    expect(room.sent).toEqual([])
    runner.stop()
  })

  it('胡牌开始时只按状态变化广播一次特效，不按时间重发且不泄露暗牌', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const runner = startHostGame<PlayerController>({
      room,
      rulesetId: 'lotus-classic',
      mode: 'east',
      seatByPeer: new Map([['peer-1', 1]]),
      createController: () => new AiController(),
      createGame: (controllers) => useGame({
        remoteControllers: controllers,
        playSound: () => {},
        playSoundAndWait: async () => {},
        countdownEnabled: false,
        headless: true,
      }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    await vi.advanceTimersByTimeAsync(1000)
    room.sent.splice(0)

    runner.game.winningPlayerIndex.value = 0
    runner.game.winPresentation.value = {
      winnerIndex: 0, tile: 'm1', sourceIndex: -1, robbedKong: false,
      robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
    }
    await vi.advanceTimersByTimeAsync(900)

    const events = room.sent.filter(({ message, to }) => (
      to == null && (message as { kind?: string }).kind === 'win_effect'
    ))
    expect(events).toHaveLength(1)
    for (const { message } of events) {
      expect(message).not.toHaveProperty('players')
      expect(message).not.toHaveProperty('wall')
      expect(message).not.toHaveProperty('result')
      expect(message).toMatchObject({ roomId: 'ROOM', round: 1, honba: 0, winningPlayerIndex: 0 })
    }
    runner.stop()
  })

  it('SDK reconnecting 后切换 relay → 不接管 AI', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const runner = startHostGame<LotusController>({
      room,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([['peer-relay', 1]]),
      seatNames: new Map([[1, '中继玩家']]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })

    room.emitPeer({ type: 'reconnecting', id: 'peer-relay' })
    await vi.advanceTimersByTimeAsync(5000)
    room.emitPeer({ type: 'relay', id: 'peer-relay', active: true })
    await vi.advanceTimersByTimeAsync(12000)
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    runner.stop()
  })

  it('重连恢复后掉线超时从重发时刻重新计算：在线思考的玩家不被旧计时器误判掉线', async () => {
    stubWindow()
    const room = createMockVibeRoom(true)
    const runner = startHostGame<LotusController>({
      room,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([['peer-x', 1]]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    // 推进到闲家回合：turn_request 发给 peer-x，掉线计时（18s）开始。
    let turnSent = false
    for (let i = 0; i < 400 && !turnSent; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      driveHostSeat(runner)
      turnSent = room.sent.some((s) => (s.message as { kind?: string })?.kind === 'turn_request' && s.to === 'peer-x')
    }
    expect(turnSent).toBe(true)

    // 客户端掉线 5s 后重连（SDK 恢复连接事件，同 peerId）：挂起请求还在（未到 25s
    // 超时、无 leave 事件）→ 恢复后重发请求，掉线计时必须从重发时刻重新计算。
    await vi.advanceTimersByTimeAsync(5000)
    const beforeResend = room.sent.filter((s) => (s.message as { kind?: string })?.kind === 'turn_request').length
    room.emitPeer({ type: 'join', id: 'peer-x' })
    const afterResend = room.sent.filter((s) => (s.message as { kind?: string })?.kind === 'turn_request').length
    expect(afterResend).toBeGreaterThan(beforeResend) // resendPending 重发

    // 原计时到期点（掉线后 25s = 重连后 20s）：不得误判在线思考的玩家掉线。
    // （重连后重新计时的到期点由「客户端不响应 → AI 接管」测试覆盖，此处只验证
    // 旧计时器不会把刚重连的在线玩家误判掉线。）
    await vi.advanceTimersByTimeAsync(20000)
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    // 推进时钟触发开局公告等 fake timer，避免 teardown 时 window 已还原报错。
    await vi.advanceTimersByTimeAsync(2000)
    runner.stop()
  })

  it('enableAIForSeat 可外部强制接管座位（续接安全网），并递增接管版本号', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const hostRoom = await hostClient.room.join('SAFETY1')
    const guestRoom = await guestClient.room.join('SAFETY1')
    stubWindow()
    const runner = startHostGame<LotusController>({
      room: hostRoom,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([[guestRoom.peerId, 1]]),
      createController: (r, peerId, onPending, onAI) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })
    // 局末断线场景：座位没有挂起请求（从未触发 15s 超时）→ 不在 AI 名单。
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    const versionBefore = runner.aiControlledSeatsVersion.value
    expect(runner.enableAIForSeat(1)).toBe(true)
    expect(runner.aiControlledSeats.has(1)).toBe(true)
    expect(runner.aiControlledSeatsVersion.value).toBe(versionBefore + 1)
    // 已接管再调 → 无效（不重复播报/递增）。
    expect(runner.enableAIForSeat(1)).toBe(false)
    expect(runner.aiControlledSeatsVersion.value).toBe(versionBefore + 1)
    // 空座位 / 不存在座位 → 无效。
    expect(runner.enableAIForSeat(2)).toBe(false)
    expect(runner.enableAIForSeat(9)).toBe(false)
    // 推进时钟，让开局公告等 fake timer 全部触发，避免 teardown 时 window 已还原报错。
    await vi.advanceTimersByTimeAsync(2000)
    runner.stop()
  })

  it('AI 接管后玩家恢复响应 → 归还座位（不再永久代打）', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const hostRoom = await hostClient.room.join('RECLAIM1')
    const guestRoom = await guestClient.room.join('RECLAIM1')
    stubWindow()
    const guestMessages: Array<{ kind?: string; requestId?: string }> = []
    let autoPassClaims = true
    guestRoom.onMessage((message) => guestMessages.push(message as never))
    guestRoom.onMessage((message) => {
      if (autoPassClaims && (message as { kind?: string })?.kind === 'claim_request') guestRoom.send({ type: 'pass' })
    })
    const runner = startHostGame<LotusController>({
      room: hostRoom,
      rulesetId: 'lotus-legacy',
      mode: 'east',
      seatByPeer: new Map([[guestRoom.peerId, 1]]),
      createController: (r, peerId, onPending, onAI, requestContext) => new LotusRemotePlayerController(r, peerId, onPending, undefined, onAI, requestContext),
      createGame: (controllers) => useLotusGame({ remoteControllers: controllers, countdownEnabled: false, headless: true }),
      onLocalSnapshot: () => {},
      onLocalEvent: () => {},
    })

    // 推进到闲家回合，客人不响应 → 25s 超时 AI 接管（轮询等待，见刷新重进测试注释）。
    let sawTurnRequest = false
    for (let i = 0; i < 600 && !sawTurnRequest; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      driveHostSeat(runner)
      sawTurnRequest = guestMessages.some((message) => message?.kind === 'turn_request')
    }
    expect(sawTurnRequest).toBe(true)
    let aiTook = false
    for (let i = 0; i < 600 && !aiTook; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      aiTook = runner.aiControlledSeats.has(1)
    }
    expect(aiTook).toBe(true)
    // 旧请求不归还 AI 的协议门禁由 RemotePlayerController / LotusRemotePlayerController
    // 的专门单测覆盖；这里验证 host runner 收到当前连接 hello 后能正确归还座位。
    autoPassClaims = false
    guestRoom.send({ type: 'lobby_hello', nickname: runner.game.players[1].name, avatar: '' })
    await vi.advanceTimersByTimeAsync(100)
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    runner.stop()
  }, 20000)
})
