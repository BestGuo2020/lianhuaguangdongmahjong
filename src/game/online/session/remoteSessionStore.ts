import type { MatchType } from '../../core/contracts/types'
import type { RuleVariant } from '../../core/rules/ruleVariants'

export interface StoredSession {
  roomId: string
  rejoinCode: string
  nickname: string
  playerId: string
  mode: MatchType
  rulesetId?: RuleVariant
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const REMOTE_STORAGE_KEYS = {
  guestId: 'lgm_guest_id',
  nickname: 'lgm_nickname',
  session: 'lgm_session',
} as const

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function generateGuestId(
  random: () => number = Math.random,
  now: () => number = Date.now,
): string {
  const randomPart = random().toString(36).slice(2, 10)
  const stamp = now().toString(36).slice(-4)
  return `g${randomPart}${stamp}`
}

export function createRemoteSessionStore(
  getStorage: () => StorageLike | null = browserStorage,
) {
  function read(key: string): string | null {
    try {
      return getStorage()?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  function write(key: string, value: string): void {
    try {
      getStorage()?.setItem(key, value)
    } catch {
      // 隐私模式或存储配额异常时降级为当前页面会话。
    }
  }

  function remove(key: string): void {
    try {
      getStorage()?.removeItem(key)
    } catch {
      // 无法访问存储不应阻断退出房间。
    }
  }

  return {
    loadGuestId: () => read(REMOTE_STORAGE_KEYS.guestId),
    saveGuestId: (playerId: string) => write(REMOTE_STORAGE_KEYS.guestId, playerId),
    saveNickname: (nickname: string) => write(REMOTE_STORAGE_KEYS.nickname, nickname),
    loadSession(): StoredSession | null {
      const raw = read(REMOTE_STORAGE_KEYS.session)
      if (!raw) return null
      try {
        const session = JSON.parse(raw) as Partial<StoredSession>
        if (!session.roomId || !session.rejoinCode) return null
        if (session.mode !== 'east' && session.mode !== 'hanchan') return null
        const rulesetId = session.rulesetId ?? 'lotus-classic'
        if (rulesetId !== 'lotus-classic' && rulesetId !== 'lotus-legacy') return null
        return {
          roomId: session.roomId,
          rejoinCode: session.rejoinCode,
          nickname: session.nickname ?? '',
          playerId: session.playerId ?? '',
          mode: session.mode,
          rulesetId,
        }
      } catch {
        return null
      }
    },
    saveSession(session: StoredSession): void {
      write(REMOTE_STORAGE_KEYS.session, JSON.stringify(session))
    },
    clearSession(): void {
      remove(REMOTE_STORAGE_KEYS.session)
    },
  }
}
