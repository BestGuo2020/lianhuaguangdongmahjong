import { playDecisionSpeech } from './decisionSpeechPlayback'
// LLM 运行时装配 —— 供 App.vue 在创建本地人机引擎时注入 AI 控制器（座位 1-3）。
// 决策：读取 v2 配置（readLlmSettings），支持**每个座位使用不同预置与不同风格**（未指定则跟随默认）。
// 启用且已填 Key 时才返回 LLM 控制器，否则返回 null（引擎沿用默认启发式 AI）。
// 配置保存后由 App 重新装配到尚未开局的本地引擎。stats 用 reactive 包装：设置面板的 computed 依赖它才能实时刷新。
import { reactive } from 'vue'
import type { PlayerController } from '../core/controllers/playerController'
import type { LotusController } from '../variants/lotus/lotusControllers'
import type { PlayerSeed } from '../shared/runtime/localOpening'
import { CoreLlmController, LotusLlmController, createLlmStats, type LlmControllerHooks, type LlmControllerStats, type LlmMessageMeta } from './llmController'
import { LLM_DECISION_TIMEOUT_MS, presetForSeat, readLlmSettings, styleForSeat, type LlmProviderPreset, type LlmSettings } from './config'
import { avatarFolderOf, avatarFor, displayNameOf, effectiveNickname } from './persona'
import { materializeImages } from '../core/presentation/imagePreload'
import { resolveAnimeCharacterId } from './animeCharacters'
import { clearLocalLlmVoiceSeats, registerLocalLlmVoiceSeat } from '../core/presentation/localLlmVoiceRegistry'
import { getLocalTtsClient, resolveLocalTtsVoiceKey } from './localTtsClient'
import { compactLlmSpeechText, LlmSpeechPolicy } from './speechPolicy'
import { ConditionalReasoningCoordinator } from './conditionalReasoning'
import { reasoningStatusSpeech } from './decisionSpeech'

const MIN_ROUND_REACTION_MS = 1_200
const LLM_ANIME_FIXED_SPEECH_ACTIONS = new Set<NonNullable<LlmMessageMeta['actionKind']>>([
  'gang', 'peng', 'chi', 'added-kong', 'concealed-kong', 'wind-kong', 'win',
])

export interface LocalLlmRuntimeOptions {
  /** 每次发言时动态读取；未提供或读取失败时保持 legacy 语音行为。 */
  getThemeName?: () => string | null | undefined
}

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
  const seed: PlayerSeed = {
    name: displayNameOf(effectiveNickname(preset), style),
    avatar: avatarFor(preset, style),
    isLlm: true,
    characterId: resolveAnimeCharacterId(avatarFolderOf(preset)),
    playerKind: 'llm',
  }
  // 人设头像（img/llm/<供应商>/llm-avatar-<风格>.png）按座位预热：只取实际会用到的那几张，
  // 避免牌桌首次渲染（LLM 座位第一次出现）才开始下载；不做供应商×风格全量预取。
  // 用「物化」（blob + 预热解码）而不是只进 HTTP 缓存：托管方新鲜期只有 60s，座位头像晚于
  // 这个时间首次渲染时仍要发一次 304 校验（实测单次 0.5~1.9s），头像会明显迟到。
  void materializeImages([seed.avatar])
  return seed
}

function baseRuntime(): { settings: LlmSettings; stats: LlmControllerStats } {
  const settings = readLlmSettings()
  const stats = reactive(createLlmStats())
  return { settings, stats }
}

/** llmAnime 的动作与赛后人声由固定台词模块承担，模型自由文案不得重复播报。 */
export function shouldSuppressLlmAnimeDynamicSpeech(
  themeName: string | null | undefined,
  meta: LlmMessageMeta | undefined,
): boolean {
  if (themeName !== 'llmAnime' || !meta) return false
  return meta.source === 'win'
    || Boolean(meta.actionKind && LLM_ANIME_FIXED_SPEECH_ACTIONS.has(meta.actionKind))
}

function themeNameOf(options: LocalLlmRuntimeOptions): string | null | undefined {
  try {
    return options.getThemeName?.()
  } catch {
    // 主题是表现依赖；getter 异常不能影响模型动作和 legacy 语音回退。
    return undefined
  }
}

function hooksForSeat(
  preset: LlmProviderPreset,
  style: LlmProviderPreset['style'],
  hooks: LlmControllerHooks,
  speechPolicy: LlmSpeechPolicy,
  options: LocalLlmRuntimeOptions,
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
    if (shouldSuppressLlmAnimeDynamicSpeech(themeNameOf(options), meta)) return
    const { priority, admitted } = admission(seat, meta)
    if (!admitted) return
    const compact = compactLlmSpeechText(text)
    if (!compact) return
    const roundReaction = meta?.source === 'win'
    const startedAt = Date.now()
    await playDecisionSpeech({seat,text:compact,voiceKey,style,priority,
      showBubble:()=>{void hooks.onLlmMessage?.(seat,compact,meta)},waitForCompletion:roundReaction})
    if (roundReaction) {
      const remaining = MIN_ROUND_REACTION_MS - (Date.now() - startedAt)
      if (remaining > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, remaining))
    }
  }
  return {
    onLlmMessage: deliver,
    // AI 分析记录接缝（§5）：按座位原样转发。这里**必须**显式转发 —— hooksForSeat 会新建一个
    // 对象并逐个列出键，漏掉就等于把调用方传进来的钩子静默丢掉（分析侧只会看到"没有任何尝试"）。
    // 转发不做任何加工：候选、变量、模板 id 都是 llmController 侧的原始值。
    ...(hooks.onDecisionRequest ? { onDecisionRequest: hooks.onDecisionRequest } : {}),
    ...(hooks.onDecisionAnswer ? { onDecisionAnswer: hooks.onDecisionAnswer } : {}),
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
export function createLocalLlmControllers(
  hooks: LlmControllerHooks = {},
  options: LocalLlmRuntimeOptions = {},
): LocalLlmRuntime<PlayerController> {
  const { settings, stats } = baseRuntime()
  const usable = settings.enabled && settings.presets.length > 0
  clearLocalLlmVoiceSeats()
  if (!usable) return { controllers: null, seeds: [], stats, enabled: false }
  const speechPolicy = new LlmSpeechPolicy()
  const reasoning = new ConditionalReasoningCoordinator()
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    const style = styleForSeat(settings, seat) ?? preset.style
    const seatHooks = hooksForSeat(preset, style, hooks, speechPolicy, options)
    registerLocalLlmVoiceSeat(seat, style, (text) => seatHooks.onLlmMessage?.(seat, text, {
      priority: 'important', source: 'win',
    }))
    return new CoreLlmController(toProviderConfig(preset, style), seatHooks, stats, reasoning)
  })
  const seeds = ([1, 2, 3] as const).map((seat) => seedFor(settings, seat))
  return { controllers, seeds, stats, enabled: true }
}

/** 莲花麻将（lotus-legacy）本地人机座位 1-3 的 LLM 控制器（按座位预置+风格装配）。 */
export function createLotusLlmControllers(
  hooks: LlmControllerHooks = {},
  options: LocalLlmRuntimeOptions = {},
): LocalLlmRuntime<LotusController> {
  const { settings, stats } = baseRuntime()
  const usable = settings.enabled && settings.presets.length > 0
  clearLocalLlmVoiceSeats()
  if (!usable) return { controllers: null, seeds: [], stats, enabled: false }
  const speechPolicy = new LlmSpeechPolicy()
  const reasoning = new ConditionalReasoningCoordinator()
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const preset = presetForSeat(settings, seat) ?? settings.presets[0]
    const style = styleForSeat(settings, seat) ?? preset.style
    const seatHooks = hooksForSeat(preset, style, hooks, speechPolicy, options)
    registerLocalLlmVoiceSeat(seat, style, (text) => seatHooks.onLlmMessage?.(seat, text, {
      priority: 'important', source: 'win',
    }))
    return new LotusLlmController(toProviderConfig(preset, style), seatHooks, stats, reasoning)
  })
  const seeds = ([1, 2, 3] as const).map((seat) => seedFor(settings, seat))
  return { controllers, seeds, stats, enabled: true }
}
