import { createRemoteSessionStore, REMOTE_STORAGE_KEYS, SESSION_TTL_MS } from '../session/remoteSessionStore'
import type { RemoteSessionStoreOptions, StorageLike, StoredSession } from '../session/remoteSessionStore'

/** Extend the existing injected store contract without changing its protected parser.
 * Old rules still use the original parser; blood-flow keeps its own explicit rule key. */
export function createBloodFlowSessionStore(
  getStorage: () => StorageLike | null = () => { try { return window.localStorage } catch { return null } },
  options: RemoteSessionStoreOptions = {},
) {
  const base = createRemoteSessionStore(getStorage, options)
  return {
    ...base,
    loadSession(now: () => number = Date.now): StoredSession | null {
      const legacy = base.loadSession(now)
      if (legacy) return legacy
      const key = options.namespace ? `${options.namespace}:${REMOTE_STORAGE_KEYS.session}` : REMOTE_STORAGE_KEYS.session
      try {
        const value = JSON.parse(getStorage()?.getItem(key) ?? 'null')
        if (!value || value.rulesetId !== 'lotus-blood-flow' || typeof value.roomId !== 'string' || !value.roomId
          || !['east', 'hanchan'].includes(value.mode) || typeof value.playerId !== 'string'
          || (value.seatToken !== undefined && typeof value.seatToken !== 'string')) return null
        if (typeof value.savedAt === 'number' && now() - value.savedAt > SESSION_TTL_MS) { base.clearSession(); return null }
        return { roomId: value.roomId, rejoinCode: '', nickname: typeof value.nickname === 'string' ? value.nickname : '',
          playerId: value.playerId, seatToken: value.seatToken, mode: value.mode, rulesetId: 'lotus-blood-flow', savedAt: value.savedAt }
      } catch { return null }
    },
  }
}
