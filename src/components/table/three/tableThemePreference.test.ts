import { describe, expect, it } from 'vitest'
import {
  isTableThemeName,
  resolveInitialTableTheme,
  shouldAutoUseLlmTheme,
} from './tableThemePreference'

describe('牌桌主题默认选择', () => {
  it('把 URL 合法主题视为明确选择', () => {
    expect(isTableThemeName('llm')).toBe(true)
    expect(isTableThemeName('llmAnime')).toBe(true)
    expect(resolveInitialTableTheme('rosewood')).toEqual({ theme: 'rosewood', explicit: true })
    expect(resolveInitialTableTheme('llmAnime')).toEqual({ theme: 'llmAnime', explicit: true })
  })

  it('未知或缺省主题回退墨玉并允许 LLM 推荐', () => {
    expect(isTableThemeName('unknown')).toBe(false)
    expect(resolveInitialTableTheme(null)).toEqual({ theme: 'jade', explicit: false })
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
