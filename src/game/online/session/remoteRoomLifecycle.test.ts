import { reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteRoomLifecycle, type RemoteRoomApi, type RemoteRoomState } from './remoteRoomLifecycle'
import type { StoredSession } from './remoteSessionStore'

function createHarness(savedSession: StoredSession | null = null) {
  const state: RemoteRoomState = {
    sessionStatus: ref('idle'),
    sessionError: ref(''),
    roomId: ref(''),
    mySeat: ref(-1),
    nickname: ref('莲花'),
    rejoinCode: ref(''),
    playerId: ref(''),
    creatorSeat: ref(null),
    isCreator: ref(false),
    roomSeats: ref([]),
    roomTimeLimit: ref(null),
    llmEnabled: ref(false),
    effectiveLlmEnabled: ref(false),
    llmAvailable: ref(false),
    rulesetId: ref('lotus-classic'),
    storedSession: ref(savedSession),
    phase: ref('lobby'),
    matchType: ref('east'),
    matchFinished: ref(false),
    players: reactive([]),
  }
  const persisted: { session: StoredSession | null } = { session: savedSession }
  const sessionStore = {
    loadSession: vi.fn(() => persisted.session),
    saveSession: vi.fn((session: StoredSession) => { persisted.session = session }),
    clearSession: vi.fn(() => { persisted.session = null }),
    saveGuestId: vi.fn(),
    saveNickname: vi.fn(),
  }
  const api: RemoteRoomApi = {
    createRoom: vi.fn(async () => ({
      roomId: 'ABC123', mode: 'east' as const, capacity: 4, status: 'lobby' as const, creatorSeat: 0,
      timeLimitSeconds: 3600, rulesetId: 'lotus-classic' as const, seats: [null, null, null, null],
      llmEnabled: true, effectiveLlmEnabled: true, llmAvailable: true,
    })),
    getRoom: vi.fn(async () => ({
      roomId: 'ABC123', mode: 'hanchan' as const, capacity: 4, status: 'lobby' as const, creatorSeat: 2,
      timeLimitSeconds: 3600,
      rulesetId: 'lotus-legacy' as const, seats: [null, null, { seat: 2, nickname: '莲花', ready: false, connected: true }, null],
      llmEnabled: true, effectiveLlmEnabled: true, llmAvailable: true,
    })),
    joinRoom: vi.fn(async () => ({
      roomId: 'ABC123', seat: 2, nickname: '莲花', rejoinCode: 'AAAA-BBBB',
      playerId: 'guest', rejoin: false,
    })),
    leaveRoom: vi.fn(async () => ({ roomId: 'ABC123', seat: 2, left: true })),
    readyRoom: vi.fn(async () => ({ roomId: 'ABC123', seat: 2, ready: true })),
    startRoom: vi.fn(async () => ({ roomId: 'ABC123', status: 'playing' })),
    closeRoom: vi.fn(async () => ({ roomId: 'ABC123', closed: true })),
  }
  const socket = { open: vi.fn() }
  const closeConnection = vi.fn()
  const resetGame = vi.fn()
  const lifecycle = createRemoteRoomLifecycle({
    state, sessionStore, socket, closeConnection, resetGame, api,
  })
  return { state, sessionStore, api, socket, closeConnection, resetGame, lifecycle }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('remoteRoomLifecycle', () => {
  it('creates, joins and persists a room before opening the socket', async () => {
    const harness = createHarness()

    await harness.lifecycle.createRoom('east', 4)

    expect(harness.state.playerId.value).not.toBe('')
    expect(harness.api.createRoom).toHaveBeenCalledWith('east', 4, harness.state.playerId.value, 'lotus-classic', undefined)
    expect(harness.state.roomId.value).toBe('ABC123')
    expect(harness.state.effectiveLlmEnabled.value).toBe(true)
    expect(harness.state.rejoinCode.value).toBe('AAAA-BBBB')
    expect(harness.state.sessionStatus.value).toBe('connected')
    expect(harness.socket.open).toHaveBeenCalledOnce()
    expect(harness.sessionStore.saveSession).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'ABC123', rejoinCode: 'AAAA-BBBB', mode: 'east',
    }))
    harness.lifecycle.stopPolling()
  })

  it('forwards the request to use LLM filler seats when creating a room', async () => {
    const harness = createHarness()

    await harness.lifecycle.createRoom('east', 4, 'lotus-classic', true)

    expect(harness.api.createRoom).toHaveBeenCalledWith('east', 4, harness.state.playerId.value, 'lotus-classic', true)
    expect(harness.state.llmEnabled.value).toBe(true)
    expect(harness.state.effectiveLlmEnabled.value).toBe(true)
    harness.lifecycle.stopPolling()
  })

  it('refreshes authoritative creator and room metadata only in the lobby', async () => {
    const harness = createHarness()
    harness.state.roomId.value = 'ABC123'
    harness.state.mySeat.value = 2
    await harness.lifecycle.refreshRoom()
    expect(harness.state.isCreator.value).toBe(true)
    expect(harness.state.matchType.value).toBe('hanchan')
    expect(harness.state.roomSeats.value[2]?.nickname).toBe('莲花')
    expect(harness.state.roomTimeLimit.value).toBe(3600)

    harness.state.phase.value = 'playing'
    await harness.lifecycle.refreshRoom()
    expect(harness.api.getRoom).toHaveBeenCalledTimes(1)
  })

  it('forwards per-seat LLM configs to startRoom', async () => {
    const harness = createHarness()
    harness.state.roomId.value = 'ABC123'
    const seats = [
      { seat: 1, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-a', model: 'deepseek-chat', style: '话痨' },
      { seat: 3, baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-b', model: 'kimi-k2', style: '稳健', nickname: '小K' },
    ]
    await harness.lifecycle.startMatch(seats)
    expect(harness.api.startRoom).toHaveBeenCalledWith('ABC123', seats)
  })

  it('resumes a persisted session without rejoining through REST', async () => {
    const saved: StoredSession = {
      roomId: 'OLD123', rejoinCode: 'OLD-CODE', nickname: '旧玩家', playerId: 'guest-old', mode: 'hanchan',
      rulesetId: 'lotus-legacy',
    }
    const harness = createHarness(saved)

    await harness.lifecycle.resumeSession()

    expect(harness.state.roomId.value).toBe('OLD123')
    expect(harness.state.matchType.value).toBe('hanchan')
    expect(harness.state.sessionStatus.value).toBe('connected')
    expect(harness.socket.open).toHaveBeenCalledOnce()
    expect(harness.api.joinRoom).not.toHaveBeenCalled()
    harness.lifecycle.stopPolling()
  })

  it('releases the seat and clears local transport/session state when leaving', async () => {
    const harness = createHarness()
    harness.state.roomId.value = 'ABC123'
    harness.state.mySeat.value = 2
    harness.state.rejoinCode.value = 'AAAA-BBBB'

    await harness.lifecycle.leaveRoom()

    expect(harness.api.leaveRoom).toHaveBeenCalledWith('ABC123', 2, 'AAAA-BBBB')
    expect(harness.sessionStore.clearSession).toHaveBeenCalledOnce()
    expect(harness.closeConnection).toHaveBeenCalledOnce()
    expect(harness.resetGame).toHaveBeenCalledOnce()
  })
})
