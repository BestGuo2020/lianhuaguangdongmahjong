import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteGame } from './useRemoteGame'
import type { GamePlayer, TileType } from './types'

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

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    // 与 API_BASE 解耦（可能被 .env 的 VITE_API_BASE 指到 Vite 代理源）
    const path = new URL(String(input)).pathname
    if (path === '/api/rooms' && init?.method === 'POST') {
      return json({ roomId: 'ABC123', mode: 'east', capacity: 4, status: 'lobby', seats: [null, null, null, null] })
    }
    if (path === '/api/rooms/ABC123/join' && init?.method === 'POST') {
      return json({ roomId: 'ABC123', seat: 2, nickname: '测试', rejoinCode: 'AAAA-BBBB', rejoin: false })
    }
    if (path === '/api/rooms/ABC123') {
      return json({ roomId: 'ABC123', mode: 'east', capacity: 4, status: 'lobby', seats: [null, null, null, null] })
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

function makePlayer(seat: number, name: string, hand: Array<TileType | null> = []): GamePlayer {
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
    expect(game.players[0].hand.every((t) => t != null)).toBe(true)
    expect(game.players[1].hand.every((t) => t == null)).toBe(true)
    expect(game.players[2].hand.every((t) => t == null)).toBe(true)
    // currentPlayer / dealer 服务端座位 → 本地索引
    expect(game.currentPlayer.value).toBe(0)   // 服务端 2 → 本家
    expect(game.dealer.value).toBe(2)          // 服务端 0 → 本地 2
    expect(game.round.value).toBe(1)
    expect(game.wallCount.value).toBe(80)
    expect(game.phase.value).toBe('playing')
    // 空昵称头像补默认（按服务端座位稳定分配）
    expect(game.players[2].avatar).toContain('lotus')
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
      ctx: { hand: [], canGang: true, tile: 'm5', from: 3 },
    })

    expect(game.phase.value).toBe('prompt')
    expect(game.actionPrompt.value?.type).toBe('claim')
    expect(game.actionPrompt.value?.canGang).toBe(true)
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

  it('结算展示期间到达的下一局快照被延迟，点继续后落地', async () => {
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

    game.nextRound()
    expect(game.phase.value).toBe('playing')
    expect(game.round.value).toBe(2)             // 延迟的快照已应用
    expect(game.lastDiscard.value?.from).toBe(2) // 服务端 0 → 本地 (0-2+4)%4=2
    expect(game.result.value).toBeNull()
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

  it('结算展示期间到达的公告消息不弹出，点继续后随下一局快照展示一次', async () => {
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

    // 点继续 → 快照落地，新公告展示一次
    game.nextRound()
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

    // 对局开始覆盖层 + 骰子值 + game_start 音效；开局期间为发牌态、空手
    expect(game.openingStage.value).toBe('start')
    expect(game.diceValues.value).toEqual([3, 5])
    expect(game.round.value).toBe(1)
    expect(game.phase.value).toBe('dealing')
    expect(sounds).toContain('game_start.mp3')

    // 开局动画期间到达的开局快照 → 缓冲：不填表、不报牌
    mockSocket!.receive(makeSnapshot({ phase: 'opening', currentPlayer: 3, lastDiscard: { tile: 'm5', from: 0, id: 1 } }))
    expect(game.players[0].hand.length).toBe(0)
    expect(sounds).not.toContain('dapai.mp3')

    // 1.25s 后进入骰子投掷阶段
    await vi.advanceTimersByTimeAsync(1250)
    expect(game.openingStage.value).toBe('dice')
    expect(sounds).toContain('dice.mp3')

    // 1.15s 后骰子结束 → 发牌动画（三家手牌从空逐步填充）
    await vi.advanceTimersByTimeAsync(1150)
    expect(game.openingStage.value).toBe('deal')
    expect(game.phase.value).toBe('dealing')

    // 发牌动画进行中：本家（座位 0）第一批发到 4 张，dealAnimation 有序列
    await vi.advanceTimersByTimeAsync(780)
    expect(game.players[0].hand.length).toBe(4)
    expect(game.dealAnimation.value.serial).toBeGreaterThan(0)

    // 发牌动画结束（3×4 家×4 张 + 4 家×1 张 ≈ 3720ms）→ 落地缓冲快照，进入牌局
    await vi.advanceTimersByTimeAsync(3720 - 780)
    expect(game.openingStage.value).toBeNull()
    expect(game.phase.value).toBe('playing')
    expect(game.players[0].hand.length).toBe(13)

    // 落地时补报开局期间错过的弃牌（id 1），随后新弃牌（id 2）继续报牌
    expect(sounds).toContain('dapai.mp3')
    mockSocket!.receive(makeSnapshot({ phase: 'drawing', currentPlayer: 3, lastDiscard: { tile: 'm5', from: 0, id: 2 } }))
    expect(sounds).toContain('dapai.mp3')
  })

  it('自摸：table_action(self-draw) 不产生 2D 文字也不播音效，由 settled 快照的 startWinSequence 统一输出（消除两段视觉）', async () => {
    const sounds: string[] = []
    const game = await connectGame({ playSound: (name: string) => { sounds.push(name) } })
    mockSocket!.receive(makeSnapshot())   // 进行中快照

    // 服务端自摸广播序列：table_action(self-draw) 先到，settled 快照随后
    mockSocket!.receive({
      kind: 'table_action',
      event: { id: 7, type: 'self-draw', actorIndex: 2, sourceIndex: 3, tile: 'm1', meldIndex: -1 },
    })
    // tableActionEvent 不应被设置（赢牌动作由 startWinSequence 统一负责）
    expect(game.tableActionEvent.value).toBeNull()
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

  it('非首局 round_start 跳过对局开始覆盖层，只投骰子', async () => {
    const game = await connectGame()

    mockSocket!.receive({ kind: 'round_start', matchStarted: false, round: 2, dealer: 1, honba: 0, dice: [2, 6] })

    expect(game.openingStage.value).toBe('dice')
    expect(game.round.value).toBe(2)
    expect(game.dealer.value).toBe(3)   // 服务端座位 1 → 本家(seat 2) 相对 3
    expect(game.diceValues.value).toEqual([2, 6])

    await vi.advanceTimersByTimeAsync(1150)
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
    // 确认屏障：发送 continue；缓冲的 round_start 落地 → 下一局骰子阶段
    expect(mockSocket!.sent).toContain(JSON.stringify({ type: 'continue' }))
    expect(game.round.value).toBe(2)
    expect(game.openingStage.value).toBe('dice')
    expect(game.diceValues.value).toEqual([4, 2])
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
