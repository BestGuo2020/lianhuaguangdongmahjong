import type { PlayerController } from '../../core/controllers/playerController'
import { AiController } from '../../core/controllers/playerController'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import type { PlayerSeed } from '../../shared/runtime/localOpening'
import type { LotusController } from '../../variants/lotus/lotusControllers'
import { LotusAiController } from '../../variants/lotus/lotusControllers'
import {
  LLM_DECISION_TIMEOUT_MS,
  presetForSeat,
  readLlmSettings,
  type LlmProviderPreset,
  type LlmSettings,
  type LlmStyle,
  type LlmTtsVoiceKey,
} from '../../llm/config'
import {
  CoreLlmController,
  LotusLlmController,
  createLlmStats,
  type LlmControllerStats,
  type LlmMessageMeta,
} from '../../llm/llmController'
import { resolveLocalTtsVoiceKey } from '../../llm/localTtsClient'
import { avatarFor, displayNameOf, effectiveNickname } from '../../llm/persona'
import { compactLlmSpeechText, LlmSpeechPolicy, type LlmSpeechPriority } from '../../llm/speechPolicy'

export const VIBE_LLM_STYLES: LlmStyle[] = ['激进', '稳健', '话痨', '高冷']

/** 房主浏览器私有选择。presetId 只用于读取本机 localStorage，绝不进入 P2P。 */
export interface HostLlmSeatSelection {
  seat: 1 | 2 | 3
  presetId: string
  style: LlmStyle
}

/** 大厅下拉框使用的房主本地选项。 */
export interface HostLlmOption {
  presetId: string
  style: LlmStyle
  nickname: string
  displayName: string
  model: string
  avatar: string
}

/** 可通过 P2P 公布的 AI 身份；不含 key、Base URL、预置 id 或提示词。 */
export interface PublicAiSeat {
  seat: 1 | 2 | 3
  kind: 'llm'
  nickname: string
  displayName: string
  avatar: string
  model: string
  style: LlmStyle
  voiceKey: Exclude<LlmTtsVoiceKey, 'auto'>
}

function usablePreset(preset: LlmProviderPreset | null | undefined): preset is LlmProviderPreset {
  return Boolean(preset?.apiKey.trim() && preset.baseUrl.trim() && preset.model.trim())
}

function presetById(settings: LlmSettings, presetId: string): LlmProviderPreset | null {
  return settings.presets.find((preset) => preset.id === presetId) ?? null
}

function publicSeatOf(seat: 1 | 2 | 3, preset: LlmProviderPreset, style: LlmStyle): PublicAiSeat {
  const nickname = effectiveNickname(preset)
  return {
    seat,
    kind: 'llm',
    nickname,
    displayName: displayNameOf(nickname, style),
    avatar: avatarFor(preset, style),
    model: preset.model,
    style,
    voiceKey: resolveLocalTtsVoiceKey(preset),
  }
}

export function listHostLlmOptions(settings: LlmSettings = readLlmSettings()): HostLlmOption[] {
  if (!settings.enabled) return []
  return settings.presets.filter(usablePreset).flatMap((preset) => VIBE_LLM_STYLES.map((style) => {
    const profile = publicSeatOf(1, preset, style)
    return {
      presetId: preset.id,
      style,
      nickname: profile.nickname,
      displayName: profile.displayName,
      model: profile.model,
      avatar: profile.avatar,
    }
  }))
}

export function resolveHostLlmSelections(
  raw: readonly HostLlmSeatSelection[],
  occupiedSeats: ReadonlySet<number>,
  settings: LlmSettings = readLlmSettings(),
): { privateSeats: HostLlmSeatSelection[]; publicSeats: PublicAiSeat[] } {
  if (!settings.enabled) return { privateSeats: [], publicSeats: [] }
  const seen = new Set<number>()
  const privateSeats: HostLlmSeatSelection[] = []
  const publicSeats: PublicAiSeat[] = []
  for (const item of raw) {
    // 房主也是真人，联机至少两名真人开局，因此最多只能硬预留两个 AI 座位。
    if (privateSeats.length >= 2) break
    if (![1, 2, 3].includes(item.seat) || seen.has(item.seat) || occupiedSeats.has(item.seat)) continue
    if (!VIBE_LLM_STYLES.includes(item.style)) continue
    const preset = presetById(settings, item.presetId)
    if (!usablePreset(preset)) continue
    seen.add(item.seat)
    privateSeats.push({ seat: item.seat, presetId: preset.id, style: item.style })
    publicSeats.push(publicSeatOf(item.seat, preset, item.style))
  }
  return { privateSeats, publicSeats }
}

interface RuntimeHooks {
  onMessage(seat: number, text: string, profile: PublicAiSeat, priority: LlmSpeechPriority): void
}

export interface VibeHostLlmRuntime<C> {
  controllers: C[]
  seeds: Array<PlayerSeed | undefined>
  profiles: Map<number, PublicAiSeat>
  stats: LlmControllerStats
}

function providerConfig(preset: LlmProviderPreset, style: LlmStyle) {
  return {
    baseUrl: preset.baseUrl,
    apiKey: preset.apiKey,
    model: preset.model,
    style,
    timeoutMs: LLM_DECISION_TIMEOUT_MS,
  }
}

function selectedProfiles(
  selections: readonly HostLlmSeatSelection[],
  settings: LlmSettings,
): Map<number, { preset: LlmProviderPreset; profile: PublicAiSeat }> {
  const profiles = new Map<number, { preset: LlmProviderPreset; profile: PublicAiSeat }>()
  for (const selection of selections) {
    const preset = presetById(settings, selection.presetId)
    if (!usablePreset(preset)) continue
    profiles.set(selection.seat, {
      preset,
      profile: publicSeatOf(selection.seat, preset, selection.style),
    })
  }
  return profiles
}

function seedsOf(profiles: Map<number, { profile: PublicAiSeat }>): Array<PlayerSeed | undefined> {
  return ([1, 2, 3] as const).map((seat) => {
    const profile = profiles.get(seat)?.profile
    return profile ? { name: profile.displayName, avatar: profile.avatar, isLlm: true } : undefined
  })
}

export function createVibeCoreLlmRuntime(
  selections: readonly HostLlmSeatSelection[],
  hooks: RuntimeHooks,
  settings: LlmSettings = readLlmSettings(),
): VibeHostLlmRuntime<PlayerController> {
  const selected = selectedProfiles(selections, settings)
  const stats = createLlmStats()
  const speechPolicy = new LlmSpeechPolicy()
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const item = selected.get(seat)
    return item
      ? new CoreLlmController(providerConfig(item.preset, item.profile.style), {
          onLlmMessage: (speaker, text, meta?: LlmMessageMeta) => {
            const priority = meta?.priority ?? 'normal'
            if (!speechPolicy.admit({ seat: speaker, style: item.profile.style, priority })) return
            const compact = compactLlmSpeechText(text)
            if (compact) hooks.onMessage(speaker, compact, item.profile, priority)
          },
        }, stats)
      : new AiController()
  })
  return {
    controllers,
    seeds: seedsOf(selected),
    profiles: new Map([...selected].map(([seat, item]) => [seat, item.profile])),
    stats,
  }
}

export function createVibeLotusLlmRuntime(
  selections: readonly HostLlmSeatSelection[],
  hooks: RuntimeHooks,
  settings: LlmSettings = readLlmSettings(),
): VibeHostLlmRuntime<LotusController> {
  const selected = selectedProfiles(selections, settings)
  const stats = createLlmStats()
  const speechPolicy = new LlmSpeechPolicy()
  const controllers = ([1, 2, 3] as const).map((seat) => {
    const item = selected.get(seat)
    return item
      ? new LotusLlmController(providerConfig(item.preset, item.profile.style), {
          onLlmMessage: (speaker, text, meta?: LlmMessageMeta) => {
            const priority = meta?.priority ?? 'normal'
            if (!speechPolicy.admit({ seat: speaker, style: item.profile.style, priority })) return
            const compact = compactLlmSpeechText(text)
            if (compact) hooks.onMessage(speaker, compact, item.profile, priority)
          },
        }, stats)
      : new LotusAiController()
  })
  return {
    controllers,
    seeds: seedsOf(selected),
    profiles: new Map([...selected].map(([seat, item]) => [seat, item.profile])),
    stats,
  }
}

const WIN_LINES: Record<'self-draw' | 'discard-win' | 'robbed-kong-win', Record<LlmStyle, string>> = {
  'self-draw': {
    激进: '自摸！这局我收下了！', 稳健: '自摸，稳稳收下。', 话痨: '自摸啦！这手终于等到了！', 高冷: '自摸。',
  },
  'discard-win': {
    激进: '吃胡！这张我等很久了！', 稳健: '吃胡，多谢送牌。', 话痨: '吃胡啦！这张正好送到手上！', 高冷: '吃胡。',
  },
  'robbed-kong-win': {
    激进: '抢杠胡！这杠开不得！', 稳健: '抢杠胡，时机刚好。', 话痨: '抢杠胡啦！这张我可等着呢！', 高冷: '抢杠胡。',
  },
}

export function vibeLlmWinLine(type: keyof typeof WIN_LINES, style: LlmStyle): string {
  return WIN_LINES[type][style]
}

export function supportsVibeLlmRule(rule: RuleVariant): boolean {
  return rule === 'lotus-classic' || rule === 'lotus-legacy'
}

