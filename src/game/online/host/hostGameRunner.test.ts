import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../../core/local/useGame'
import { AiController, type PlayerController } from '../../core/controllers/playerController'
import type { ServerSnapshot } from '../protocol/dto'
import type { ServerMessage } from '../protocol/messages'
import { startHostGame } from './hostGameRunner'
import { createMockVibeRoom } from './mockVibeRoom'
import { createMockVibeClient } from '../vibe/mockVibeHub'
import { useLotusGame } from '../../variants/lotus/lotusGame'
import { LotusRemotePlayerController } from './lotusRemotePlayerController'
import { windKong } from '../../variants/lotus/lotusRules'
import type { LotusController } from '../../variants/lotus/lotusControllers'
import type { TileType } from '../../core/contracts/types'

function stubWindow() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('startHostGame 无头权威', () => {
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
      if (runner.game.phase.value === 'discard' && runner.game.currentPlayer.value === 0) {
        const handLength = runner.game.players[0]?.hand.length ?? 1
        runner.game.userDiscard(handLength - 1)
      }
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
      if (runner.game.phase.value === 'discard' && runner.game.currentPlayer.value === 0) {
        const handLength = runner.game.players[0]?.hand.length ?? 1
        runner.game.userDiscard(handLength - 1)
      }
      sawTurnRequest = guestMessages.some((message) => message?.kind === 'turn_request')
    }
    expect(sawTurnRequest).toBe(true)

    // 客人不响应 → 超过房主 15s 超时 → AI 接管座位。
    await vi.advanceTimersByTimeAsync(16000)
    expect(runner.aiControlledSeats.has(1)).toBe(true)
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
    // 掉线：直接关闭标签页（leave）→ 房主 AI 接管座位。
    guestRoomA.leave()
    await vi.advanceTimersByTimeAsync(200)
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
    await vi.advanceTimersByTimeAsync(300)
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
    expect(runner.aiControlledSeats.has(1)).toBe(true)

    // 重连：peerId 变了（新标签页无 sessionStorage），但昵称相同 → 房主按昵称兜底恢复座位。
    const guestB = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000, peerId: 'guest-y' })
    const guestBJoin = guestB.room.join('FALLBACK1')
    await vi.advanceTimersByTimeAsync(200)
    const guestRoomB = await guestBJoin
    const rejoinMessages: Array<{ kind?: string; seat?: number }> = []
    guestRoomB.onMessage((message) => rejoinMessages.push(message as never))
    guestRoomB.send({ type: 'lobby_hello', nickname: '重连客A', avatar: '' })
    await vi.advanceTimersByTimeAsync(300)
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

    // 推进到闲家回合，不响应 → 15s 超时 AI 接管。
    let sawTurnRequest = false
    for (let i = 0; i < 300 && !sawTurnRequest; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      if (runner.game.phase.value === 'discard' && runner.game.currentPlayer.value === 0) {
        const handLength = runner.game.players[0]?.hand.length ?? 1
        runner.game.userDiscard(handLength - 1)
      }
      sawTurnRequest = guestMessagesA.some((message) => message?.kind === 'turn_request')
    }
    expect(sawTurnRequest).toBe(true)
    await vi.advanceTimersByTimeAsync(16000)
    expect(runner.aiControlledSeats.has(1)).toBe(true)

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
    await vi.advanceTimersByTimeAsync(300)

    // 座位恢复 + rejoin_ok + 对局快照（此前按静态 seatByPeer 广播，新 peerId 永远收不到）。
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    const rejoinOk = rejoinMessages.find((message) => message?.kind === 'rejoin_ok')
    expect(rejoinOk?.seat).toBe(1)
    const snapshot = rejoinMessages.find((message) => message?.kind === 'state_snapshot')
    expect(snapshot).toBeTruthy()

    // 新窗口收到回合请求并能正常响应 → 引擎接受弃牌，座位不再被 AI 反复接管。
    let responded = false
    for (let i = 0; i < 400 && !responded; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      if (runner.game.phase.value === 'discard' && runner.game.currentPlayer.value === 0) {
        const handLength = runner.game.players[0]?.hand.length ?? 1
        runner.game.userDiscard(handLength - 1)
      }
      if (rejoinMessages.some((message) => message?.kind === 'turn_request')) {
        guestRoomB.send({ type: 'discard', handIndex: 0 })
        responded = true
      }
    }
    expect(responded).toBe(true)
    // 弃牌被接受 → 回合推进到下一家（不再停留在座位 1）。
    for (let i = 0; i < 200; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      if (runner.game.phase.value === 'discard' && runner.game.currentPlayer.value !== 1) break
    }
    expect(runner.game.currentPlayer.value).not.toBe(1)
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    runner.stop()
  }, 20000)

  it('AI 接管后玩家恢复响应 → 归还座位（不再永久代打）', async () => {
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const guestClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const hostRoom = await hostClient.room.join('RECLAIM1')
    const guestRoom = await guestClient.room.join('RECLAIM1')
    stubWindow()
    const guestMessages: Array<{ kind?: string }> = []
    guestRoom.onMessage((message) => guestMessages.push(message as never))
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

    // 推进到闲家回合，客人不响应 → 15s 超时 AI 接管。
    let sawTurnRequest = false
    for (let i = 0; i < 300 && !sawTurnRequest; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      if (runner.game.phase.value === 'discard' && runner.game.currentPlayer.value === 0) {
        const handLength = runner.game.players[0]?.hand.length ?? 1
        runner.game.userDiscard(handLength - 1)
      }
      sawTurnRequest = guestMessages.some((message) => message?.kind === 'turn_request')
    }
    expect(sawTurnRequest).toBe(true)
    await vi.advanceTimersByTimeAsync(16000)
    expect(runner.aiControlledSeats.has(1)).toBe(true)

    // 接管后 AI 只是兜底，仍持续给玩家发请求；玩家恢复响应 → 归还座位。
    const beforeCount = guestMessages.filter((message) => message?.kind === 'turn_request').length
    let reclaimed = false
    for (let i = 0; i < 400 && !reclaimed; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      if (runner.game.phase.value === 'discard' && runner.game.currentPlayer.value === 0) {
        const handLength = runner.game.players[0]?.hand.length ?? 1
        runner.game.userDiscard(handLength - 1)
      }
      const count = guestMessages.filter((message) => message?.kind === 'turn_request').length
      if (count > beforeCount) {
        guestRoom.send({ type: 'discard', handIndex: 0 })
        reclaimed = true
      }
    }
    expect(reclaimed).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(runner.aiControlledSeats.has(1)).toBe(false)
    runner.stop()
  }, 20000)
})
