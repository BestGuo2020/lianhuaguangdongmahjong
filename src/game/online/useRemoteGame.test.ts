import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteGame } from './useRemoteGame'
import type { GamePlayer, TileType } from '../core/contracts/types'
import type { ServerPlayerDto } from './protocol/dto'

// ─── Mock WebSocket / fetch / window ──────────────────────

let mockSocket: MockWebSocket | null = null

class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    mockSocket = this
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorJson(code: string, status = 409) {
  return new Response(JSON.stringify({ detail: { code } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  const store: Record<string, string> = {}
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
    },
  })
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    // 与 API_BASE 解耦（可能被 .env 的 VITE_API_BASE 指到 Vite 代理源）
    const path = new URL(String(input)).pathname
    if (path === '/api/rooms' && init?.method === 'POST') {
      return json({ roomId: 'ABC123', mode: 'east', capacity: 4, status: 'lobby', creatorSeat: null, seats: [null, null, null, null] })
    }
    if (path === '/api/rooms/ABC123/join' && init?.method === 'POST') {
      return json({ roomId: 'ABC123', seat: 2, nickname: '测试', rejoinCode: 'AAAA-BBBB', rejoin: false })
    }
    if (path === '/api/rooms/ABC123/leave' && init?.method === 'POST') {
      return json({ roomId: 'ABC123', seat: 2, left: true })
    }
    if (path === '/api/rooms/ABC123' && init?.method === 'DELETE') {
      return json({ roomId: 'ABC123', closed: true })
    }
    if (path === '/api/rooms/ABC123') {
      return json({ roomId: 'ABC123', mode: 'east', capacity: 4, status: 'lobby', creatorSeat: 2, seats: [null, null, null, null] })
    }
    if (path === '/api/players/测试/stats') {
      return json({ nickname: '测试', matches: 3, hands: 12, wins: 4, totalDelta: 350 })
    }
    throw new Error(`unexpected fetch: ${path}`)
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  mockSocket = null
})

// ─── 构造快照辅助 ────────────────────────────────────────

function makePlayer(seat: number, name: string, hand: Array<TileType | null> = []): ServerPlayerDto {
  return { name, avatar: '', score: 1000, seat, hand, discards: [], melds: [], redCount: 0, drawnTileIndex: -1 }
}

const SERVER_PLAYERS = [
  makePlayer(0, 'AI0', [null, null, null]),
  makePlayer(1, 'AI1', [null, null, null]),
  makePlayer(2, '本家', ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'east', 'east', 'white']),
  makePlayer(3, 'AI3', [null, null, null]),
]

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'state_snapshot',
    roomId: 'ABC123',
    mode: 'east',
    phase: 'drawing',
    round: 1,
    dealer: 0,
    honba: 0,
    wallCount: 80,
    wall: [],
    headDrawn: 0,
    currentPlayer: 2,
    players: SERVER_PLAYERS,
    seat: 2,
    result: null,
    announcement: null,
    matchFinished: false,
    lastDiscard: null,
    winPresentation: null,
    winningPlayerIndex: -1,
    ...overrides,
  }
}

async function connectGame(options: Parameters<typeof useRemoteGame>[0] = {}) {
  const game = useRemoteGame(options)
  await game.remoteActions.createRoom('east', 4)
  expect(mockSocket).not.toBeNull()
  mockSocket!.open()
  mockSocket!.receive({
    kind: 'rejoin_ok',
    seat: 2,
    rejoin: false,
    roomId: 'ABC123',
    mode: 'east',
    nickname: '测试',
    rejoinCode: 'AAAA-BBBB',
  })
  return game
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('useRemoteGame 座位旋转与快照应用', () => {
  it('把本家排到 players[0]，隐藏他人手牌，映射座位索引', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())

    // 本家（服务端座位 2）在本地恒为 index 0，顺序按相对座位排列
    expect(game.players.map((p) => p.seat)).toEqual([2, 3, 0, 1])
    expect(game.players[0].name).toBe('本家')
    // 本人手牌可见，他人手牌隐藏
    expect(game.players[0].hand).toHaveLength(13)
    expect(game.players[0].concealedTileCount).toBe(13)
    expect(game.players[1].hand).toEqual([])
    expect(game.players[1].concealedTileCount).toBe(3)
    expect(game.players[2].hand).toEqual([])
    expect(game.players[2].concealedTileCount).toBe(3)
    expect(game.players.flatMap((player) => player.hand)).not.toContain(null)
    // currentPlayer / dealer 服务端座位 → 本地索引
    expect(game.currentPlayer.value).toBe(0)   // 服务端 2 → 本家
    expect(game.dealer.value).toBe(2)          // 服务端 0 → 本地 2
    expect(game.round.value).toBe(1)
    expect(game.wallCount.value).toBe(80)
    expect(game.phase.value).toBe('playing')
    // 空昵称头像补默认（按服务端座位稳定分配）
    expect(game.players[2].avatar).toContain('lotus')
  })

  it('副露来源 from 从服务端座位映射为本地索引（非房主也能正确指向）', async () => {
    const game = await connectGame()   // 本家服务端座位 2
    const players = SERVER_PLAYERS.map((p) => ({ ...p }))
    // 服务端座位 1 的玩家有一个碰副露，来源是服务端座位 3
    players[1].melds = [{ type: 'peng', tile: 'm1', from: 3, tiles: ['m1', 'm1', 'm1'] }]

    mockSocket!.receive(makeSnapshot({ players }))

    // 本地顺序：seat 2(本家)→0, 3→1, 0→2, 1→3
    expect(game.players[3].seat).toBe(1)
    expect(game.players[3].melds[0].from).toBe(1)   // 服务端 3 → 本地 (3-2+4)%4=1
  })

  it('预开局 lobby 快照保持 lobby 面板（不推成 playing，否则无法准备/开局）', async () => {
    const game = await connectGame()

    // 真实时序：WS 握手后服务端立刻广播一份 phase='lobby' 的预开局快照
    // （game_ws.py 在 rejoin_ok 后 send build_snapshot，此时 room.manager 为 None）
    mockSocket!.receive(makeSnapshot({ phase: 'lobby', players: [], currentPlayer: -1, wallCount: 0 }))

    expect(game.phase.value).toBe('lobby')
    // 房间会话仍在，房间面板 / 开始对局按钮依赖 lobby 阶段
    expect(game.roomId.value).toBe('ABC123')
    expect(game.players.length).toBe(0)

    // 对局真正开始后的快照（phase='opening'）才进入 playing，3D 牌桌出现
    mockSocket!.receive(makeSnapshot({ phase: 'opening', currentPlayer: 2 }))
    expect(game.phase.value).toBe('playing')
    expect(game.players.length).toBe(4)
  })

  it('turn_request 激活出牌回合并可发送弃牌动作', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())
    mockSocket!.receive({
      kind: 'turn_request',
      ctx: { hand: SERVER_PLAYERS[2].hand, melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false },
    })

    expect(game.phase.value).toBe('discard')
    expect(game.isUserTurn.value).toBe(true)
    expect(game.actionPrompt.value).toBeNull()

    game.userDiscard(0)
    expect(mockSocket!.sent).toContain(JSON.stringify({ type: 'discard', handIndex: 0 }))
  })

  it('claim_request 显示碰/杠提示，from 映射到本地索引', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())
    mockSocket!.receive({
      kind: 'claim_request',
      ctx: { hand: ['m5', 'm5'], canGang: true, tile: 'm5', from: 3 },
    })

    expect(game.phase.value).toBe('prompt')
    expect(game.actionPrompt.value?.type).toBe('claim')
    expect(game.actionPrompt.value?.canGang).toBe(true)
    expect(game.actionPrompt.value?.canPeng).toBe(true)
    expect(game.actionPrompt.value?.from).toBe(1)   // 服务端 3 → 本地 1

    game.userPeng()
    expect(mockSocket!.sent).toContain(JSON.stringify({ type: 'claim', action: 'peng' }))
  })

  it('用户动作发送协议与 useGame 一致', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())

    // 杠（本家手牌含 4 张 east → 暗杠；碰副露时走 added）
    mockSocket!.receive({
      kind: 'turn_request',
      ctx: { hand: SERVER_PLAYERS[2].hand, melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false },
    })
    game.userGang('east')
    expect(mockSocket!.sent).toContain(JSON.stringify({ type: 'gang', kind: 'concealed', tile: 'east' }))
  })
})

describe('useRemoteGame 自动打牌', () => {
  it('开启后 turn_request 到达自动弃牌（无需手动点）', async () => {
    const game = await connectGame()
    game.toggleAutoPlay()
    expect(game.autoPlay.value).toBe(true)
    mockSocket!.receive(makeSnapshot())
    mockSocket!.receive({
      kind: 'turn_request',
      ctx: { hand: SERVER_PLAYERS[2].hand, melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false },
    })
    expect(game.phase.value).toBe('discard')
    await vi.advanceTimersByTimeAsync(1000)   // 超过 AUTO_PLAY_DELAY(600ms)
    expect(mockSocket!.sent.filter((s) => s.includes('"discard"')).length).toBe(1)
  })

  it('关闭时保持手动：turn_request 不自动出牌', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())
    mockSocket!.receive({
      kind: 'turn_request',
      ctx: { hand: SERVER_PLAYERS[2].hand, melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false },
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockSocket!.sent.filter((s) => s.includes('"discard"')).length).toBe(0)
  })

  it('开启后 claim_request 到达自动过牌', async () => {
    const game = await connectGame()
    game.toggleAutoPlay()
    mockSocket!.receive(makeSnapshot())
    mockSocket!.receive({
      kind: 'claim_request',
      ctx: { hand: [], canGang: true, tile: 'm5', from: 3 },
    })
    expect(game.phase.value).toBe('prompt')
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockSocket!.sent).toContain(JSON.stringify({ type: 'pass' }))
  })
})

describe('useRemoteGame 网络信号（连接健康度）', () => {
  it('心跳 pong 正常 → 信号按平滑 RTT 保持高格', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())
    await vi.advanceTimersByTimeAsync(5000)   // 触发首个 ping
    mockSocket!.receive({ kind: 'pong' })      // RTT≈0，心跳正常
    expect(game.signalQuality.value).toBe(3)
  })

  it('长时间无服务端消息 → 判定连接卡死并主动重连', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())
    await vi.advanceTimersByTimeAsync(16000)  // 超 STALL_TIMEOUT(15s)：半死连接
    expect(game.wsStatus.value).toBe('reconnecting')
    expect(game.signalQuality.value).toBe(0)
  })

  it('重连后信号上限 1 格，连续 2 个干净 pong 后恢复', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())
    await vi.advanceTimersByTimeAsync(16000)  // 卡死 → 断开
    await vi.advanceTimersByTimeAsync(2000)   // 退避后 connect() 建新连接
    mockSocket!.open()                        // 模拟 onopen
    expect(game.wsStatus.value).toBe('connected')

    // 第 1 个干净 pong：仍在「重连降级」窗口 → 上限 1 格
    await vi.advanceTimersByTimeAsync(5000)
    mockSocket!.receive({ kind: 'pong' })
    expect(game.signalQuality.value).toBe(1)

    // 第 2 个干净 pong：解除降级，恢复高格
    await vi.advanceTimersByTimeAsync(5000)
    mockSocket!.receive({ kind: 'pong' })
    expect(game.signalQuality.value).toBe(3)
  })

  it('重连握手后用最新快照恢复座位、回合和隐藏手牌数量', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot())
    await vi.advanceTimersByTimeAsync(16000)
    await vi.advanceTimersByTimeAsync(2000)

    mockSocket!.open()
    mockSocket!.receive({
      kind: 'rejoin_ok', seat: 2, rejoin: true, roomId: 'ABC123', mode: 'east',
      nickname: '测试', rejoinCode: 'AAAA-BBBB',
    })
    mockSocket!.receive(makeSnapshot({ round: 2, currentPlayer: 3, wallCount: 51 }))

    expect(game.wsStatus.value).toBe('connected')
    expect(game.round.value).toBe(2)
    expect(game.currentPlayer.value).toBe(1)
    expect(game.wallCount.value).toBe(51)
    expect(game.players[0].seat).toBe(2)
    expect(game.players[1]).toMatchObject({ seat: 3, hand: [], concealedTileCount: 3 })
  })
})

describe('useRemoteGame 结算展示与延迟队列', () => {
  it('settled 快照触发赢牌动画序列，result 座位索引映射正确', async () => {
    const game = await connectGame()
    const winnerResult = {
      winnerIndex: 2,
      winner: '本家',
      roundLabel: '东1局',
      honba: 0,
      horses: [],
      hits: 0,
      multiplier: 1,
      totalMultiplier: 1,
      points: 100,
      totalWon: 300,
      details: [{ label: '自摸', multiplier: 1 }],
      scoreChanges: [
        { playerIndex: 0, name: 'AI0', avatar: '', score: 900, delta: -100, rank: 2 },
        { playerIndex: 1, name: 'AI1', avatar: '', score: 900, delta: -100, rank: 3 },
        { playerIndex: 2, name: '本家', avatar: '', score: 1300, delta: 300, rank: 1 },
        { playerIndex: 3, name: 'AI3', avatar: '', score: 900, delta: -100, rank: 4 },
      ],
    }
    mockSocket!.receive(makeSnapshot({
      phase: 'settled',
      result: winnerResult,
      winPresentation: { winnerIndex: 2, tile: 'm1', sourceIndex: -1, robbedKong: false, robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1 },
      winningPlayerIndex: 2,
    }))

    // 赢牌动画阶段：本家（服务端 2 → 本地 0）
    expect(game.phase.value).toBe('win-effect')
    expect(game.winningPlayerIndex.value).toBe(0)
    expect(game.winPresentation.value?.winnerIndex).toBe(0)

    // 动画结束 → 翻牌 → 结算弹窗
    await vi.advanceTimersByTimeAsync(2600)
    expect(game.phase.value).toBe('revealing')
    expect(game.revealHands.value).toBe(true)
    // 亮牌前必须清掉 winEffect：否则 3D rebuild 会用新 startedAt 重播胡牌特效（"执行两遍"）
    expect(game.winEffect.value).toBeNull()
    await vi.advanceTimersByTimeAsync(1500)
    expect(game.phase.value).toBe('settled')
    expect(game.result.value?.winnerIndex).toBe(0)
    expect(game.result.value?.scoreChanges[2].playerIndex).toBe(0)   // 本家
    expect(game.result.value?.scoreChanges[0].playerIndex).toBe(2)   // 原座位 0
    expect(game.result.value?.scoreChanges[0].avatar).toContain('lotus')
  })

  it('结算展示期间到达的下一局快照被延迟；点继续后对话框保留，round_start 到达才开下一局', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot({
      phase: 'settled',
      result: { winnerIndex: 2, winner: '本家', roundLabel: '东1局', honba: 0, horses: [], hits: 0, multiplier: 1, totalMultiplier: 1, points: 100, totalWon: 300, details: [], scoreChanges: [] },
      winPresentation: { winnerIndex: 2, tile: 'm1', sourceIndex: -1, robbedKong: false, robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1 },
      winningPlayerIndex: 2,
    }))
    expect(game.phase.value).toBe('win-effect')

    // 下一局快照在结算展示期间到达 → 延迟
    mockSocket!.receive(makeSnapshot({ phase: 'drawing', round: 2, dealer: 1, lastDiscard: { tile: 'm9', from: 0, id: 1 } }))
    expect(game.phase.value).toBe('win-effect')   // 未被打断

    await vi.advanceTimersByTimeAsync(4100)
    expect(game.phase.value).toBe('settled')
    expect(game.result.value).not.toBeNull()

    // 点继续：确认发送，但对话框保留（结算态不清），等待其他玩家
    game.nextRound()
    expect(mockSocket!.sent).toContain(JSON.stringify({ type: 'continue' }))
    expect(game.waitingNextRound.value).toBe(true)
    expect(game.phase.value).toBe('settled')
    expect(game.result.value).not.toBeNull()

    // 等齐后服务端推进 → round_start 到达 → 结算态清除，进入下一局开局
    mockSocket!.receive({ kind: 'round_start', matchStarted: false, round: 2, dealer: 1, honba: 0, dice: [2, 2] })
    expect(game.waitingNextRound.value).toBe(false)
    expect(game.result.value).toBeNull()
    expect(game.phase.value).toBe('dealing')

    // 开局动画结束（未发开局快照 → 跳过发牌）→ 缓冲的下一局快照落地
    await vi.advanceTimersByTimeAsync(1250 + 1150 + 650)
    expect(game.round.value).toBe(2)
    expect(game.lastDiscard.value?.from).toBe(2) // 服务端 0 → 本地 (0-2+4)%4=2
  })

  it('match_finished 立即应用最终成绩，覆盖结算展示', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot({
      phase: 'settled',
      result: { winnerIndex: 2, winner: '本家', roundLabel: '东1局', honba: 0, horses: [], hits: 0, multiplier: 1, totalMultiplier: 1, points: 100, totalWon: 300, details: [], scoreChanges: [] },
      winPresentation: { winnerIndex: 2, tile: 'm1', sourceIndex: -1, robbedKong: false, robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1 },
      winningPlayerIndex: 2,
    }))
    expect(game.phase.value).toBe('win-effect')

    mockSocket!.receive({
      kind: 'match_finished',
      roomId: 'ABC123',
      mode: 'east',
      finalScores: [
        { seat: 0, name: 'AI0', score: 1100 },
        { seat: 1, name: 'AI1', score: 900 },
        { seat: 2, name: '本家', score: 1300 },
        { seat: 3, name: 'AI3', score: 700 },
      ],
    })

    expect(game.phase.value).toBe('finished')
    expect(game.matchFinished.value).toBe(true)
    expect(game.result.value).toBeNull()
    // 最终分数按服务端座位写回
    const me = game.players.find((p) => p.name === '本家')
    expect(me?.score).toBe(1300)
  })
})

describe('useRemoteGame 公告去重与赢牌音效', () => {
  const WINNER_RESULT = {
    winnerIndex: 2,
    winner: '本家',
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
  const WIN_PRESENTATION = {
    winnerIndex: 2, tile: 'm1', sourceIndex: -1, robbedKong: false,
    robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1,
  }
  const settleSnapshot = (overrides: Record<string, unknown> = {}) => makeSnapshot({
    phase: 'settled',
    result: WINNER_RESULT,
    winPresentation: WIN_PRESENTATION,
    winningPlayerIndex: 2,
    ...overrides,
  })

  it('同一公告按服务端 id 去重：只展示一次，新 id 才重新弹出', async () => {
    const game = await connectGame()

    mockSocket!.receive(makeSnapshot({ announcement: { text: '东1局 · 开牌', tone: 'gold', id: 1 } }))
    expect(game.announcement.value?.text).toBe('东1局 · 开牌')

    // 1.5s 自动清除
    await vi.advanceTimersByTimeAsync(1600)
    expect(game.announcement.value).toBeNull()

    // 服务端不清理公告，后续每份快照都携带同 id → 不再弹出
    mockSocket!.receive(makeSnapshot({ announcement: { text: '东1局 · 开牌', tone: 'gold', id: 1 } }))
    expect(game.announcement.value).toBeNull()

    // 新 id（下一局开牌）→ 重新展示
    mockSocket!.receive(makeSnapshot({ announcement: { text: '东2局 · 开牌', tone: 'gold', id: 2 } }))
    expect(game.announcement.value?.text).toBe('东2局 · 开牌')
  })

  it('结算展示期间到达的公告消息不弹出，点继续后保留结算，随 round_start 后的下一局快照展示一次', async () => {
    const game = await connectGame()
    mockSocket!.receive(settleSnapshot())
    expect(game.phase.value).toBe('win-effect')

    // 下一局「开牌」公告在结算展示期间到达 → 忽略（不盖住赢牌动画）
    mockSocket!.receive({ kind: 'announcement', text: '东2局 · 开牌', tone: 'gold', id: 2 })
    expect(game.announcement.value).toBeNull()

    // 下一局快照同步到达 → 被延迟
    mockSocket!.receive(makeSnapshot({ phase: 'drawing', round: 2, dealer: 1, announcement: { text: '东2局 · 开牌', tone: 'gold', id: 2 } }))
    expect(game.phase.value).toBe('win-effect')

    await vi.advanceTimersByTimeAsync(4100)
    expect(game.phase.value).toBe('settled')

    // 点继续：对话框保留等待其他玩家
    game.nextRound()
    expect(game.waitingNextRound.value).toBe(true)
    expect(game.result.value).not.toBeNull()

    // 等齐后 round_start 到达 → 开下一局，缓冲快照落地 → 公告展示一次
    mockSocket!.receive({ kind: 'round_start', matchStarted: false, round: 2, dealer: 1, honba: 0, dice: [2, 2] })
    expect(game.result.value).toBeNull()
    await vi.advanceTimersByTimeAsync(1250 + 1150 + 650)
    expect(game.round.value).toBe(2)
    expect(game.announcement.value?.text).toBe('东2局 · 开牌')

    // 后续快照再带同 id 公告 → 不重复
    await vi.advanceTimersByTimeAsync(1600)
    mockSocket!.receive(makeSnapshot({ phase: 'drawing', round: 2, dealer: 1, announcement: { text: '东2局 · 开牌', tone: 'gold', id: 2 } }))
    expect(game.announcement.value).toBeNull()
  })

  it('settled 快照触发赢牌音效：普通胡 zimo.mp3 + 延迟 hu_effect_sound.mp3', async () => {
    const sounds: string[] = []
    const game = await connectGame({ playSound: (name: string) => { sounds.push(name) } })

    mockSocket!.receive(settleSnapshot())
    expect(sounds).toContain('zimo.mp3')
    // 胡牌特效音：WIN_EFFECT_SOUND_DELAY（320ms）后播出，对齐本地 endGame
    await vi.advanceTimersByTimeAsync(320)
    expect(sounds).toContain('hu_effect_sound.mp3')
  })

  it('抢杠胡播放 hu.mp3 + hu_effect_sound.mp3（robbedKong=true）', async () => {
    const sounds: string[] = []
    const game = await connectGame({ playSound: (name: string) => { sounds.push(name) } })

    mockSocket!.receive(makeSnapshot({
      phase: 'settled',
      result: WINNER_RESULT,
      winPresentation: {
        winnerIndex: 2, tile: 'm1', sourceIndex: 0, robbedKong: true,
        robbedKongPlayerIndex: 0, robbedKongMeldIndex: 0,
      },
      winningPlayerIndex: 2,
    }))
    expect(sounds).toContain('hu.mp3')
    await vi.advanceTimersByTimeAsync(320)
    expect(sounds).toContain('hu_effect_sound.mp3')
  })

  it('hand_result 兜底分支（快照丢失）播放胡牌音效并进入结算', async () => {
    const sounds: string[] = []
    const game = await connectGame({ playSound: (name: string) => { sounds.push(name) } })
    mockSocket!.receive(makeSnapshot())   // 进行中快照
    expect(sounds).not.toContain('zimo.mp3')

    mockSocket!.receive({ kind: 'hand_result', result: WINNER_RESULT })
    expect(game.phase.value).toBe('revealing')
    expect(sounds).toContain('zimo.mp3')

    await vi.advanceTimersByTimeAsync(600)
    expect(game.phase.value).toBe('settled')
    expect(game.result.value?.winnerIndex).toBe(0)   // 服务端 2 → 本家
  })
})

describe('useRemoteGame 开局序列（对局开始 / 骰子）', () => {
  it('round_start 触发开局序列：对局开始覆盖层 → 骰子 → 发牌动画 → 落地', async () => {
    const sounds: string[] = []
    const game = await connectGame({
      playSound: (name: string) => { sounds.push(name) },
      playSoundAndWait: async (name: string) => { sounds.push(name) },
    })

    mockSocket!.receive({ kind: 'round_start', matchStarted: true, round: 1, dealer: 0, honba: 0, dice: [3, 5] })

    // 对局开始覆盖层 + game_start 音效；开局期间为发牌态、空手（骰子复位，不提前展示）
    expect(game.openingStage.value).toBe('start')
    expect(game.diceValues.value).toEqual([1, 1])
    expect(game.round.value).toBe(1)
    expect(game.phase.value).toBe('dealing')
    expect(sounds).toContain('game_start.mp3')

    // 开局动画期间到达的开局快照 → 缓冲：不填表、不报牌；中央牌数显示满墙 136
    mockSocket!.receive(makeSnapshot({ phase: 'opening', currentPlayer: 3, lastDiscard: { tile: 'm5', from: 0, id: 1 } }))
    expect(game.players[0].hand.length).toBe(0)
    expect(game.wallCount.value).toBe(136)   // 满墙，发牌动画期间实时递减
    expect(sounds).not.toContain('dapai.mp3')

    // 1.25s 后进入骰子投掷阶段
    await vi.advanceTimersByTimeAsync(1250)
    expect(game.openingStage.value).toBe('dice')
    expect(game.diceValues.value).toEqual([3, 5])
    expect(sounds).toContain('dice.mp3')

    // 1.15s 后骰子结束 → 发牌动画（三家手牌从空逐步填充）
    await vi.advanceTimersByTimeAsync(1150)
    expect(game.openingStage.value).toBe('deal')
    expect(game.phase.value).toBe('dealing')

    // 发牌动画进行中：本家（座位 0）第一批发到 4 张，dealAnimation 有序列
    await vi.advanceTimersByTimeAsync(780)
    expect(game.players[0].hand.length).toBe(4)
    expect(game.dealAnimation.value.serial).toBeGreaterThan(0)

    // 发牌动画结束（3×4 家×4 张 + 4 家×1 张 ≈ 3720ms）→ 650ms 停顿 → 落地缓冲快照，进入牌局
    await vi.advanceTimersByTimeAsync(3720 - 780)
    await vi.advanceTimersByTimeAsync(650)
    expect(game.openingStage.value).toBeNull()
    expect(game.phase.value).toBe('playing')
    expect(game.players[0].hand.length).toBe(13)
    // 发牌共耗 52 张：满墙 132 → 真实余数 80
    expect(game.wallCount.value).toBe(80)
    // 开局就绪屏障：发牌动画结束 → 发送 opening_done，服务端等所有在线真人就绪才开局
    expect(mockSocket!.sent).toContain(JSON.stringify({ type: 'opening_done' }))

    // 落地时补报开局期间错过的弃牌（id 1），随后新弃牌（id 2）继续报牌
    expect(sounds).toContain('dapai.mp3')
    mockSocket!.receive(makeSnapshot({ phase: 'drawing', currentPlayer: 3, lastDiscard: { tile: 'm5', from: 0, id: 2 } }))
    expect(sounds).toContain('dapai.mp3')
  })

  it('自摸：table_action(self-draw) 展示「自摸」文字但不播音效，zimo 由 startWinSequence 单播一次', async () => {
    const sounds: string[] = []
    const game = await connectGame({ playSound: (name: string) => { sounds.push(name) } })
    mockSocket!.receive(makeSnapshot())   // 进行中快照

    // 服务端自摸广播序列：table_action(self-draw) 先到，settled 快照随后
    mockSocket!.receive({
      kind: 'table_action',
      event: { id: 7, type: 'self-draw', actorIndex: 2, sourceIndex: 3, tile: 'm1', meldIndex: -1 },
    })
    // 2D 文字提示（自摸/抢杠胡）照常展示，但不单独播音效
    expect(game.tableActionEvent.value?.type).toBe('self-draw')
    expect(game.tableActionEvent.value?.actorIndex).toBe(0)   // 服务端 2 → 本家
    expect(sounds).not.toContain('zimo.mp3')

    mockSocket!.receive(makeSnapshot({
      phase: 'settled',
      result: { winnerIndex: 2, winner: '本家', roundLabel: '东1局', honba: 0, horses: [], hits: 0, multiplier: 1, totalMultiplier: 1, points: 100, totalWon: 300, details: [], scoreChanges: [] },
      winPresentation: { winnerIndex: 2, tile: 'm1', sourceIndex: 3, robbedKong: false, robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1 },
      winningPlayerIndex: 2,
    }))
    expect(game.phase.value).toBe('win-effect')
    // zimo 只播一次（由 startWinSequence 播出）
    expect(sounds.filter((name) => name === 'zimo.mp3')).toHaveLength(1)
  })

  it('非首局 round_start 也展示「xx场·xx局」对局开始提示（对齐本地每局显示），再投骰子', async () => {
    const game = await connectGame()

    mockSocket!.receive({ kind: 'round_start', matchStarted: false, round: 2, dealer: 1, honba: 0, dice: [2, 6] })

    // 每局都先进入对局开始覆盖层（xx场·xx局），不再只首局显示（骰子复位，不提前展示）
    expect(game.openingStage.value).toBe('start')
    expect(game.round.value).toBe(2)
    expect(game.dealer.value).toBe(3)   // 服务端座位 1 → 本家(seat 2) 相对 3
    expect(game.diceValues.value).toEqual([1, 1])

    await vi.advanceTimersByTimeAsync(1250)
    expect(game.openingStage.value).toBe('dice')
    expect(game.diceValues.value).toEqual([2, 6])
    await vi.advanceTimersByTimeAsync(1150 + 650)
    expect(game.openingStage.value).toBeNull()
  })

  it('结算展示期间到达的 round_start 被缓冲，点继续后发送 continue 并进入下一局开局', async () => {
    const game = await connectGame()
    mockSocket!.receive(makeSnapshot({
      phase: 'settled',
      result: { winnerIndex: 2, winner: '本家', roundLabel: '东1局', honba: 0, horses: [], hits: 0, multiplier: 1, totalMultiplier: 1, points: 100, totalWon: 300, details: [], scoreChanges: [] },
      winPresentation: { winnerIndex: 2, tile: 'm1', sourceIndex: -1, robbedKong: false, robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1 },
      winningPlayerIndex: 2,
    }))
    expect(game.phase.value).toBe('win-effect')

    // 结算展示期间服务端兜底已推进 → round_start 到达 → 缓冲（不打断动画/结算窗）
    mockSocket!.receive({ kind: 'round_start', matchStarted: false, round: 2, dealer: 1, honba: 0, dice: [4, 2] })
    expect(game.openingStage.value).toBeNull()
    expect(game.phase.value).toBe('win-effect')

    await vi.advanceTimersByTimeAsync(4100)
    expect(game.phase.value).toBe('settled')

    game.nextRound()
    // 确认屏障：发送 continue；缓冲的 round_start 落地 → 下一局对局开始提示（骰子复位）
    expect(mockSocket!.sent).toContain(JSON.stringify({ type: 'continue' }))
    expect(game.round.value).toBe(2)
    expect(game.openingStage.value).toBe('start')
    expect(game.diceValues.value).toEqual([1, 1])
    expect(game.waitingNextRound.value).toBe(false)
  })
})

describe('useRemoteGame 出牌报牌（dapai + 牌名语音）', () => {
  it('新弃牌播报牌音效，同 id 冗余快照不重复播', async () => {
    const sounds: string[] = []
    const game = await connectGame({ playSound: (name: string) => { sounds.push(name) } })

    // 首张弃牌（m5）→ 立即 dapai + 80ms 后牌名 5m.mp3
    mockSocket!.receive(makeSnapshot({ phase: 'drawing', currentPlayer: 3, lastDiscard: { tile: 'm5', from: 0, id: 1 } }))
    expect(sounds).toContain('dapai.mp3')
    await vi.advanceTimersByTimeAsync(80)
    expect(sounds).toContain('5m.mp3')

    // 同 id 冗余快照（重连/重复广播）→ 不重复播
    sounds.length = 0
    mockSocket!.receive(makeSnapshot({ phase: 'drawing', currentPlayer: 3, lastDiscard: { tile: 'm5', from: 0, id: 1 } }))
    expect(sounds).not.toContain('dapai.mp3')

    // 新弃牌（s9）→ 再次播报
    mockSocket!.receive(makeSnapshot({ phase: 'drawing', currentPlayer: 3, lastDiscard: { tile: 's9', from: 1, id: 2 } }))
    expect(sounds).toContain('dapai.mp3')
    await vi.advanceTimersByTimeAsync(80)
    expect(sounds).toContain('9s.mp3')
  })
})

// ─── 房间会话：关闭房间 / 房主转移 / room_closed ─────────────

describe('useRemoteGame 房间会话（Phase 8）', () => {
  it('房主轮询同步 creatorSeat：房主转移后 isCreator 跟随服务端权威座位', async () => {
    const game = await connectGame()   // mySeat = 2
    // 初始轮询：creatorSeat = 2（本家创建者）→ isCreator 保持 true
    await game.remoteActions.refreshRoom()
    expect(game.isCreator.value).toBe(true)

    // 创建者离房 → 房主转移给 seat 3：轮询后 isCreator 变 false
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(json({
      roomId: 'ABC123', mode: 'east', capacity: 4, status: 'lobby', creatorSeat: 3,
      seats: [null, null, { seat: 2, nickname: '测试', ready: true, connected: true }, { seat: 3, nickname: '新主', ready: true, connected: true }],
    }))
    await game.remoteActions.refreshRoom()
    expect(game.creatorSeat.value).toBe(3)
    expect(game.isCreator.value).toBe(false)

    // 房主回到本家 → isCreator 恢复
    fetchMock.mockResolvedValueOnce(json({
      roomId: 'ABC123', mode: 'east', capacity: 4, status: 'lobby', creatorSeat: 2,
      seats: [null, null, { seat: 2, nickname: '测试', ready: true, connected: true }],
    }))
    await game.remoteActions.refreshRoom()
    expect(game.isCreator.value).toBe(true)
  })

  it('创建房间遇服务端房间数已满（第 5 个）→ 提示「房间已满」', async () => {
    const game = useRemoteGame()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(errorJson('ROOM_LIMIT_REACHED'))
    await expect(game.remoteActions.createRoom('east', 4)).rejects.toThrow()
    expect(game.sessionError.value).toBe('房间已满')
    expect(game.sessionStatus.value).toBe('idle')
    expect(game.roomId.value).toBe('')
  })

  it('关闭房间：DELETE 房间后清理本地会话回大厅', async () => {
    const game = await connectGame()
    await game.remoteActions.closeRoom()
    expect(game.sessionStatus.value).toBe('idle')
    expect(game.roomId.value).toBe('')
    expect(game.wsStatus.value).toBe('idle')
  })

  it('收到 room_closed：房间被创建者解散 → 本地会话清理回大厅', async () => {
    const game = await connectGame()
    mockSocket!.receive({ kind: 'room_closed' })
    // leaveRemoteRoom 内部 await leave 请求：flush 微任务后完成 reset
    await vi.advanceTimersByTimeAsync(0)
    expect(game.roomId.value).toBe('')
    expect(game.sessionStatus.value).toBe('idle')
    expect(game.players.length).toBe(0)
  })

  it('对局结束返回大厅：保留座位与连接回房间面板，不释放座位', async () => {
    const game = await connectGame()
    mockSocket!.receive({ kind: 'match_finished', roomId: 'ABC123', mode: 'east', finalScores: [] })
    expect(game.phase.value).toBe('finished')
    expect(game.matchFinished.value).toBe(true)

    game.returnToLobby()

    // 回房间面板：清除对局展示，但会话/座位/连接全部保留
    expect(game.phase.value).toBe('lobby')
    expect(game.matchFinished.value).toBe(false)
    expect(game.players.length).toBe(0)
    expect(game.roomId.value).toBe('ABC123')
    expect(game.mySeat.value).toBe(2)
    expect(game.rejoinCode.value).toBe('AAAA-BBBB')
    expect(game.wsStatus.value).toBe('connected')
    // 未发 leave（REST），座位未释放
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const leaveCalls = fetchMock.mock.calls.filter(([input]: [unknown]) =>
      String(input).includes('/api/rooms/ABC123/leave'))
    expect(leaveCalls.length).toBe(0)
  })

  it('对局进行中不轮询房间：phase ≠ lobby 时 refreshRoom 跳过请求', async () => {
    const game = await connectGame()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const roomGets = () => fetchMock.mock.calls.filter(
      ([input, init]: [unknown, RequestInit | undefined]) =>
        String(input).includes('/api/rooms/ABC123') && !init?.method,   // 无 method = GET（getRoom）
    ).length

    const before = roomGets()
    // 进入对局：快照把 phase 推出 lobby → refreshRoom 不再发 GET
    mockSocket!.receive(makeSnapshot())   // phase 'drawing' → 客户端 'playing'
    expect(game.phase.value).not.toBe('lobby')
    await game.remoteActions.refreshRoom()
    expect(roomGets()).toBe(before)   // 未新增轮询请求
  })
})

// ─── P1：匿名身份 + 会话持久化 + 继续对局 ────────────────

describe('useRemoteGame 匿名身份与会话持久化（Phase 8 P1）', () => {
  it('join 携带 playerId（匿名身份）', async () => {
    await connectGame()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const joinCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/api/rooms/ABC123/join'))
    expect(joinCall).toBeTruthy()
    const body = JSON.parse((joinCall![1] as RequestInit).body as string)
    expect(body.playerId).toBeTruthy()
    expect(String(body.playerId)).toMatch(/^g/)
  })

  it('guestId 跨会话稳定（localStorage 持久）', async () => {
    const game = await connectGame()
    const first = game.playerId.value
    expect(first).toBeTruthy()
    const game2 = useRemoteGame()
    expect(game2.playerId.value).toBe(first)   // 新实例复用同一匿名身份
  })

  it('进房持久化会话，离开后清除', async () => {
    const game = await connectGame()
    expect(game.storedSession.value).not.toBeNull()
    expect(game.storedSession.value?.roomId).toBe('ABC123')
    expect(window.localStorage.getItem('lgm_session')).toContain('ABC123')
    await game.remoteActions.leaveRoom()
    expect(game.storedSession.value).toBeNull()
    expect(window.localStorage.getItem('lgm_session')).toBeNull()
  })

  it('resumeSession 凭存储会话回原座位（刷新/关浏览器后可继续对局）', async () => {
    window.localStorage.setItem('lgm_session', JSON.stringify({
      roomId: 'OLD123', rejoinCode: 'CODE-1111', nickname: '老玩家', playerId: 'guest-old', mode: 'east',
    }))
    const game = useRemoteGame()
    expect(game.storedSession.value?.roomId).toBe('OLD123')   // 初始化即读到上次会话
    await game.remoteActions.resumeSession()
    expect(game.roomId.value).toBe('OLD123')
    expect(game.rejoinCode.value).toBe('CODE-1111')
    expect(game.nickname.value).toBe('老玩家')
    expect(mockSocket).not.toBeNull()                          // 已建立 WS 连接
    expect(mockSocket!.url).toContain('rejoin_code=CODE-1111')
  })

  it('rejoin_err 清除持久化会话（房间没了 / 码失效 / 被封禁）', async () => {
    const game = await connectGame()
    expect(game.storedSession.value).not.toBeNull()
    mockSocket!.receive({ kind: 'rejoin_err', code: 'INVALID_REJOIN_CODE' })
    expect(game.storedSession.value).toBeNull()
    expect(window.localStorage.getItem('lgm_session')).toBeNull()
    // 会话作废后必须停掉 WS 重连循环并回大厅（否则对失效房间无限重连，一直「正在重连」）
    expect(game.roomId.value).toBe('')
    expect(game.rejoinCode.value).toBe('')
    expect(game.wsStatus.value).toBe('idle')
    expect(game.sessionStatus.value).toBe('idle')
    expect(game.phase.value).toBe('lobby')
    // 不再发起重连：定时器已清空，推进时间不会触发新的 connect
    await vi.advanceTimersByTimeAsync(20000)
    expect(game.wsStatus.value).toBe('idle')
  })

  it('ping/pong 测 RTT 更新信号质量；断开后归零', async () => {
    const game = await connectGame()
    // 推进 5s 触发 ping（记录发送时刻），服务端回 pong → RTT≈0 → 信号 3（最佳）
    await vi.advanceTimersByTimeAsync(5000)
    const ping = mockSocket!.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'ping')
    expect(ping).toBeTruthy()
    expect(typeof ping?.t).toBe('number')
    mockSocket!.receive({ kind: 'pong' })
    expect(game.signalQuality.value).toBe(3)
    // 断开 → 信号归零
    mockSocket!.close()
    expect(game.signalQuality.value).toBe(0)
  })
})
