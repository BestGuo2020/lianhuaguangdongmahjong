import { describe, expect, it } from 'vitest'
import {
  TABLE_THEME_PREFERENCE_STORAGE_KEY,
  isTableThemeName,
  readTableThemePreference,
  resolveInitialTableTheme,
  saveTableThemePreference,
  shouldAutoUseLlmTheme,
} from './tableThemePreference'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(TABLE_THEME_PREFERENCE_STORAGE_KEY, initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('牌桌主题默认选择', () => {
  it('把 URL 合法主题视为明确选择', () => {
    expect(isTableThemeName('llm')).toBe(true)
    expect(isTableThemeName('llmAnime')).toBe(true)
    expect(resolveInitialTableTheme('rosewood')).toEqual({ theme: 'rosewood', explicit: true })
    expect(resolveInitialTableTheme('llmAnime')).toEqual({ theme: 'llmAnime', explicit: true })
  })

  it('未知 URL 和旧 majsoul URL 稳定回退墨玉', () => {
    expect(isTableThemeName('unknown')).toBe(false)
    expect(isTableThemeName('majsoul')).toBe(false)
    expect(resolveInitialTableTheme('unknown')).toEqual({ theme: 'jade', explicit: true })
    expect(resolveInitialTableTheme('majsoul')).toEqual({ theme: 'jade', explicit: true })
  })

  it('URL 缺省且无本地偏好时才允许 LLM 推荐', () => {
    expect(resolveInitialTableTheme(null)).toEqual({ theme: 'jade', explicit: false })
  })

  it('URL 优先于本地偏好，本地偏好可作为明确选择恢复', () => {
    expect(resolveInitialTableTheme(null, 'rosewood')).toEqual({ theme: 'rosewood', explicit: true })
    expect(resolveInitialTableTheme('llm', 'rosewood')).toEqual({ theme: 'llm', explicit: true })
  })

  it('迁移旧 majsoul 与损坏的本地偏好到墨玉', () => {
    for (const value of ['majsoul', 'unknown', '{broken']) {
      const storage = memoryStorage(value)
      expect(readTableThemePreference(storage)).toBe('jade')
      expect(storage.getItem(TABLE_THEME_PREFERENCE_STORAGE_KEY)).toBe('jade')
    }
  })

  it('读写合法主题，并在存储不可用时安全降级', () => {
    const storage = memoryStorage()
    expect(readTableThemePreference(storage)).toBeNull()
    expect(saveTableThemePreference('llmAnime', storage)).toBe('llmAnime')
    expect(readTableThemePreference(storage)).toBe('llmAnime')
    expect(saveTableThemePreference('majsoul', storage)).toBe('jade')
    expect(readTableThemePreference(storage)).toBe('jade')

    const unavailable = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readTableThemePreference(unavailable)).toBeNull()
    expect(saveTableThemePreference('rosewood', unavailable)).toBe('rosewood')
  })

  it('仅在 LLM 开启且用户没有明确选择时自动推荐', () => {
    expect(shouldAutoUseLlmTheme(true, false)).toBe(true)
    expect(shouldAutoUseLlmTheme(true, true)).toBe(false)
    expect(shouldAutoUseLlmTheme(false, false)).toBe(false)
  })

  it('自动推荐逻辑仍指向现有 llm 主题，而非显式选择的 llmAnime', () => {
    const recommendedTheme = shouldAutoUseLlmTheme(true, false) ? 'llm' : 'jade'
    expect(recommendedTheme).toBe('llm')
    expect(shouldAutoUseLlmTheme(true, resolveInitialTableTheme('llmAnime').explicit)).toBe(false)
  })
})
