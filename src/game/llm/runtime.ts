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
import { avatarFolderOf, avatarFor, displayNameOf, effectiveNickname } from './persona'
import { resolveAnimeCharacterId } from './animeCharacters'
import { clearLocalLlmVoiceSeats, registerLocalLlmVoiceSeat } from '../core/presentation/localLlmVoiceRegistry'
import { getLocalTtsClient, resolveLocalTtsVoiceKey } from './localTtsClient'
import { compactLlmSpeechText, LlmSpeechPolicy } from './speechPolicy'
import { ConditionalReasoningCoordinator } from './conditionalReasoning'
import { reasoningStatusSpeech } from './decisionSpeech'

const MIN_ROUND_REACTION_MS = 1_200

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
    timeoutEnabled: preset.timeoutEnabled !== false,
  }
}

/** 座位形象：昵称（策略）+ 策略头像。 */
function seedFor(settings: LlmSettings, seat: 1 | 2 | 3): PlayerSeed {
  const preset = presetForSeat(settings, seat) ?? settings.presets[0]
  const style = styleForSeat(settings, seat) ?? preset.style
  return {
    name: displayNameOf(effectiveNickname(preset), style),
    avatar: avatarFor(preset, style),
    isLlm: true,
    characterId: resolveAnimeCharacterId(avatarFolderOf(preset)),
    playerKind: 'llm',
  }
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
  let reasoningStatusSequence = 0
  const admission = (seat: number, meta: Parameters<NonNullable<LlmControllerHooks['onLlmMessage']>>[2]) => {
    const priority = meta?.priority ?? 'normal'
    if (meta?.source === 'win') return { priority, admitted: true }
    const mandatory = style === '话痨'
      && (meta?.source === 'decision' || meta?.source === 'fallback')
      && meta.decision === 'turn'
      && meta.actionKind === 'discard'
    return { priority, admitted: speechPolicy.admit({ seat, style, priority, mandatory }) }
  }
  const deliver: NonNullable<LlmControllerHooks['onLlmMessage']> = async (seat, text, meta) => {
    const { priority, admitted } = admission(seat, meta)
    if (!admitted) return
    const compact = compactLlmSpeechText(text)
    if (!compact) return
    const roundReaction = meta?.source === 'win'
    const startedAt = Date.now()
    let bubbleShown = false
    const showBubble = () => {
      if (bubbleShown) return
      bubbleShown = true
      try { void hooks.onLlmMessage?.(seat, compact, meta) } catch { /* 展示失败不阻塞动作 */ }
    }
    // 有声时：playing 事件显示气泡，中点 Promise 放行动作；静音/失败时不走音频并立即显示气泡。
    await getLocalTtsClient().speak(seat, compact, voiceKey, style, priority, {
      onStarted: showBubble,
      waitForCompletion: roundReaction,
    })
    if (!bubbleShown) showBubble()
    if (roundReaction) {
      const remaining = MIN_ROUND_REACTION_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, remaining))
    }
  }
  return {
    onLlmMessage: deliver,
    onLlmFallback: (seat, meta) => {
      if (!admission(seat, meta).admitted) return
      try { void hooks.onLlmMessage?.(seat, '？', meta) } catch { /* 回退气泡不影响引擎动作 */ }
    },
    onLlmStatus: (seat, active, safeProgressText) => {
      if (!active) {
        try { void hooks.onLlmStatus?.(seat, false) } catch { /* 状态气泡不影响决策 */ }
        return
      }
      // 安全进度只更新文字气泡；原始推理不出客户端层，也不进入 TTS/历史/限流。
      if (safeProgressText) {
        try { void hooks.onLlmStatus?.(seat, true, safeProgressText) } catch { /* 状态气泡不影响决策 */ }
        return
      }
      const text = reasoningStatusSpeech(style, reasoningStatusSequence)
      reasoningStatusSequence += 1
      try { void hooks.onLlmStatus?.(seat, true, text) } catch { /* 状态气泡不影响决策 */ }
      // 状态台词与模型请求并行，不让 TTS 合成占用 40 秒推理预算。
      if (hooks.onLlmStatus) {
        void getLocalTtsClient().speak(seat, text, voiceKey, style, 'normal').catch(() => false)
      }
    },
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
  const reasoning = new ConditionalReasoningCoordinator()
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    const style = styleForSeat(settings, seat) ?? preset.style
    const seatHooks = hooksForSeat(preset, style, hooks, speechPolicy)
    registerLocalLlmVoiceSeat(seat, style, (text) => seatHooks.onLlmMessage?.(seat, text, {
      priority: 'important', source: 'win',
    }))
    return new CoreLlmController(toProviderConfig(preset, style), seatHooks, stats, reasoning)
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
  const reasoning = new ConditionalReasoningCoordinator()
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    const style = styleForSeat(settings, seat) ?? preset.style
    const seatHooks = hooksForSeat(preset, style, hooks, speechPolicy)
    registerLocalLlmVoiceSeat(seat, style, (text) => seatHooks.onLlmMessage?.(seat, text, {
      priority: 'important', source: 'win',
    }))
    return new LotusLlmController(toProviderConfig(preset, style), seatHooks, stats, reasoning)
  })
  const seeds = ([1, 2, 3] as const).map((seat) => seedFor(settings, seat))
  return { controllers, seeds, stats, enabled: true }
}
