import { describe, expect, it } from 'vitest'
import { ANIME_CHARACTER_IDS } from '../../../game/llm/animeCharacters'
import {
  defaultTableTheme,
  llmAnimeTheme,
  llmTheme,
  rosewoodTheme,
  TABLE_THEMES,
  TABLE_THEME_OPTIONS,
  tableThemeByName,
} from './tableTheme'

describe('牌桌主题注册表', () => {
  it('只公开五个保留主题并拒绝旧主题 ID', () => {
    expect(TABLE_THEME_OPTIONS.map(({ value }) => value)).toEqual([
      'jade', 'happyMahjong', 'rosewood', 'llm', 'llmAnime',
    ])
    expect(Object.keys(TABLE_THEMES)).toEqual([
      'jade', 'happyMahjong', 'rosewood', 'llm', 'llmAnime',
    ])
    expect(tableThemeByName('majsoul')).toBeUndefined()
    expect(tableThemeByName('unknown')).toBeUndefined()
  })
})

describe('大模型专属牌桌主题', () => {
  it('注册为可公开选择的 llm 主题', () => {
    expect(tableThemeByName('llm')).toBe(llmTheme)
    expect(TABLE_THEME_OPTIONS).toContainEqual({
      value: 'llm',
      label: '大模型专属',
      description: '深蓝星轨、数据线与模型对抗',
    })
  })

  it('加载方形 WebP 桌布', () => {
    expect(llmTheme.tableSurfaceTexture?.url).toMatch(/img\/llm-table\.webp$/)
    expect(llmTheme.tableSurfaceTexture?.tint).toBe(0xffffff)
  })

  it('使用蓝紫数据牌背并保留默认高亮材质', () => {
    expect(llmTheme.tile).not.toBe(defaultTableTheme.tile)
    expect(llmTheme.tileBackGradient).toEqual(['#3c65bd', '#29478f', '#172958'])
    expect(llmTheme.tile.faceSide.color).toBe(0x3155a1)
    expect(llmTheme.highlight).toBe(defaultTableTheme.highlight)
  })

  it('保留深蓝星轨桌布，不受二次元主题注册影响', () => {
    expect(llmTheme.tableSurfaceTexture?.url).toMatch(/img\/llm-table\.webp$/)
    expect(llmTheme.tile.faceSide).not.toEqual(defaultTableTheme.tile.faceSide)
  })
})

describe('红木金丝牌桌主题', () => {
  it('牌背使用与红木协调的暗红漆面', () => {
    expect(rosewoodTheme.tileBackGradient).toEqual(['#8e3f2e', '#6d2a20', '#46170f'])
    expect(rosewoodTheme.tile.faceSide.color).toBe(0x7e3023)
    expect(rosewoodTheme.tile.faceSide.color).not.toBe(defaultTableTheme.tile.faceSide.color)
  })
})

describe('大模型二次元牌桌主题', () => {
  it('注册为独立的 llmAnime 主题', () => {
    expect(tableThemeByName('llmAnime')).toBe(llmAnimeTheme)
    expect(llmAnimeTheme).not.toBe(llmTheme)
    expect(TABLE_THEME_OPTIONS).toContainEqual({
      value: 'llmAnime',
      label: '大模型二次元',
      description: '角色群像、漫画字效与动作演出',
    })
  })

  it('使用独立的鼠尾草绒面、树脂麻将与珊瑚牌背', () => {
    expect(llmAnimeTheme.table.jade).not.toEqual(llmTheme.table.jade)
    expect(llmAnimeTheme.tile).not.toBe(defaultTableTheme.tile)
    expect(llmAnimeTheme.tileGeometry).toEqual({ segments: 4, baseRadius: .07, capRadius: .075 })
    expect(llmAnimeTheme.tableFelt).toBe(true)
    expect(llmAnimeTheme.tableVignette).toBe(.38)
    expect(llmAnimeTheme.tableFeltVariation).toBe(8)
    expect(llmAnimeTheme.tableGuide).toBeDefined()
    expect(llmAnimeTheme.tableGuide?.opacity).toBe(.5)
    expect(llmAnimeTheme.tableGuide?.slotOpacity).toBe(.62)
    expect(llmAnimeTheme.machineScale).toBe(1.081)
    expect(llmAnimeTheme.machineRelief).toBe(1.22)
    expect(llmAnimeTheme.staticTableCastShadow).toBe(false)
    expect(llmAnimeTheme.edgeTrimTopMatchesSurface).toBe(true)
    expect(llmAnimeTheme.edgeAccentMaterial?.metalness).toBeLessThan(.3)
    expect(llmAnimeTheme.table.machineTop.clearcoat).toBeLessThan(.1)
    expect(llmAnimeTheme.table.gold.metalness).toBeLessThan(.3)
    expect(llmAnimeTheme.woodTrim).toBe(false)
    expect(llmAnimeTheme.tileBackGradient).toEqual(['#bd5b48', '#bd5b48', '#bd5b48'])
    expect(llmAnimeTheme.tileFaceGradient).toEqual(['#f8f5ed', '#e8e5dc', '#cfd2ca'])
    expect(llmAnimeTheme.tileAoIntensity).toBe(.32)
    expect(llmAnimeTheme.tile.faceSide.roughness).toBeGreaterThanOrEqual(.15)
    expect(llmAnimeTheme.tile.faceSide.roughness).toBeLessThanOrEqual(.22)
    expect(llmAnimeTheme.tile.faceSide.clearcoat).toBe(1)
    expect(llmAnimeTheme.tile.faceSide.clearcoatRoughness).toBe(.1)
    expect(llmAnimeTheme.tile.face.clearcoat).toBe(1)
    expect(llmAnimeTheme.tile.back.clearcoat).toBe(1)
    expect(llmAnimeTheme.tile.faceSide.envMapIntensity).toBeGreaterThan(0)
    expect(llmAnimeTheme.tableSurfaceTexture?.url).toMatch(/themes\/llm-anime\/v1\/table-felt\.png$/)
    expect(llmAnimeTheme.tableSurfaceTexture?.tint).toBe(0xffffff)
  })

  it('固定群像桌布不绑定任何本家角色 ID', () => {
    const surfaceUrl = llmAnimeTheme.tableSurfaceTexture?.url ?? ''
    expect(surfaceUrl).toMatch(/llm-anime\/v1\/table-felt\.png$/)
    expect(ANIME_CHARACTER_IDS.every((characterId) => !surfaceUrl.includes(characterId))).toBe(true)
  })
})
