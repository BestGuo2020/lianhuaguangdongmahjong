// 回放保留策略偏好（本机 localStorage）：与仓库既有偏好模块同款写法 —— 注入 storage、
// 静默降级（隐私模式/禁用存储不得影响对局），并在读取时校验取值。
export const REPLAY_KEEP_STORAGE_KEY = 'lgm_replay_keep'

/** 可选保留场次；超过上限时按开始时间淘汰最旧。 */
export const REPLAY_KEEP_OPTIONS = [10, 30, 50] as const
export type ReplayKeepCount = typeof REPLAY_KEEP_OPTIONS[number]
export const REPLAY_KEEP_DEFAULT: ReplayKeepCount = 50

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function isReplayKeepCount(value: unknown): value is ReplayKeepCount {
  return REPLAY_KEEP_OPTIONS.includes(value as ReplayKeepCount)
}

export function readReplayKeepCount(storage: StorageLike | undefined = defaultStorage()): ReplayKeepCount {
  try {
    const raw = Number(storage?.getItem(REPLAY_KEEP_STORAGE_KEY))
    return isReplayKeepCount(raw) ? raw : REPLAY_KEEP_DEFAULT
  } catch {
    return REPLAY_KEEP_DEFAULT
  }
}

export function saveReplayKeepCount(
  value: number,
  storage: StorageLike | undefined = defaultStorage(),
): ReplayKeepCount {
  const resolved = isReplayKeepCount(value) ? value : REPLAY_KEEP_DEFAULT
  try {
    storage?.setItem(REPLAY_KEEP_STORAGE_KEY, String(resolved))
  } catch {
    /* 存储不可用：本次仍生效，只是不记住 */
  }
  return resolved
}
