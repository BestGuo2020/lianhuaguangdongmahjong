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
      description: '蓝紫粉霓虹与二次元牌面',
    })
  })

  it('使用独立的蓝紫粉桌体、牌材质与牌背渐变', () => {
    expect(llmAnimeTheme.table.jade).not.toEqual(llmTheme.table.jade)
    expect(llmAnimeTheme.tile).not.toBe(defaultTableTheme.tile)
    expect(llmAnimeTheme.tileBackGradient).toEqual(['#8ca9ff', '#aa78e8', '#ef87c5'])
    expect(llmAnimeTheme.tableSurfaceTexture).toBeUndefined()
  })
})
