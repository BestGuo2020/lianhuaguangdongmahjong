import type { MatchType } from '../../core/contracts/types'
import type { RuleVariant } from '../../core/rules/ruleVariants'

export interface StoredSession {
  roomId: string
  rejoinCode: string
  nickname: string
  playerId: string
  mode: MatchType
  rulesetId?: RuleVariant
  /** 保存时间戳（ms）：超过有效期（对局早已散场、房间大概率不存在）则不再自动重进。 */
  savedAt?: number
}

/** 会话有效期：超过该时长（对局结束/全员离开后房间在 SDK 侧基本失效）自动清除，
 * 避免几小时后回来还自动重进一个早已不存在的旧房间号，反复「重进后连座位都没收到」。 */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000

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
    loadSession(now: () => number = Date.now): StoredSession | null {
      const raw = read(REMOTE_STORAGE_KEYS.session)
      if (!raw) return null
      try {
        const session = JSON.parse(raw) as Partial<StoredSession>
        // SDK 版（VibeHub）无 rejoinCode：房号重进，rejoinCode 允许空串。
        if (!session.roomId) return null
        if (session.mode !== 'east' && session.mode !== 'hanchan') return null
        const rulesetId = session.rulesetId ?? 'lotus-classic'
        if (rulesetId !== 'lotus-classic' && rulesetId !== 'lotus-legacy') return null
        // 旧会话失效：保存超过 2 小时（对局早已散场，房间大概率不存在）→ 清除并返回
        // null，刷新后不再自动重进旧房间号（重试一个不存在的房间毫无意义）。
        if (typeof session.savedAt === 'number' && now() - session.savedAt > SESSION_TTL_MS) {
          remove(REMOTE_STORAGE_KEYS.session)
          return null
        }
        return {
          roomId: session.roomId,
          rejoinCode: session.rejoinCode,
          nickname: session.nickname ?? '',
          playerId: session.playerId ?? '',
          mode: session.mode,
          rulesetId,
          savedAt: session.savedAt,
        }
      } catch {
        return null
      }
    },
    saveSession(session: StoredSession): void {
      write(REMOTE_STORAGE_KEYS.session, JSON.stringify({ ...session, savedAt: Date.now() }))
    },
    clearSession(): void {
      remove(REMOTE_STORAGE_KEYS.session)
    },
  }
}
