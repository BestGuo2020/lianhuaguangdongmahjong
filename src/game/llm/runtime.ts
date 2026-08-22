// LLM 运行时装配 —— 供 App.vue 在创建本地人机引擎时注入 AI 控制器（座位 1-3）。
// 决策：读取 v2 配置（readLlmSettings），支持**每个座位使用不同预置与不同风格**（未指定则跟随默认）。
// 启用且已填 Key 时才返回 LLM 控制器，否则返回 null（引擎沿用默认启发式 AI）。
// 配置变更后刷新页面生效。stats 用 reactive 包装：设置面板的 computed 依赖它才能实时刷新。
import { reactive } from 'vue'
import type { PlayerController } from '../core/controllers/playerController'
import type { LotusController } from '../variants/lotus/lotusControllers'
import type { PlayerSeed } from '../shared/runtime/localOpening'
import { CoreLlmController, LotusLlmController, createLlmStats, type LlmControllerHooks, type LlmControllerStats } from './llmController'
import { presetForSeat, readLlmSettings, styleForSeat, type LlmProviderPreset, type LlmSettings } from './config'
import { avatarFor, displayNameOf, effectiveNickname } from './persona'

export interface LocalLlmRuntime<C> {
  controllers: C[] | null
  /** 座位 1-3 的玩家形象（昵称（策略）/策略头像）；未启用时为空数组 */
  seeds: PlayerSeed[]
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

/** 座位形象：昵称（策略）+ 策略头像。 */
function seedFor(settings: LlmSettings, seat: 1 | 2 | 3): PlayerSeed {
  const preset = presetForSeat(settings, seat) ?? settings.presets[0]
  const style = styleForSeat(settings, seat) ?? preset.style
  return { name: displayNameOf(effectiveNickname(preset), style), avatar: avatarFor(preset.baseUrl, style) }
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
  if (!usable) return { controllers: null, seeds: [], stats, enabled: false }
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    return new CoreLlmController(toProviderConfig(preset, styleForSeat(settings, seat) ?? preset.style), hooks, stats)
  })
  const seeds = ([1, 2, 3] as const).map((seat) => seedFor(settings, seat))
  return { controllers, seeds, stats, enabled: true }
}

/** 莲花麻将（lotus-legacy）本地人机座位 1-3 的 LLM 控制器（按座位预置+风格装配）。 */
export function createLotusLlmControllers(hooks: LlmControllerHooks = {}): LocalLlmRuntime<LotusController> {
  const { settings, stats } = baseRuntime()
  const usable = settings.enabled && settings.presets.length > 0
  if (!usable) return { controllers: null, seeds: [], stats, enabled: false }
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    return new LotusLlmController(toProviderConfig(preset, styleForSeat(settings, seat) ?? preset.style), hooks, stats)
  })
  const seeds = ([1, 2, 3] as const).map((seat) => seedFor(settings, seat))
  return { controllers, seeds, stats, enabled: true }
}
