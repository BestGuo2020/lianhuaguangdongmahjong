import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createVibeRoomSession } from './vibeRoomSession'
import { createMockVibeClient } from './mockVibeHub'
import { initVibeHub } from './vibeClient'
import type { LobbySeat } from './vibeLobby'

function makeState() {
  return {
    roomId: ref(''),
    mySeat: ref(-1),
    nickname: ref('测试玩家'),
    avatar: ref(''),
    playerId: ref(''),
    roomSeats: ref<LobbySeat[]>([]),
    sessionStatus: ref('idle'),
    sessionError: ref(''),
    rulesetId: ref<'lotus-classic' | 'lotus-legacy'>('lotus-classic'),
    matchType: ref<'east' | 'hanchan'>('east'),
    isHost: ref(false),
    phase: ref('lobby'),
  }
}

beforeEach(async () => {
  vi.stubGlobal('window', {
    location: { hostname: 'localhost', search: '', href: 'http://localhost/' },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
  // 初始化全局 SDK client（DEV 下走本地 mock），vibeRoom.joinRoom 依赖它。
  await initVibeHub()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('vibeRoomSession', () => {
  it('加入没有房主的空房间（对局结束全员离开后重进）→ SDK 判自己为房主 → 走 host 初始化', async () => {
    const state = makeState()
    let started = false
    const session = createVibeRoomSession({
      state,
      onStart: () => { started = true },
      onClosed: () => {},
      loadSavedRoom: () => null,
    })

    await session.joinRoom('EMPTY1')

    // 成为房主：座位 0、hostLobby 已创建（不再是「收不到 roster 的客户端」）。
    expect(state.isHost.value).toBe(true)
    expect(state.mySeat.value).toBe(0)
    expect(state.roomId.value).toBe('EMPTY1')
    expect(state.roomSeats.value).toHaveLength(1)
    expect(state.roomSeats.value[0].seat).toBe(0)
    expect(state.sessionStatus.value).toBe('connected')

    // 房主可设准备态并请求开局（hostLobby 有效）。
    await session.toggleReady()
    expect(state.roomSeats.value[0].ready).toBe(true)
    await session.startMatch()
    expect(started).toBe(true)
  })

  it('加入有房主的房间 → 按客户端逻辑（isHost=false，mySeat 由 roster 分配）', async () => {
    // 先有一个窗口加入并成为房主。
    const hostClient = createMockVibeClient({ settleMs: 10, pingIntervalMs: 0, leaveTimeoutMs: 100000 })
    const hostRoom = await hostClient.room.join('HOSTED1')
    expect(hostRoom.isHost).toBe(true)

    const state = makeState()
    const session = createVibeRoomSession({
      state,
      onStart: () => {},
      onClosed: () => {},
      loadSavedRoom: () => null,
    })
    await session.joinRoom('HOSTED1')
    expect(state.isHost.value).toBe(false)
  })
})
