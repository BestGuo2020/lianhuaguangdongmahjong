export const TABLE_THEME_OPTIONS = [
  { value: 'jade', label: '默认墨玉', description: '深色玉石、硬质结构与克制金属高光' },
  { value: 'happyMahjong', label: '欢乐麻将', description: '明快色块、圆润按钮与轻快节奏' },
  { value: 'rosewood', label: '红木金丝', description: '温润红木、黄铜细节与暖色漆面' },
  { value: 'llm', label: '大模型专属', description: '深蓝星轨、数据线与模型对抗' },
  { value: 'llmAnime', label: '大模型二次元', description: '角色群像、漫画字效与动作演出' },
] as const

export type TableThemeName = typeof TABLE_THEME_OPTIONS[number]['value']

export const TABLE_THEME_NAMES = TABLE_THEME_OPTIONS.map(({ value }) => value) as TableThemeName[]

export function isTableThemeName(value: string | null | undefined): value is TableThemeName {
  return TABLE_THEME_NAMES.some((themeName) => themeName === value)
}

export function tableThemeIdentity(name: TableThemeName) {
  return TABLE_THEME_OPTIONS.find((option) => option.value === name)!
}
