import { describe, expect, it } from 'vitest'
import {
  createRemoteSessionStore,
  generateGuestId,
  REMOTE_STORAGE_KEYS,
  type StorageLike,
  type StoredSession,
} from './remoteSessionStore'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value },
    removeItem: (key) => { delete data[key] },
  }
}

describe('remoteSessionStore', () => {
  it('round-trips guest identity, nickname and resumable room session', () => {
    const storage = memoryStorage()
    const store = createRemoteSessionStore(() => storage)
    const session: StoredSession = {
      roomId: 'ABC123',
      rejoinCode: 'AAAA-BBBB',
      nickname: '莲花',
      playerId: 'guest-1',
      seatToken: 'seat-secret',
      mode: 'hanchan',
      rulesetId: 'lotus-classic',
    }

    store.saveGuestId('guest-1')
    store.saveNickname('莲花')
    store.saveSession(session)

    expect(store.loadGuestId()).toBe('guest-1')
    const loaded = store.loadSession()
    expect(loaded).toMatchObject(session)
    expect(typeof loaded?.savedAt).toBe('number')
    expect(storage.data[REMOTE_STORAGE_KEYS.nickname]).toBe('莲花')

    store.saveSeatToken('seat-secret-2')
    expect(store.loadSession()?.seatToken).toBe('seat-secret-2')

    store.clearSession()
    expect(store.loadSession()).toBeNull()
    expect(store.loadGuestId()).toBe('guest-1')
  })

  it('旧会话超过有效期（对局早已散场）→ 自动清除，不再自动重进不存在的房间', () => {
    const storage = memoryStorage()
    const store = createRemoteSessionStore(() => storage)
    const now = Date.now()
    storage.data[REMOTE_STORAGE_KEYS.session] = JSON.stringify({
      roomId: 'OLDROOM',
      rejoinCode: '',
      nickname: '莲花',
      playerId: 'guest-1',
      mode: 'east',
      rulesetId: 'lotus-classic',
      savedAt: now - 3 * 60 * 60 * 1000, // 3 小时前保存（超过 2h TTL）
    })
    // 过期 → 返回 null 并清除存储。
    expect(store.loadSession(() => now)).toBeNull()
    expect(storage.data[REMOTE_STORAGE_KEYS.session]).toBeUndefined()
    // 未过期（如 1 小时前）→ 仍可恢复。
    storage.data[REMOTE_STORAGE_KEYS.session] = JSON.stringify({
      roomId: 'LIVEROOM', rejoinCode: '', nickname: '莲花', playerId: 'guest-1', mode: 'east',
      rulesetId: 'lotus-classic', savedAt: now - 60 * 60 * 1000,
    })
    expect(store.loadSession(() => now)?.roomId).toBe('LIVEROOM')
  })

  it('rejects malformed and unknown-mode sessions；SDK 版允许无 rejoinCode', () => {
    const storage = memoryStorage()
    const store = createRemoteSessionStore(() => storage)

    storage.data[REMOTE_STORAGE_KEYS.session] = '{broken'
    expect(store.loadSession()).toBeNull()
    // SDK 版（VibeHub）无 rejoinCode：仅 roomId + 合法 mode 即为有效会话（刷新页面重进）。
    storage.data[REMOTE_STORAGE_KEYS.session] = JSON.stringify({ roomId: 'A', mode: 'east' })
    expect(store.loadSession()).toEqual({
      roomId: 'A', rejoinCode: undefined, nickname: '', playerId: '', mode: 'east',
      rulesetId: 'lotus-classic', savedAt: undefined,
    })
    storage.data[REMOTE_STORAGE_KEYS.session] = JSON.stringify({ rejoinCode: 'B', mode: 'east' })
    expect(store.loadSession()).toBeNull()
    storage.data[REMOTE_STORAGE_KEYS.session] = JSON.stringify({ roomId: 'A', rejoinCode: 'B', mode: 'unknown' })
    expect(store.loadSession()).toBeNull()
  })

  it('silently degrades when browser storage is unavailable', () => {
    const store = createRemoteSessionStore(() => { throw new Error('denied') })

    expect(store.loadGuestId()).toBeNull()
    expect(store.loadSession()).toBeNull()
    expect(() => store.saveGuestId('guest')).not.toThrow()
    expect(() => store.clearSession()).not.toThrow()
  })

  it('preserves the existing anonymous id format', () => {
    const id = generateGuestId(() => 0.5, () => 123456789)

    expect(id).toBe('gii3v9')
  })

  it('隔离开发 Mock peer 的会话，避免共享 localStorage 互相恢复', () => {
    const storage = memoryStorage()
    const peerA = createRemoteSessionStore(() => storage, { namespace: 'mock:peer-a' })
    const peerB = createRemoteSessionStore(() => storage, { namespace: 'mock:peer-b' })

    peerA.saveGuestId('guest-a')
    peerA.saveNickname('甲')
    peerA.saveSession({ roomId: 'ROOM-A', rejoinCode: '', nickname: '甲', playerId: 'guest-a', mode: 'east' })
    peerB.saveGuestId('guest-b')
    peerB.saveNickname('乙')
    peerB.saveSession({ roomId: 'ROOM-B', rejoinCode: '', nickname: '乙', playerId: 'guest-b', mode: 'east' })

    expect(peerA.loadGuestId()).toBe('guest-a')
    expect(peerA.loadSession()?.roomId).toBe('ROOM-A')
    expect(peerB.loadGuestId()).toBe('guest-b')
    expect(peerB.loadSession()?.roomId).toBe('ROOM-B')
    expect(storage.data[`mock:peer-a:${REMOTE_STORAGE_KEYS.session}`]).toBeTruthy()
    expect(storage.data[`mock:peer-b:${REMOTE_STORAGE_KEYS.session}`]).toBeTruthy()
  })
})
