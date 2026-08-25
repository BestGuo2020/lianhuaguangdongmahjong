import { TABLE_THEME_OPTIONS, type TableThemeName } from './tableTheme'

export interface InitialTableTheme {
  theme: TableThemeName
  explicit: boolean
}

export function isTableThemeName(value: string | null | undefined): value is TableThemeName {
  return TABLE_THEME_OPTIONS.some((option) => option.value === value)
}

/** URL 中的合法主题视为用户明确选择；否则先使用默认墨玉，稍后再按 LLM 状态自动推荐。 */
export function resolveInitialTableTheme(value: string | null | undefined): InitialTableTheme {
  return isTableThemeName(value)
    ? { theme: value, explicit: true }
    : { theme: 'jade', explicit: false }
}

/** LLM 主题只是默认推荐：任何明确选择都必须优先，关闭 LLM 也不强制切回。 */
export function shouldAutoUseLlmTheme(llmEnabled: boolean, explicitThemeSelected: boolean): boolean {
  return llmEnabled && !explicitThemeSelected
}
