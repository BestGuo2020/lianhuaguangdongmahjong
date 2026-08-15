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
      mode: 'hanchan',
      rulesetId: 'lotus-classic',
    }

    store.saveGuestId('guest-1')
    store.saveNickname('莲花')
    store.saveSession(session)

    expect(store.loadGuestId()).toBe('guest-1')
    expect(store.loadSession()).toEqual(session)
    expect(storage.data[REMOTE_STORAGE_KEYS.nickname]).toBe('莲花')

    store.clearSession()
    expect(store.loadSession()).toBeNull()
    expect(store.loadGuestId()).toBe('guest-1')
  })

  it('rejects malformed and unknown-mode sessions；SDK 版允许无 rejoinCode', () => {
    const storage = memoryStorage()
    const store = createRemoteSessionStore(() => storage)

    storage.data[REMOTE_STORAGE_KEYS.session] = '{broken'
    expect(store.loadSession()).toBeNull()
    // SDK 版（VibeHub）无 rejoinCode：仅 roomId + 合法 mode 即为有效会话（刷新页面重进）。
    storage.data[REMOTE_STORAGE_KEYS.session] = JSON.stringify({ roomId: 'A', mode: 'east' })
    expect(store.loadSession()).toEqual({ roomId: 'A', rejoinCode: undefined, nickname: '', playerId: '', mode: 'east', rulesetId: 'lotus-classic' })
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
})
