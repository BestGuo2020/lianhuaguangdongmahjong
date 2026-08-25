import { describe, expect, it } from 'vitest'
import {
  defaultTableTheme,
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
})
