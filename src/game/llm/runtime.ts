// LLM 运行时装配 —— 供 App.vue 在创建本地人机引擎时注入 AI 控制器（座位 1-3）。
// 决策：读取 v2 配置（readLlmSettings），支持**每个座位使用不同预置与不同风格**（未指定则跟随默认）。
// 启用且已填 Key 时才返回 LLM 控制器，否则返回 null（引擎沿用默认启发式 AI）。
// 配置变更后刷新页面生效。stats 用 reactive 包装：设置面板的 computed 依赖它才能实时刷新。
import { reactive } from 'vue'
import type { PlayerController } from '../core/controllers/playerController'
import type { LotusController } from '../variants/lotus/lotusControllers'
import { CoreLlmController, LotusLlmController, createLlmStats, type LlmControllerHooks, type LlmControllerStats } from './llmController'
import { presetForSeat, readLlmSettings, styleForSeat, type LlmProviderPreset, type LlmSettings } from './config'

export interface LocalLlmRuntime<C> {
  controllers: C[] | null
  stats: LlmControllerStats
  enabled: boolean
}

function toProviderConfig(preset: LlmProviderPreset, style: LlmProviderPreset['style']) {
  return {
    baseUrl: preset.baseUrl,
    apiKey: preset.apiKey,
    model: preset.model,
    style,
    timeoutMs: preset.timeoutMs,
  }
}

function baseRuntime(): { settings: LlmSettings; stats: LlmControllerStats } {
  const settings = readLlmSettings()
  const stats = reactive(createLlmStats())
  return { settings, stats }
}

/** 莲花广麻（lotus-classic）本地人机座位 1-3 的 LLM 控制器（按座位预置+风格装配）。 */
export function createLocalLlmControllers(hooks: LlmControllerHooks = {}): LocalLlmRuntime<PlayerController> {
  const { settings, stats } = baseRuntime()
  const usable = settings.enabled && settings.presets.length > 0
  if (!usable) return { controllers: null, stats, enabled: false }
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    return new CoreLlmController(toProviderConfig(preset, styleForSeat(settings, seat) ?? preset.style), hooks, stats)
  })
  return { controllers, stats, enabled: true }
}

/** 莲花麻将（lotus-legacy）本地人机座位 1-3 的 LLM 控制器（按座位预置+风格装配）。 */
export function createLotusLlmControllers(hooks: LlmControllerHooks = {}): LocalLlmRuntime<LotusController> {
  const { settings, stats } = baseRuntime()
  const usable = settings.enabled && settings.presets.length > 0
  if (!usable) return { controllers: null, stats, enabled: false }
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    return new LotusLlmController(toProviderConfig(preset, styleForSeat(settings, seat) ?? preset.style), hooks, stats)
  })
  return { controllers, stats, enabled: true }
}
