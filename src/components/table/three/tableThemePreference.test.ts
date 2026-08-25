import { describe, expect, it } from 'vitest'
import {
  isTableThemeName,
  resolveInitialTableTheme,
  shouldAutoUseLlmTheme,
} from './tableThemePreference'

describe('牌桌主题默认选择', () => {
  it('把 URL 合法主题视为明确选择', () => {
    expect(isTableThemeName('llm')).toBe(true)
    expect(resolveInitialTableTheme('rosewood')).toEqual({ theme: 'rosewood', explicit: true })
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
})
