import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBloodFlowRemoteGame } from './useBloodFlowRemoteGame'

const api = vi.hoisted(() => ({
  createRoom: vi.fn(), joinRoom: vi.fn(), getRoom: vi.fn(), readyRoom: vi.fn(),
  startRoom: vi.fn(), leaveRoom: vi.fn(), closeRoom: vi.fn(), updateCharacter: vi.fn(),
}))
const capture = vi.hoisted(() => ({
  onMessage: null as null | ((message: unknown) => void),
  open: vi.fn(), close: vi.fn(),
  sent: [] as Record<string, unknown>[],
}))
vi.mock('../../../online/api/roomApi', () => api)
vi.mock('../../../online/transport/roomSocket', () => ({
  createRoomSocketTransport: (options: { onMessage: (message: unknown) => void }) => {
    capture.onMessage = options.onMessage
    return {
      status: { value: 'idle' },
      signalQuality: { value: 0 },
      send: (message: Record<string, unknown>) => { capture.sent.push(message); return true },
      open: () => { capture.open() },
      close: () => { capture.close() },
      confirmSession: vi.fn(),
    }
  },
}))

const VIEW = {
  authorityEpoch: 'bf-ROOM', roundId: 'round-0', version: 3, seat: 0 as const,
  players: [
    { name: '玩家1', avatar: '', score: 2000, seat: 0, hand: ['m1', 'm2'], concealedTileCount: 14,
      discards: [], melds: [], redCount: 0, drawnTileIndex: 13 },
    { name: '玩家2', avatar: '', score: 2000, seat: 1, hand: [], concealedTileCount: 13,
      discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
    { name: '玩家3', avatar: '', score: 2000, seat: 2, hand: [], concealedTileCount: 13,
      discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
    { name: '玩家4', avatar: '', score: 2000, seat: 3, hand: [], concealedTileCount: 13,
      discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
  ],
  currentPlayer: 0, wallCount: 80, headDrawn: 53, flipTile: 'p9', jokers: ['red', 'green'],
  flipStack: 0, flipSeat: 0, wallBreakIndex: 2,
  window: { id: 'round-0/window/3', version: 3, kind: 'turn', deadlineAt: 999, opensAt: 0,
    source: { id: 's', kind: 'draw', tile: 'm2', seat: 0 } },
  ownActions: [{ kind: 'discard', index: 13 }, { kind: 'discard', index: 0 }],
  ownScore: null, waitingSeats: [0],
  public: { ruleVersion: 'lotus-blood-flow-v1', roundId: 'round-0', status: 'playing',
    seats: [{ winCount: 0, locked: false, firstWinSequence: null, recordIds: [] },
      { winCount: 0, locked: false, firstWinSequence: null, recordIds: [] },
      { winCount: 0, locked: false, firstWinSequence: null, recordIds: [] },
      { winCount: 0, locked: false, firstWinSequence: null, recordIds: [] }],
    batches: [], roundResult: null },
  actionEvents: [], lastDiscardAction: null, kongEvents: [],
}

const fixedTtsStub = {
  speak: () => false,
  cancel: () => {},
  reset: () => {},
  announce: () => {},
}

/** 房间面板数据（refreshRoom 用）：默认 lobby，测试按需覆盖 status。 */
const ROOM_INFO_LOBBY = {
  roomId: 'R1', status: 'lobby', creatorSeat: 0, capacity: 4, mode: 'east',
  timeLimitSeconds: 3600, llmEnabled: false, effectiveLlmEnabled: false, llmAvailable: false,
  seats: [{ seat: 0, nickname: '甲', ready: true, connected: false }, null, null, null],
}

function makeModule() {
  return useBloodFlowRemoteGame({
    playSound: () => {},
    playSoundAndWait: async () => {},
    getThemeName: () => 'jade',
    animeFixedTts: fixedTtsStub as never,
  })
}

describe('useBloodFlowRemoteGame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capture.onMessage = null
    capture.sent.length = 0
    // 远端视图会建评估 Worker；node 环境用空壳替代。
    vi.stubGlobal('Worker', class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
    })
  })

  it('starts in an idle lobby with no seat', () => {
    const module = makeModule()
    expect(module.sessionStatus.value).toBe('idle')
    expect(module.mySeat.value).toBe(-1)
    expect(module.roomId.value).toBe('')
    expect(module.rulesetId.value).toBe('lotus-blood-flow')
  })

  it('creates a blood-flow room over REST and joins it', async () => {
    api.createRoom.mockResolvedValue({ roomId: 'R1', mode: 'east', rulesetId: 'lotus-blood-flow' })
    api.joinRoom.mockResolvedValue({ roomId: 'R1', seat: 0, nickname: '甲', rejoinCode: 'C1', playerId: 'p1', rejoin: false })
    api.getRoom.mockResolvedValue({
      roomId: 'R1', status: 'lobby', creatorSeat: 0, capacity: 4, mode: 'east',
      seats: [{ seat: 0, nickname: '甲', ready: false, connected: false }, null, null, null],
    })
    const module = makeModule()
    await module.remoteActions.createRoom('east', 4)
    expect(api.createRoom).toHaveBeenCalledWith('east', 4, expect.any(String), 'lotus-blood-flow', undefined)
    expect(module.roomId.value).toBe('R1')
    expect(module.mySeat.value).toBe(0)
    expect(module.isCreator.value).toBe(true)
    expect(module.sessionStatus.value).toBe('lobby')
  })

  it('starts the match over REST and opens the socket', async () => {
    api.startRoom.mockResolvedValue({ roomId: 'R1', status: 'playing' })
    const module = makeModule()
    module.roomId.value = 'R1'
    module.mySeat.value = 0
    await module.remoteActions.startMatch([])
    expect(api.startRoom).toHaveBeenCalledWith('R1', [])
    expect(capture.open).toHaveBeenCalled()
  })

  it('routes rejoin_ok and bf_snapshot into the authority port', async () => {
    const module = makeModule()
    expect(capture.onMessage).not.toBeNull()
    capture.onMessage!({ kind: 'rejoin_ok', seat: 1, rejoin: true, roomId: 'R1', mode: 'east',
      rulesetId: 'lotus-blood-flow', nickname: '乙', rejoinCode: 'C2' })
    expect(module.mySeat.value).toBe(1)
    expect(module.nickname.value).toBe('乙')
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0,
      opening: { firstDice: [3, 5], secondDice: [1, 6] } })
    await vi.waitFor(() => {
      expect(module.phase.value).toBe('dealing')
    })
    // 快照未带头像时在映射阶段补座位默认头像：避免 <img> 报错回退造成每次快照头像闪烁。
    expect(module.players[1].avatar).toMatch(/avatars\/ah-lok\.svg$/)
    expect(module.players[2].avatar).toMatch(/avatars\/shisan\.svg$/)
  })

  it('confirms the next round over WS and clears waiting on the new round', () => {
    const module = makeModule()
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
    module.nextRound()
    expect(capture.sent).toContainEqual({ kind: 'continue', round: 0 })
    expect(module.waitingNextRound.value).toBe(true)
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 1, mode: 'east', dealer: 1 })
    expect(module.waitingNextRound.value).toBe(false)
  })

  it('对局中途「返回大厅」= 暂离：不退出房间、保留座位与重进码，只断开连接', async () => {
    api.leaveRoom.mockResolvedValue({})
    api.joinRoom.mockResolvedValue({ roomId: 'R1', seat: 0, nickname: '甲', rejoinCode: 'C1', playerId: 'p1', rejoin: false })
    api.getRoom.mockResolvedValue({ ...ROOM_INFO_LOBBY, status: 'playing' })
    const module = makeModule()
    await module.remoteActions.joinRoom('R1')
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => {
      expect(module.players).toHaveLength(4)
      expect(module.phase.value).toBe('discard')
    })

    module.returnToLobby()
    await vi.waitFor(() => {
      expect(module.phase.value).toBe('lobby')
      expect(module.players).toHaveLength(0)
    })
    // 关键：不调 REST leave（座位保留、本场交服务端 AI 代打），房间与会话都还在。
    expect(api.leaveRoom).not.toHaveBeenCalled()
    expect(module.roomId.value).toBe('R1')
    expect(module.mySeat.value).toBe(0)
    expect(module.sessionStatus.value).toBe('lobby')
    expect(module.storedSession.value?.rejoinCode).toBe('C1')
    expect(module.roomStatus.value).toBe('playing')   // 面板据此显示「本场进行中 · 回到牌桌」
    expect(capture.close).toHaveBeenCalled()
  })

  it('「退出本场」保留座位与会话：回主大厅但可「继续对局」重进原座位', async () => {
    api.leaveRoom.mockResolvedValue({})
    api.joinRoom.mockResolvedValue({ roomId: 'R1', seat: 0, nickname: '甲', rejoinCode: 'C1', playerId: 'p1', rejoin: false })
    api.getRoom.mockResolvedValue({ ...ROOM_INFO_LOBBY, status: 'playing' })
    const module = makeModule()
    await module.remoteActions.joinRoom('R1')
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => expect(module.players).toHaveLength(4))

    await module.remoteActions.leaveMatch()
    expect(api.leaveRoom).not.toHaveBeenCalled()      // 不释放座位
    expect(module.roomId.value).toBe('')              // 本机回主大厅
    expect(module.mySeat.value).toBe(-1)
    expect(module.sessionStatus.value).toBe('idle')
    // 会话仍在 → 大厅显示「继续对局（房间 R1）」，重进即恢复原座位。
    expect(module.storedSession.value?.roomId).toBe('R1')
    expect(module.storedSession.value?.rejoinCode).toBe('C1')
  })

  it('服务端房间状态随房间信息刷新（暂离时面板据此显示「回到牌桌」）', async () => {
    api.joinRoom.mockResolvedValue({ roomId: 'R1', seat: 0, nickname: '甲', rejoinCode: 'C1', playerId: 'p1', rejoin: false })
    api.getRoom.mockResolvedValue({ ...ROOM_INFO_LOBBY, status: 'playing' })
    const module = makeModule()
    await module.remoteActions.joinRoom('R1')
    expect(module.roomStatus.value).toBe('playing')
  })

  it('托管开关把状态发给服务端（WS 由服务端代打）', () => {
    const module = makeModule()
    module.toggleAutoPlay()
    expect(module.autoPlay.value).toBe(true)
    expect(capture.sent).toContainEqual({ kind: 'auto', enabled: true })
    module.toggleAutoPlay()
    expect(capture.sent).toContainEqual({ kind: 'auto', enabled: false })
  })

  it('重连握手后把本地托管状态同步给服务端（刷新后本地 ref 归零）', () => {
    const module = makeModule()
    capture.sent.length = 0
    capture.onMessage!({ kind: 'rejoin_ok', seat: 0, rejoin: true, roomId: 'R1', mode: 'east',
      rulesetId: 'lotus-blood-flow', nickname: '甲', rejoinCode: 'C1' })
    expect(capture.sent).toContainEqual({ kind: 'auto', enabled: false })
  })

  it('联机座位身份按快照落地；客户端不再自拼 LLM 模板台词（改由服务端原话）', async () => {
    const module = useBloodFlowRemoteGame({
      playSound: () => {},
      playSoundAndWait: async () => {},
      getThemeName: () => 'llm',
      animeFixedTts: fixedTtsStub as never,
    })
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => expect(module.players).toHaveLength(4))

    const next = {
      ...VIEW,
      version: 4,
      players: VIEW.players.map((player, index) => (
        index === 1
          // 服务端下发的 LLM 座位身份：昵称/头像/二次元角色/音色（本机单机 LLM 设置无关）。
          ? { ...player, playerKind: 'llm', isLlm: true, name: '千问（高冷）',
            avatar: 'img/llm/qwen/llm-avatar-gaoleng.png', characterId: 'qwen',
            style: '高冷', voiceKey: 'qwen' }
          : player
      )),
      actionEvents: [{ id: 7, type: 'peng', actorIndex: 1, sourceIndex: 0, tile: 'm5', meldIndex: 0 }],
      lastDiscardAction: { id: 'd1', seat: 0, tile: 'm5', kind: 'discard' },
    }
    capture.onMessage!({ kind: 'bf_snapshot', view: next, round: 0, mode: 'east', dealer: 0 })

    await vi.waitFor(() => {
      // 座位身份按快照落地：头像/角色不再回退座位默认值。
      expect(module.players[1].name).toBe('千问（高冷）')
      expect(module.players[1].avatar).toBe('img/llm/qwen/llm-avatar-gaoleng.png')
      expect(module.players[1].characterId).toBe('qwen')
    })
    // 快照本身不再触发客户端模板台词：LLM 台词一律来自服务端 llm_message。
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(module.capabilities.value.bloodFlow?.actionBubbles[1]).toBeUndefined()
  })

  it('整场结束「返回大厅」回房间大厅：不离开房间，房间保留可再开一场', async () => {
    api.joinRoom.mockResolvedValue({ roomId: 'R1', seat: 0, nickname: '甲', rejoinCode: 'C1', playerId: 'p1', rejoin: false })
    api.getRoom.mockResolvedValue({
      roomId: 'R1', status: 'finished', creatorSeat: 0, capacity: 4, mode: 'east',
      timeLimitSeconds: 600, llmEnabled: false, effectiveLlmEnabled: false, llmAvailable: false,
      seats: [{ seat: 0, nickname: '甲', ready: false, connected: true }, null, null, null],
    })
    const module = makeModule()
    await module.remoteActions.joinRoom('R1')
    expect(module.roomId.value).toBe('R1')
    const result = { ruleVersion: 'lotus-blood-flow-v1', roundId: 'round-3', reason: 'wall-exhausted',
      openingScores: [2000, 2000, 2000, 2000], endingScores: [2400, 1800, 1900, 1900],
      winNet: [2400, -200, -100, -100], kongNet: [0, 0, 0, 0], winCounts: [2, 0, 1, 0],
      ranks: [1, 4, 2, 3], ledger: [] }
    capture.onMessage!({ kind: 'bf_snapshot', matchFinished: true, round: 4, mode: 'east', dealer: 3,
      view: { ...VIEW, public: { ...VIEW.public, status: 'settled', roundResult: result } } })
    await vi.waitFor(() => expect(module.matchFinished.value).toBe(true))

    module.returnToLobby()
    await vi.waitFor(() => expect(module.phase.value).toBe('lobby'))
    // 关键：不走 REST leave（房主在非对局中离开会触发「房主离开即解散」规则），WS 保持在线等再开一场。
    expect(api.leaveRoom).not.toHaveBeenCalled()
    expect(capture.close).not.toHaveBeenCalled()
    expect(module.roomId.value).toBe('R1')
    expect(module.sessionStatus.value).toBe('lobby')
    expect(module.players).toHaveLength(0)
  })

  it('room_closed → 清理本地会话回主大厅（不再 REST leave、不再重连死房间）', async () => {
    const module = makeModule()
    capture.onMessage!({ kind: 'rejoin_ok', seat: 0, rejoin: true, roomId: 'R1', mode: 'east',
      rulesetId: 'lotus-blood-flow', nickname: '甲', rejoinCode: 'C1' })
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 1, mode: 'east', dealer: 0 })
    await vi.waitFor(() => expect(module.players).toHaveLength(4))
    capture.onMessage!({ kind: 'room_closed' })
    await vi.waitFor(() => expect(module.sessionStatus.value).toBe('idle'))
    expect(module.roomId.value).toBe('')
    expect(module.mySeat.value).toBe(-1)
    expect(module.players).toHaveLength(0)
    expect(api.leaveRoom).not.toHaveBeenCalled()
    expect(capture.close).toHaveBeenCalled()
  })

  it('建房期间 sessionStatus=creating（大厅按钮显示「创建中…」并禁用），连点只发一次', async () => {
    let finishCreate: (value: unknown) => void = () => {}
    api.createRoom.mockReturnValue(new Promise((resolve) => { finishCreate = resolve }))
    api.joinRoom.mockResolvedValue({ roomId: 'R1', seat: 0, nickname: '甲', rejoinCode: 'C1', playerId: 'p1', rejoin: false })
    api.getRoom.mockResolvedValue({
      roomId: 'R1', status: 'lobby', creatorSeat: 0, capacity: 4, mode: 'east',
      seats: [{ seat: 0, nickname: '甲', ready: false, connected: false }, null, null, null],
    })
    const module = makeModule()
    const first = module.remoteActions.createRoom('east', 4)
    expect(module.sessionStatus.value).toBe('creating')
    // 连点/重复提交：第二次直接忽略，不会重复建房（按钮本身也已按 creating 禁用）
    await module.remoteActions.createRoom('east', 4)
    expect(api.createRoom).toHaveBeenCalledTimes(1)
    finishCreate({ roomId: 'R1', mode: 'east', rulesetId: 'lotus-blood-flow' })
    await first
    expect(module.sessionStatus.value).toBe('lobby')
  })

  it('建房失败回 idle 并给出可读原因（不会卡在「创建中…」）', async () => {
    api.createRoom.mockRejectedValue(new Error('ROOM_LIMIT_REACHED'))
    const module = makeModule()
    await expect(module.remoteActions.createRoom('east', 4)).rejects.toThrow('ROOM_LIMIT_REACHED')
    expect(module.sessionStatus.value).toBe('idle')
    expect(module.sessionError.value).toBe('房间已满')
  })

  it('动作竞态（STALE_ACTION / INVALID_ACTION）不写成会话错误', () => {
    const module = makeModule()
    capture.onMessage!({ kind: 'error', code: 'STALE_ACTION' })
    capture.onMessage!({ kind: 'error', code: 'INVALID_ACTION' })
    expect(module.sessionError.value).toBe('')
    capture.onMessage!({ kind: 'error', code: 'INTERNAL_ERROR' })
    expect(module.sessionError.value).toBe('INTERNAL_ERROR')
  })

  it('同一窗口只提交一次动作：连点不再产生 STALE_ACTION，按钮随之收起', async () => {
    const module = makeModule()
    const view = { ...VIEW, ownActions: [{ kind: 'win' }, { kind: 'discard', index: 13 }] }
    capture.onMessage!({ kind: 'bf_snapshot', view, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => expect(module.phase.value).toBe('discard'))
    expect(module.userCanHu.value).toBe(true)

    const actionFrames = () => capture.sent.filter((message) => message.kind === 'action')
    module.userHu()
    expect(actionFrames()).toHaveLength(1)
    // 本窗口已提交：能力收起（按钮不再可点），重复点击被闩锁挡住
    expect(module.userCanHu.value).toBe(false)
    module.userHu()
    module.userDiscard(13)
    expect(actionFrames()).toHaveLength(1)

    // 权威推进到新窗口 → 闩锁解除，重新可操作
    const next = { ...view, version: 4, window: { ...VIEW.window, id: 'round-0/window/4', version: 4 } }
    capture.onMessage!({ kind: 'bf_snapshot', view: next, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => expect(module.view.value?.window?.id).toBe('round-0/window/4'))
    module.userHu()
    expect(actionFrames()).toHaveLength(2)
  })

  it('建房/入房把本家二次元角色随 join 上报（否则服务端永远回退默认角色）', async () => {
    api.createRoom.mockResolvedValue({ roomId: 'R1', mode: 'east', rulesetId: 'lotus-blood-flow' })
    api.joinRoom.mockResolvedValue({ roomId: 'R1', seat: 0, nickname: '甲', rejoinCode: 'C1', playerId: 'p1', rejoin: false })
    api.getRoom.mockResolvedValue({
      roomId: 'R1', status: 'lobby', creatorSeat: 0, capacity: 4, mode: 'east',
      seats: [{ seat: 0, nickname: '甲', ready: false, connected: false }, null, null, null],
    })
    const module = useBloodFlowRemoteGame({
      playSound: () => {}, playSoundAndWait: async () => {},
      getCharacterId: () => 'qwen',
      getThemeName: () => 'llmAnime', animeFixedTts: fixedTtsStub as never,
    })
    await module.remoteActions.createRoom('east', 4)
    expect(api.joinRoom).toHaveBeenCalledWith('R1', expect.any(String), expect.any(String), 'qwen')

    api.joinRoom.mockClear()
    const joiner = useBloodFlowRemoteGame({
      playSound: () => {}, playSoundAndWait: async () => {},
      getCharacterId: () => 'kimi',
      getThemeName: () => 'llmAnime', animeFixedTts: fixedTtsStub as never,
    })
    await joiner.remoteActions.joinRoom('R9')
    expect(api.joinRoom).toHaveBeenCalledWith('R9', expect.any(String), expect.any(String), 'kimi')
  })

  it('局末感言闸门：结算期间 roundSpeechBusy 会自行释放（不会把面板/倒计时永久卡住）', async () => {
    const module = useBloodFlowRemoteGame({
      playSound: () => {}, playSoundAndWait: async () => {},
      getThemeName: () => 'llm', animeFixedTts: fixedTtsStub as never,
    })
    const result = { ruleVersion: 'lotus-blood-flow-v1', roundId: 'round-0', reason: 'wall-exhausted',
      openingScores: [2000, 2000, 2000, 2000], endingScores: [2400, 1800, 1900, 1900],
      winNet: [2400, -200, -100, -100], kongNet: [0, 0, 0, 0], winCounts: [2, 0, 1, 0],
      ranks: [1, 4, 2, 3], ledger: [] }
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => expect(module.players).toHaveLength(4))
    capture.onMessage!({ kind: 'bf_snapshot', round: 0, mode: 'east', dealer: 0,
      view: { ...VIEW, public: { ...VIEW.public, status: 'settled', roundResult: result } } })
    await vi.waitFor(() => {
      expect(module.capabilities.value.bloodFlow?.roundResult).toBeTruthy()
      expect(module.capabilities.value.bloodFlow?.roundSpeechBusy).toBe(false)
    })
  })

  it('服务端模型原话：llm_message 落气泡、llm_audio 走 llm 音频队列', async () => {
    const playLlmAudio = vi.fn()
    const module = useBloodFlowRemoteGame({
      playSound: () => {},
      playSoundAndWait: async () => {},
      playLlmAudio,
      getThemeName: () => 'llm',
      animeFixedTts: fixedTtsStub as never,
    })
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => expect(module.players).toHaveLength(4))

    capture.onMessage!({ kind: 'llm_message', id: 7, seat: 2, text: '这张先走。', priority: 'normal',
      purpose: 'commentary', speechSource: 'model-message' })
    await vi.waitFor(() => {
      // 权威座位 2 → 本机座位 2（VIEW.seat = 0）：气泡文本来自服务端原话。
      expect(module.capabilities.value.bloodFlow?.actionBubbles[2]?.text).toBe('这张先走。')
    })
    // 同一 id 重复下发不重复出泡。
    capture.onMessage!({ kind: 'llm_message', id: 7, seat: 2, text: '这张先走。', priority: 'normal',
      purpose: 'commentary', speechSource: 'model-message' })

    capture.onMessage!({ kind: 'llm_audio', messageId: 7, seat: 2,
      audioUrl: '/api/local-tts/audio/a.mp3', priority: 'normal', purpose: 'commentary',
      speechSource: 'model-message' })
    expect(playLlmAudio).toHaveBeenCalledTimes(1)
    expect(playLlmAudio).toHaveBeenCalledWith(expect.stringContaining('/api/local-tts/audio/a.mp3'),
      2, 7, 'normal')
  })

  it('llmAnime 主题抑制服务端模型动作语音（角色固定台词接管）', async () => {
    const playLlmAudio = vi.fn()
    const module = useBloodFlowRemoteGame({
      playSound: () => {},
      playSoundAndWait: async () => {},
      playLlmAudio,
      getThemeName: () => 'llmAnime',
      animeFixedTts: fixedTtsStub as never,
    })
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => expect(module.players).toHaveLength(4))

    capture.onMessage!({ kind: 'llm_message', id: 9, seat: 2, text: '这张先走。', priority: 'normal',
      purpose: 'action', speechSource: 'model-message', actionKind: 'peng' })
    capture.onMessage!({ kind: 'llm_audio', messageId: 9, seat: 2,
      audioUrl: '/api/local-tts/audio/b.mp3', priority: 'normal', purpose: 'action',
      speechSource: 'model-message' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(module.capabilities.value.bloodFlow?.actionBubbles[2]).toBeUndefined()
    expect(playLlmAudio).not.toHaveBeenCalled()
    // commentary（弃牌吐槽）不受抑制：仍走服务端原话。
    capture.onMessage!({ kind: 'llm_message', id: 10, seat: 2, text: '随便打一张。', priority: 'normal',
      purpose: 'commentary', speechSource: 'model-message' })
    await vi.waitFor(() => {
      expect(module.capabilities.value.bloodFlow?.actionBubbles[2]?.text).toBe('随便打一张。')
    })
  })
})
