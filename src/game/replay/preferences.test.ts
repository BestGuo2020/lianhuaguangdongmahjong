import { describe, expect, it } from 'vitest'
import {
  REPLAY_KEEP_DEFAULT,
  REPLAY_KEEP_OPTIONS,
  REPLAY_KEEP_STORAGE_KEY,
  readReplayKeepCount,
  saveReplayKeepCount,
} from './preferences'

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    raw: map,
  }
}

describe('回放保留策略偏好', () => {
  it('缺省与非法取值都回落到默认上限', () => {
    expect(readReplayKeepCount(memoryStorage())).toBe(REPLAY_KEEP_DEFAULT)
    expect(readReplayKeepCount(memoryStorage({ [REPLAY_KEEP_STORAGE_KEY]: '7' }))).toBe(REPLAY_KEEP_DEFAULT)
    expect(readReplayKeepCount(memoryStorage({ [REPLAY_KEEP_STORAGE_KEY]: 'abc' }))).toBe(REPLAY_KEEP_DEFAULT)
    expect(readReplayKeepCount(undefined)).toBe(REPLAY_KEEP_DEFAULT)
  })

  it('读取合法取值并写回', () => {
    const storage = memoryStorage()
    expect(REPLAY_KEEP_OPTIONS).toContain(10)
    expect(saveReplayKeepCount(10, storage)).toBe(10)
    expect(storage.raw.get(REPLAY_KEEP_STORAGE_KEY)).toBe('10')
    expect(readReplayKeepCount(storage)).toBe(10)
  })

  it('非法写入值回落到默认并如实返回生效值', () => {
    const storage = memoryStorage()
    expect(saveReplayKeepCount(999, storage)).toBe(REPLAY_KEEP_DEFAULT)
    expect(readReplayKeepCount(storage)).toBe(REPLAY_KEEP_DEFAULT)
  })

  it('存储不可用（隐私模式）时读写都不抛错', () => {
    const throwing = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readReplayKeepCount(throwing)).toBe(REPLAY_KEEP_DEFAULT)
    expect(saveReplayKeepCount(30, throwing)).toBe(30)
  })
})
