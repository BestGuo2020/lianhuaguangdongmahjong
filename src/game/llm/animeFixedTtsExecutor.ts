import type { LlmAudioPlaybackHooks } from '../core/presentation/llmAudioBus'
import type { TableActionType } from '../core/contracts/types'
import {
  ANIME_TTS_SPEAKERS,
  type AnimeTtsVoiceKey,
  type AnimeVoiceKey,
} from './animeCharacters'
import {
  createAnimeFixedTtsRequest,
  isAnimeActionVoiceKey,
  type AnimeActionVoiceKey,
  type AnimeFixedTtsRequest,
  type AnimeResultVoiceKey,
} from './animeFixedTts'
import { getLocalTtsClient } from './localTtsClient'
import type { LlmSpeechPriority } from './speechPolicy'

export type AnimeSeat = 0 | 1 | 2 | 3
export type AnimeFixedTtsEventId = string | number
/** 首次冷合成通常超过 900ms；覆盖火山主音色的正常请求窗口，缓存命中仍立即播放。 */
export const ANIME_ACTION_TTS_WAIT_MS = 4_500
// 赛后感言必须覆盖 4 家串行发言的最长冷合成窗口：单家合成超时被记为 failed 后
// 会立刻轮到下一位，若各家合成都偏慢，结算会在第 1 家发言后提前打开，与房主
// 等满 4 家的节奏分叉。6s 覆盖慢网关 + 排队播放启动，仍被 waitForCompletion 的
// 完整播放约束。
export const ANIME_ROUND_TTS_WAIT_MS = 6_000

export const ANIME_TABLE_ACTION_VOICE_KEYS: Readonly<Record<TableActionType, AnimeActionVoiceKey>> = {
  chi: 'chi',
  peng: 'peng',
  'discard-gang': 'gang',
  'concealed-gang': 'gang',
  'added-gang': 'gang',
  'flower-gang': 'gang',
  'wind-kong': 'gang',
  'discard-win': 'hu',
  'self-draw': 'zimo',
  'robbed-kong-win': 'qiangganghu',
}

export const ANIME_ACTION_FALLBACK_AUDIO: Readonly<Record<AnimeActionVoiceKey, string>> = {
  chi: 'chi.mp3',
  peng: 'peng.mp3',
  gang: 'gang.mp3',
  hu: 'hu.mp3',
  zimo: 'zimo.mp3',
  qiangganghu: 'hu.mp3',
}

export function animeVoiceKeyForTableAction(type: TableActionType): AnimeActionVoiceKey {
  return ANIME_TABLE_ACTION_VOICE_KEYS[type]
}

export function animeFallbackAudioForAction(type: TableActionType): string {
  return ANIME_ACTION_FALLBACK_AUDIO[animeVoiceKeyForTableAction(type)]
}

export interface AnimeFixedTtsSpeaker {
  speak(
    seat: number,
    text: string,
    voiceKey: string,
    style: '稳健',
    priority?: LlmSpeechPriority,
    hooks?: LlmAudioPlaybackHooks,
  ): boolean | Promise<boolean>
  cancel(): void
}

export interface AnimeFixedTtsExecutorHooks {
  /** 固定文字先交给气泡/日志表现；回调失败不得影响语音或规则。 */
  onLine?: (event: AnimeFixedTtsEvent, request: AnimeFixedTtsRequest) => void
}

export interface AnimeFixedTtsEvent {
  readonly eventId: AnimeFixedTtsEventId
  readonly seat: AnimeSeat
  readonly characterId: unknown
  readonly animeVoiceKey: AnimeVoiceKey
  /** 赛后队列等待整句播放；动作保留现有播放中点放行行为。 */
  readonly waitForCompletion?: boolean
}

export interface AnimeFixedTtsActionEvent {
  readonly eventId: AnimeFixedTtsEventId
  readonly seat: AnimeSeat
  readonly characterId: unknown
  readonly action: TableActionType
}

export type AnimeFixedTtsExecutionStatus = 'played' | 'failed' | 'cancelled' | 'duplicate'

export interface AnimeFixedTtsExecutionResult {
  readonly status: AnimeFixedTtsExecutionStatus
  readonly eventKey: string
  readonly request: AnimeFixedTtsRequest
  /** 只有动作 TTS 真正失败时设置；调用方据此播放一次通用人声。 */
  readonly fallbackAudioFile: string | null
}

export type AnimeRoundWinType =
  | 'self-draw'
  | 'discard'
  | 'discard-win'
  | 'robbed-kong'
  | 'robbed-kong-win'

export interface AnimeRoundTtsOptions {
  readonly eventId: AnimeFixedTtsEventId
  /** 下标即座位；缺失、非法或未知角色由角色合同回退 DeepSeek。 */
  readonly characterIds: readonly unknown[]
  readonly winnerIndex: number | null
  readonly winType?: AnimeRoundWinType
  readonly draw?: boolean
}

export type AnimeRoundTtsStatus = 'completed' | 'cancelled' | 'duplicate' | 'failed'

export interface AnimeRoundTtsResult {
  readonly status: AnimeRoundTtsStatus
  readonly order: readonly AnimeSeat[]
  readonly items: readonly AnimeFixedTtsExecutionResult[]
}

const ALL_SEATS: readonly AnimeSeat[] = [0, 1, 2, 3]

function isAnimeSeat(value: unknown): value is AnimeSeat {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3
}

/** 赢家先说，其他人从赢家开始顺时针；流局或非法赢家按 0..3 座位顺序。 */
export function animeRoundSpeechOrder(
  winnerIndex: number | null,
  draw = false,
): readonly AnimeSeat[] {
  if (draw || !isAnimeSeat(winnerIndex)) return [...ALL_SEATS]
  return ALL_SEATS.map((offset) => ((winnerIndex + offset) % 4) as AnimeSeat)
}

export function animeResultVoiceKeyForSeat(
  seat: AnimeSeat,
  winnerIndex: number | null,
  winType: AnimeRoundWinType = 'self-draw',
  draw = false,
): AnimeResultVoiceKey {
  if (draw || !isAnimeSeat(winnerIndex)) return 'draw'
  if (seat !== winnerIndex) return 'loss'
  if (winType === 'discard' || winType === 'discard-win') return 'win-discard'
  if (winType === 'robbed-kong' || winType === 'robbed-kong-win') return 'win-robbed-kong'
  return 'win-self-draw'
}

function eventIdentity(event: AnimeFixedTtsEvent): string {
  return JSON.stringify([
    'llm-anime-fixed-tts-event',
    typeof event.eventId,
    event.eventId,
    event.seat,
    event.animeVoiceKey,
  ])
}

function roundIdentity(eventId: AnimeFixedTtsEventId): string {
  return JSON.stringify(['llm-anime-fixed-tts-round', typeof eventId, eventId])
}

function fallbackAudioForVoiceKey(voiceKey: AnimeVoiceKey): string | null {
  return isAnimeActionVoiceKey(voiceKey)
    ? ANIME_ACTION_FALLBACK_AUDIO[voiceKey]
    : null
}

/**
 * 固定文案共享执行器。实例作用域即事件去重作用域；新牌局/新房间可以 reset，
 * 主题切换或返回大厅只需 cancel。
 */
export class AnimeFixedTtsExecutor {
  private generation = 0
  private readonly completedEvents = new Set<string>()
  private readonly eventInflight = new Map<string, Promise<AnimeFixedTtsExecutionResult>>()
  private readonly completedRounds = new Set<string>()
  private readonly roundInflight = new Map<string, Promise<AnimeRoundTtsResult>>()
  private readonly cancellationWaiters = new Set<() => void>()

  constructor(
    private readonly speaker: AnimeFixedTtsSpeaker = getLocalTtsClient(),
    private readonly hooks: AnimeFixedTtsExecutorHooks = {},
  ) {}

  /** 同事件并发调用返回同一 Promise；完成后再次调用返回 duplicate 且不重播。 */
  execute(event: AnimeFixedTtsEvent): Promise<AnimeFixedTtsExecutionResult> {
    const eventKey = eventIdentity(event)
    const active = this.eventInflight.get(eventKey)
    if (active) return active
    const request = createAnimeFixedTtsRequest(event.characterId, event.animeVoiceKey)
    if (this.completedEvents.has(eventKey)) {
      return Promise.resolve({ status: 'duplicate', eventKey, request, fallbackAudioFile: null })
    }

    this.completedEvents.add(eventKey)
    const currentGeneration = this.generation
    const execution = this.perform(event, eventKey, request, currentGeneration)
      .finally(() => {
        if (this.eventInflight.get(eventKey) === execution) this.eventInflight.delete(eventKey)
      })
    this.eventInflight.set(eventKey, execution)
    return execution
  }

  executeAction(event: AnimeFixedTtsActionEvent): Promise<AnimeFixedTtsExecutionResult> {
    return this.execute({
      eventId: event.eventId,
      seat: event.seat,
      characterId: event.characterId,
      animeVoiceKey: animeVoiceKeyForTableAction(event.action),
    })
  }

  /** 四家固定发言串行播放。任一 TTS 失败只记录 failed 并继续下一家。 */
  executeRound(options: AnimeRoundTtsOptions): Promise<AnimeRoundTtsResult> {
    const roundKey = roundIdentity(options.eventId)
    const active = this.roundInflight.get(roundKey)
    if (active) return active
    const order = animeRoundSpeechOrder(options.winnerIndex, options.draw)
    if (this.completedRounds.has(roundKey)) {
      return Promise.resolve({ status: 'duplicate', order, items: [] })
    }

    this.completedRounds.add(roundKey)
    const currentGeneration = this.generation
    const execution = this.performRound(options, order, currentGeneration)
      .catch((): AnimeRoundTtsResult => ({ status: 'failed', order, items: [] }))
      .finally(() => {
        if (this.roundInflight.get(roundKey) === execution) this.roundInflight.delete(roundKey)
      })
    this.roundInflight.set(roundKey, execution)
    return execution
  }

  /** 立即放行等待者；事件级 isCurrent 门闸负责丢弃或终止本执行器的过期播放。 */
  cancel(): void {
    this.generation += 1
    const waiters = [...this.cancellationWaiters]
    this.cancellationWaiters.clear()
    waiters.forEach((resolve) => resolve())
  }

  /** 新会话复用实例时清空事件历史，同时取消上一会话的剩余表现。 */
  reset(): void {
    this.cancel()
    this.completedEvents.clear()
    this.completedRounds.clear()
    this.eventInflight.clear()
    this.roundInflight.clear()
  }

  private async perform(
    event: AnimeFixedTtsEvent,
    eventKey: string,
    request: AnimeFixedTtsRequest,
    generation: number,
  ): Promise<AnimeFixedTtsExecutionResult> {
    let resolveCancellation!: () => void
    let current = true
    let started = false
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
    const cancellation = new Promise<'cancelled'>((resolve) => {
      resolveCancellation = () => {
        current = false
        resolve('cancelled')
      }
      this.cancellationWaiters.add(resolveCancellation)
    })
    if (generation !== this.generation) resolveCancellation()
    const isCurrent = () => current && generation === this.generation
    const onStarted = () => {
      started = true
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId)
        timeoutId = undefined
      }
    }

    try { this.hooks.onLine?.(event, request) } catch { /* 文字表现失败不影响语音 */ }
    const speak = async (voiceKey: string): Promise<boolean> => {
      try {
        return await this.speaker.speak(
          event.seat,
          request.normalizedText,
          voiceKey,
          request.style,
          'important',
          {
            waitForCompletion: event.waitForCompletion,
            cacheIdentity: request.cacheIdentity,
            isCurrent,
            onStarted,
          },
        )
      } catch {
        return false
      }
    }
    const playback = (async (): Promise<'played' | 'failed'> => {
      if (await speak(request.voiceKey) || started) return 'played'
      if (!isCurrent()) return 'failed'
      if (request.fallbackVoiceKey !== request.voiceKey) {
        if (await speak(request.fallbackVoiceKey) || started) return 'played'
      }
      return 'failed'
    })()
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutId = globalThis.setTimeout(
        () => {
          if (started) return
          current = false
          resolve('timeout')
        },
        event.waitForCompletion ? ANIME_ROUND_TTS_WAIT_MS : ANIME_ACTION_TTS_WAIT_MS,
      )
    })

    const outcome = await Promise.race([playback, cancellation, timeout])
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
    this.cancellationWaiters.delete(resolveCancellation)
    if (outcome === 'cancelled' || generation !== this.generation) {
      return { status: 'cancelled', eventKey, request, fallbackAudioFile: null }
    }
    const status = outcome === 'played' ? 'played' : 'failed'
    return {
      status,
      eventKey,
      request,
      fallbackAudioFile: status === 'failed'
        ? fallbackAudioForVoiceKey(event.animeVoiceKey)
        : null,
    }
  }

  private async performRound(
    options: AnimeRoundTtsOptions,
    order: readonly AnimeSeat[],
    generation: number,
  ): Promise<AnimeRoundTtsResult> {
    const items: AnimeFixedTtsExecutionResult[] = []
    for (const seat of order) {
      if (generation !== this.generation) return { status: 'cancelled', order, items }
      const animeVoiceKey = animeResultVoiceKeyForSeat(
        seat,
        options.winnerIndex,
        options.winType,
        options.draw,
      )
      const item = await this.execute({
        eventId: `${typeof options.eventId}:${String(options.eventId)}:round:${seat}`,
        seat,
        characterId: options.characterIds[seat],
        animeVoiceKey,
        waitForCompletion: true,
      })
      items.push(item)
      if (item.status === 'cancelled' || generation !== this.generation) {
        return { status: 'cancelled', order, items }
      }
    }
    return { status: 'completed', order, items }
  }
}

export function createAnimeFixedTtsExecutor(
  speaker?: AnimeFixedTtsSpeaker,
  hooks?: AnimeFixedTtsExecutorHooks,
): AnimeFixedTtsExecutor {
  return new AnimeFixedTtsExecutor(speaker, hooks)
}

/** 供服务端/预热工具审计当前 primary/fallback speaker，而不发起合成。 */
export function animeFixedTtsSpeakerPair(request: AnimeFixedTtsRequest): {
  voiceKey: AnimeTtsVoiceKey
  speaker: string
  fallbackVoiceKey: AnimeTtsVoiceKey
  fallbackSpeaker: string
} {
  return {
    voiceKey: request.voiceKey,
    speaker: ANIME_TTS_SPEAKERS[request.voiceKey],
    fallbackVoiceKey: request.fallbackVoiceKey,
    fallbackSpeaker: ANIME_TTS_SPEAKERS[request.fallbackVoiceKey],
  }
}
