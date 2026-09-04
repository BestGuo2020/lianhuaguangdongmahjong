import { TABLE_THEME_OPTIONS, type TableThemeName } from './tableTheme'

export const TABLE_THEME_PREFERENCE_STORAGE_KEY = 'lianhua-guangma:table-theme:v1'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface InitialTableTheme {
  theme: TableThemeName
  explicit: boolean
}

export function isTableThemeName(value: string | null | undefined): value is TableThemeName {
  return TABLE_THEME_OPTIONS.some((option) => option.value === value)
}

/** 读取持久化主题；旧主题或损坏值迁移到默认墨玉，存储不可用时静默降级。 */
export function readTableThemePreference(
  storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): TableThemeName | null {
  if (!storage) return null
  try {
    const stored = storage.getItem(TABLE_THEME_PREFERENCE_STORAGE_KEY)
    if (stored === null) return null
    const theme = isTableThemeName(stored) ? stored : 'jade'
    if (stored !== theme) storage.setItem(TABLE_THEME_PREFERENCE_STORAGE_KEY, theme)
    return theme
  } catch {
    return null
  }
}

/** 保存主题时同样执行白名单收敛，避免无效值进入下一次启动。 */
export function saveTableThemePreference(
  value: unknown,
  storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): TableThemeName {
  const theme = typeof value === 'string' && isTableThemeName(value) ? value : 'jade'
  try { storage?.setItem(TABLE_THEME_PREFERENCE_STORAGE_KEY, theme) } catch { /* 存储不可用不影响牌局 */ }
  return theme
}

/** URL 优先于本地偏好；显式无效值稳定回退墨玉，缺省时才允许 LLM 自动推荐。 */
export function resolveInitialTableTheme(
  value: string | null | undefined,
  storedPreference: string | null | undefined = null,
): InitialTableTheme {
  if (value != null) {
    return { theme: isTableThemeName(value) ? value : 'jade', explicit: true }
  }
  if (storedPreference != null) {
    return { theme: isTableThemeName(storedPreference) ? storedPreference : 'jade', explicit: true }
  }
  return { theme: 'jade', explicit: false }
}

/** LLM 主题只是默认推荐：任何明确选择都必须优先，关闭 LLM 也不强制切回。 */
export function shouldAutoUseLlmTheme(llmEnabled: boolean, explicitThemeSelected: boolean): boolean {
  return llmEnabled && !explicitThemeSelected
}
