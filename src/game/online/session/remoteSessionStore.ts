import type { MatchType } from '../../core/contracts/types'
import type { RuleVariant } from '../../core/rules/ruleVariants'

export interface StoredSession {
  roomId: string
  rejoinCode: string
  nickname: string
  playerId: string
  /** 房主签发的座位续接凭据；不广播到公开 roster。 */
  seatToken?: string
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

export interface RemoteSessionStoreOptions {
  /** 开发环境多标签 Mock 测试用的键前缀；生产环境不传。 */
  namespace?: string
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
  options: RemoteSessionStoreOptions = {},
) {
  const storageKey = (key: string) => options.namespace ? `${options.namespace}:${key}` : key

  function read(key: string): string | null {
    try {
      return getStorage()?.getItem(storageKey(key)) ?? null
    } catch {
      return null
    }
  }

  function write(key: string, value: string): void {
    try {
      getStorage()?.setItem(storageKey(key), value)
    } catch {
      // 隐私模式或存储配额异常时降级为当前页面会话。
    }
  }

  function remove(key: string): void {
    try {
      getStorage()?.removeItem(storageKey(key))
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
          ...(typeof session.seatToken === 'string' ? { seatToken: session.seatToken } : {}),
          mode: session.mode,
          rulesetId,
          savedAt: session.savedAt,
        }
      } catch {
        return null
      }
    },
    saveSession(session: StoredSession): void {
      // 房主 token 可能在 roster 之后异步到达；后续 room/mode watcher 写会话时
      // 必须保留已有 token，否则刷新重进会退化成“只靠 playerId 抢座”。
      let existingToken: string | undefined
      try {
        const existing = JSON.parse(read(REMOTE_STORAGE_KEYS.session) ?? 'null') as {
          roomId?: unknown
          playerId?: unknown
          seatToken?: unknown
        } | null
        if (
          existing?.roomId === session.roomId
          && existing?.playerId === session.playerId
          && typeof existing.seatToken === 'string'
        ) existingToken = existing.seatToken
      } catch {
        // Ignore malformed previous session; the new session replaces it.
      }
      write(REMOTE_STORAGE_KEYS.session, JSON.stringify({
        ...session,
        ...(session.seatToken || !existingToken ? {} : { seatToken: existingToken }),
        savedAt: Date.now(),
      }))
    },
    saveSeatToken(seatToken: string): void {
      if (!seatToken) return
      const session = this.loadSession()
      if (!session) return
      this.saveSession({ ...session, seatToken })
    },
    clearSession(): void {
      remove(REMOTE_STORAGE_KEYS.session)
    },
  }
}
