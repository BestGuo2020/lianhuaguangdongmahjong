import { describe, expect, it } from 'vitest'
import { TABLE_THEME_NAMES, TABLE_THEME_OPTIONS } from './themeIdentity'
import {
  THEME_PRESENTATIONS,
  resolveThemeAssetUrl,
  themePresentationByName,
  themePresentationCssVariables,
} from './themePresentation'

describe('主题表现合同', () => {
  it('为五个保留主题提供完整且同源的身份信息', () => {
    expect(Object.keys(THEME_PRESENTATIONS)).toEqual(TABLE_THEME_NAMES)
    for (const option of TABLE_THEME_OPTIONS) {
      const theme = THEME_PRESENTATIONS[option.value]
      expect(theme.identity).toMatchObject({ label: option.label, description: option.description })
      expect(theme.identity.previewUrl).toMatch(new RegExp(`themes/previews/v1/${option.value}\\.svg$`))
      expect(theme.shell.pageBackground).not.toBe('')
      expect(theme.shell.ambientOverlay).not.toBe('')
      expect(theme.shell.motif).not.toBe('')
      expect(Object.values(theme.palette).every(Boolean)).toBe(true)
      expect(Object.values(theme.typography).every(Boolean)).toBe(true)
      expect(Object.values(theme.hud).every(Boolean)).toBe(true)
      expect(Object.values(theme.presentation).every(Boolean)).toBe(true)
      expect(Object.values(theme.motion).every(Boolean)).toBe(true)
    }
  })

  it('未知值与废弃值统一回退默认墨玉', () => {
    expect(themePresentationByName('unknown')).toBe(THEME_PRESENTATIONS.jade)
    expect(themePresentationByName('majsoul')).toBe(THEME_PRESENTATIONS.jade)
    expect(themePresentationByName(null)).toBe(THEME_PRESENTATIONS.jade)
  })

  it('资源 URL 兼容部署 BASE_URL', () => {
    expect(resolveThemeAssetUrl('/themes/example.svg', '/mahjong/')).toBe('/mahjong/themes/example.svg')
    expect(resolveThemeAssetUrl('themes/example.svg', '/mahjong')).toBe('/mahjong/themes/example.svg')
  })

  it('五主题外围表现指纹互不相同', () => {
    const fingerprints = TABLE_THEME_NAMES.map((name) => {
      const theme = THEME_PRESENTATIONS[name]
      return [theme.shell.pageBackground, theme.hud.playerFrame, theme.hud.topBar, theme.presentation.settlement].join('|')
    })
    expect(new Set(fingerprints).size).toBe(TABLE_THEME_NAMES.length)
  })

  it('导出共享 CSS 变量，不泄漏未声明字段', () => {
    const variables = themePresentationCssVariables(THEME_PRESENTATIONS.happyMahjong)
    expect(variables['--theme-accent']).toBe(THEME_PRESENTATIONS.happyMahjong.palette.accent)
    expect(variables['--theme-page-background']).toBe(THEME_PRESENTATIONS.happyMahjong.shell.pageBackground)
    expect(Object.keys(variables).every((key) => key.startsWith('--theme-'))).toBe(true)
  })
})
