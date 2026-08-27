// LLM 运行时装配 —— 供 App.vue 在创建本地人机引擎时注入 AI 控制器（座位 1-3）。
// 决策：读取 v2 配置（readLlmSettings），支持**每个座位使用不同预置与不同风格**（未指定则跟随默认）。
// 启用且已填 Key 时才返回 LLM 控制器，否则返回 null（引擎沿用默认启发式 AI）。
// 配置保存后由 App 重新装配到尚未开局的本地引擎。stats 用 reactive 包装：设置面板的 computed 依赖它才能实时刷新。
import { reactive } from 'vue'
import type { PlayerController } from '../core/controllers/playerController'
import type { LotusController } from '../variants/lotus/lotusControllers'
import type { PlayerSeed } from '../shared/runtime/localOpening'
import { CoreLlmController, LotusLlmController, createLlmStats, type LlmControllerHooks, type LlmControllerStats } from './llmController'
import { LLM_DECISION_TIMEOUT_MS, presetForSeat, readLlmSettings, styleForSeat, type LlmProviderPreset, type LlmSettings } from './config'
import { avatarFor, displayNameOf, effectiveNickname } from './persona'
import { clearLocalLlmVoiceSeats, registerLocalLlmVoiceSeat } from '../core/presentation/localLlmVoiceRegistry'
import { getLocalTtsClient, resolveLocalTtsVoiceKey } from './localTtsClient'
import { compactLlmSpeechText, LlmSpeechPolicy } from './speechPolicy'

export interface LocalLlmRuntime<C> {
  controllers: C[] | null
  /** 座位 1-3 的玩家形象（昵称（策略）/策略头像）；未启用时为空数组 */
  seeds: PlayerSeed[]
  stats: LlmControllerStats
  enabled: boolean
}

function toProviderConfig(preset: LlmProviderPreset, style: LlmProviderPreset['style']) {
  return {
    providerType: preset.providerType,
    baseUrl: preset.baseUrl,
    apiKey: preset.apiKey,
    model: preset.model,
    style,
    timeoutMs: LLM_DECISION_TIMEOUT_MS,
  }
}

/** 座位形象：昵称（策略）+ 策略头像。 */
function seedFor(settings: LlmSettings, seat: 1 | 2 | 3): PlayerSeed {
  const preset = presetForSeat(settings, seat) ?? settings.presets[0]
  const style = styleForSeat(settings, seat) ?? preset.style
  return { name: displayNameOf(effectiveNickname(preset), style), avatar: avatarFor(preset, style) }
}

function baseRuntime(): { settings: LlmSettings; stats: LlmControllerStats } {
  const settings = readLlmSettings()
  const stats = reactive(createLlmStats())
  return { settings, stats }
}

function hooksForSeat(
  preset: LlmProviderPreset,
  style: LlmProviderPreset['style'],
  hooks: LlmControllerHooks,
  speechPolicy: LlmSpeechPolicy,
): LlmControllerHooks {
  const voiceKey = resolveLocalTtsVoiceKey(preset)
  const deliver: NonNullable<LlmControllerHooks['onLlmMessage']> = async (seat, text, meta) => {
    const priority = meta?.priority ?? 'normal'
    if (!speechPolicy.admit({ seat, style, priority })) return
    const compact = compactLlmSpeechText(text)
    if (!compact) return
    let bubbleShown = false
    const showBubble = () => {
      if (bubbleShown) return
      bubbleShown = true
      try { void hooks.onLlmMessage?.(seat, compact, meta) } catch { /* 展示失败不阻塞动作 */ }
    }
    // 有声时：playing 事件显示气泡，中点 Promise 放行动作；静音/失败时不走音频并立即显示气泡。
    await getLocalTtsClient().speak(seat, compact, voiceKey, style, priority, { onStarted: showBubble })
    if (!bubbleShown) showBubble()
  }
  return {
    onLlmMessage: deliver,
    onReset: () => {
      getLocalTtsClient().cancel()
      speechPolicy.reset()
    },
  }
}

/** 莲花广麻（lotus-classic）本地人机座位 1-3 的 LLM 控制器（按座位预置+风格装配）。 */
export function createLocalLlmControllers(hooks: LlmControllerHooks = {}): LocalLlmRuntime<PlayerController> {
  const { settings, stats } = baseRuntime()
  const usable = settings.enabled && settings.presets.length > 0
  clearLocalLlmVoiceSeats()
  if (!usable) return { controllers: null, seeds: [], stats, enabled: false }
  const speechPolicy = new LlmSpeechPolicy()
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    const style = styleForSeat(settings, seat) ?? preset.style
    const seatHooks = hooksForSeat(preset, style, hooks, speechPolicy)
    registerLocalLlmVoiceSeat(seat, style, (text) => seatHooks.onLlmMessage?.(seat, text, {
      priority: 'important', source: 'win',
    }))
    return new CoreLlmController(toProviderConfig(preset, style), seatHooks, stats)
  })
  const seeds = ([1, 2, 3] as const).map((seat) => seedFor(settings, seat))
  return { controllers, seeds, stats, enabled: true }
}

/** 莲花麻将（lotus-legacy）本地人机座位 1-3 的 LLM 控制器（按座位预置+风格装配）。 */
export function createLotusLlmControllers(hooks: LlmControllerHooks = {}): LocalLlmRuntime<LotusController> {
  const { settings, stats } = baseRuntime()
  const usable = settings.enabled && settings.presets.length > 0
  clearLocalLlmVoiceSeats()
  if (!usable) return { controllers: null, seeds: [], stats, enabled: false }
  const speechPolicy = new LlmSpeechPolicy()
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    const style = styleForSeat(settings, seat) ?? preset.style
    const seatHooks = hooksForSeat(preset, style, hooks, speechPolicy)
    registerLocalLlmVoiceSeat(seat, style, (text) => seatHooks.onLlmMessage?.(seat, text, {
      priority: 'important', source: 'win',
    }))
    return new LotusLlmController(toProviderConfig(preset, style), seatHooks, stats)
  })
  const seeds = ([1, 2, 3] as const).map((seat) => seedFor(settings, seat))
  return { controllers, seeds, stats, enabled: true }
}
