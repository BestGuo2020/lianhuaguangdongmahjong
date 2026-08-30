import { describe, expect, it } from 'vitest'
import {
  defaultTableTheme,
  llmAnimeTheme,
  llmTheme,
  TABLE_THEME_OPTIONS,
  tableThemeByName,
} from './tableTheme'

describe('大模型专属牌桌主题', () => {
  it('注册为可公开选择的 llm 主题', () => {
    expect(tableThemeByName('llm')).toBe(llmTheme)
    expect(TABLE_THEME_OPTIONS).toContainEqual({
      value: 'llm',
      label: '大模型专属',
      description: '双模型娘化对决与深蓝星轨',
    })
  })

  it('加载方形 WebP 桌布', () => {
    expect(llmTheme.tableSurfaceTexture?.url).toMatch(/img\/llm-table\.webp$/)
    expect(llmTheme.tableSurfaceTexture?.tint).toBe(0xffffff)
  })

  it('完整沿用默认麻将牌与高亮材质', () => {
    expect(llmTheme.tile).toBe(defaultTableTheme.tile)
    expect(llmTheme.highlight).toBe(defaultTableTheme.highlight)
    expect(llmTheme.tileBackGradient).toBe(defaultTableTheme.tileBackGradient)
  })

  it('保留深蓝星轨桌布，不受二次元主题注册影响', () => {
    expect(llmTheme.tableSurfaceTexture?.url).toMatch(/img\/llm-table\.webp$/)
    expect(llmTheme.tile).toBe(defaultTableTheme.tile)
  })
})

describe('大模型二次元牌桌主题', () => {
  it('注册为独立的 llmAnime 主题', () => {
    expect(tableThemeByName('llmAnime')).toBe(llmAnimeTheme)
    expect(llmAnimeTheme).not.toBe(llmTheme)
    expect(TABLE_THEME_OPTIONS).toContainEqual({
      value: 'llmAnime',
      label: '大模型二次元',
      description: '鼠尾草绒面、树脂麻将与角色演出',
    })
  })

  it('使用独立的鼠尾草绒面、树脂麻将与珊瑚牌背', () => {
    expect(llmAnimeTheme.table.jade).not.toEqual(llmTheme.table.jade)
    expect(llmAnimeTheme.tile).not.toBe(defaultTableTheme.tile)
    expect(llmAnimeTheme.tileGeometry).toEqual({ segments: 4, baseRadius: .07, capRadius: .075 })
    expect(llmAnimeTheme.tableFelt).toBe(true)
    expect(llmAnimeTheme.tableVignette).toBe(.14)
    expect(llmAnimeTheme.tableFeltVariation).toBe(8)
    expect(llmAnimeTheme.tableGuide).toBeDefined()
    expect(llmAnimeTheme.machineScale).toBe(1.13)
    expect(llmAnimeTheme.machineRelief).toBe(1.22)
    expect(llmAnimeTheme.staticTableCastShadow).toBe(false)
    expect(llmAnimeTheme.edgeTrimTopMatchesSurface).toBe(true)
    expect(llmAnimeTheme.woodTrim).toBe(false)
    expect(llmAnimeTheme.tileBackGradient).toEqual(['#bd5b48', '#bd5b48', '#bd5b48'])
    expect(llmAnimeTheme.tile.faceSide.roughness).toBeGreaterThanOrEqual(.15)
    expect(llmAnimeTheme.tile.faceSide.roughness).toBeLessThanOrEqual(.22)
    expect(llmAnimeTheme.tile.faceSide.clearcoat).toBe(1)
    expect(llmAnimeTheme.tile.faceSide.clearcoatRoughness).toBe(.1)
    expect(llmAnimeTheme.tile.face.clearcoat).toBe(1)
    expect(llmAnimeTheme.tile.back.clearcoat).toBe(1)
    expect(llmAnimeTheme.tile.faceSide.envMapIntensity).toBeGreaterThan(0)
    expect(llmAnimeTheme.tableSurfaceTexture).toBeUndefined()
  })
})
