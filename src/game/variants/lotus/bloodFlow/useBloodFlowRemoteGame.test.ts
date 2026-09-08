import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBloodFlowRemoteGame } from './useBloodFlowRemoteGame'

const api = vi.hoisted(() => ({
  createRoom: vi.fn(), joinRoom: vi.fn(), getRoom: vi.fn(), readyRoom: vi.fn(),
  startRoom: vi.fn(), leaveRoom: vi.fn(), closeRoom: vi.fn(), updateCharacter: vi.fn(),
}))
const capture = vi.hoisted(() => ({
  onMessage: null as null | ((message: unknown) => void),
  open: vi.fn(), close: vi.fn(),
}))
vi.mock('../../../online/api/roomApi', () => api)
vi.mock('../../../online/transport/roomSocket', () => ({
  createRoomSocketTransport: (options: { onMessage: (message: unknown) => void }) => {
    capture.onMessage = options.onMessage
    return {
      status: { value: 'idle' },
      signalQuality: { value: 0 },
      send: vi.fn(() => true),
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
    vi.stubGlobal('Worker', class {
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
    })
    const module = makeModule()
    expect(capture.onMessage).not.toBeNull()
    capture.onMessage!({ kind: 'rejoin_ok', seat: 1, rejoin: true, roomId: 'R1', mode: 'east',
      rulesetId: 'lotus-blood-flow', nickname: '乙', rejoinCode: 'C2' })
    expect(module.mySeat.value).toBe(1)
    expect(module.nickname.value).toBe('乙')
    capture.onMessage!({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
    await vi.waitFor(() => {
      expect(module.phase.value).not.toBe('lobby')
    })
    vi.unstubAllGlobals()
  })
})
