export type AnimeAudioPlayerKind = 'human' | 'llm' | 'bot' | 'unknown'

export interface AnimeAudioIdentity {
  /** 新协议身份优先；unknown 表示调用方没有足够上下文判定真人或 bot。 */
  playerKind?: AnimeAudioPlayerKind | null
  /** 旧协议兼容信号：只能可靠确认 LLM，false/缺失不能区分真人与 bot。 */
  isLlm?: boolean | null
}

export interface AnimeAudioPolicyInput extends AnimeAudioIdentity {
  themeName?: string | null
}

export type ConditionalAudioRoute = 'legacy' | 'play' | 'suppress'
export type EventVoiceRoute = 'legacy' | 'fixed-line'

export interface AnimeAudioPolicy {
  theme: 'legacy' | 'llmAnime'
  playerKind: AnimeAudioPlayerKind
  discard: {
    /** 实体落牌声在所有策略下保留。 */
    playEffect: true
    /** 牌名人声；legacy 由原有单机/联机逻辑决定。 */
    tileName: ConditionalAudioRoute
    /** LLM 普通吐槽 TTS；动作/结果不属于该路径。 */
    commentary: ConditionalAudioRoute
  }
  /** 吃碰杠胡等语义动作的人声出口。 */
  actionVoice: EventVoiceRoute
  /** 胜、负、流局等结果发言的人声出口。 */
  resultVoice: EventVoiceRoute
}

export interface LegacySpeechMetadata {
  purpose?: string | null
  speechSource?: string | null
}

/** 仅过滤新版服务端明确标记的模型动作/赛后语音；缺少元数据的旧协议保持 legacy。 */
export function shouldSuppressLegacyAnimeSpeech(
  themeName: string | null | undefined,
  message: LegacySpeechMetadata,
): boolean {
  return themeName === 'llmAnime'
    && message.speechSource === 'model-message'
    && (message.purpose === 'action' || message.purpose === 'round-reaction')
}

/**
 * 显式 playerKind 是新协议权威；旧 isLlm 只能把 true 识别成 LLM。
 * isLlm=false 或字段缺失时保持 unknown，避免把潜在真人误判成 bot 并报牌。
 */
export function resolveAnimeAudioPlayerKind(identity: AnimeAudioIdentity): AnimeAudioPlayerKind {
  if (identity.playerKind === 'human'
    || identity.playerKind === 'llm'
    || identity.playerKind === 'bot'
    || identity.playerKind === 'unknown') return identity.playerKind
  return identity.isLlm === true ? 'llm' : 'unknown'
}

/**
 * 纯表现策略：调用方仍负责实际播放、事件去重、静音和资源回退。
 * 非 llmAnime 主题全部返回 legacy，确保现有音频行为不被该主题策略改写。
 */
export function resolveAnimeAudioPolicy(input: AnimeAudioPolicyInput): AnimeAudioPolicy {
  const playerKind = resolveAnimeAudioPlayerKind(input)
  if (input.themeName !== 'llmAnime') {
    return {
      theme: 'legacy',
      playerKind,
      discard: { playEffect: true, tileName: 'legacy', commentary: 'legacy' },
      actionVoice: 'legacy',
      resultVoice: 'legacy',
    }
  }

  const discard = playerKind === 'bot'
    ? { playEffect: true as const, tileName: 'play' as const, commentary: 'suppress' as const }
    : playerKind === 'llm'
      ? { playEffect: true as const, tileName: 'suppress' as const, commentary: 'play' as const }
      : { playEffect: true as const, tileName: 'suppress' as const, commentary: 'suppress' as const }

  return {
    theme: 'llmAnime',
    playerKind,
    discard,
    actionVoice: 'fixed-line',
    resultVoice: 'fixed-line',
  }
}
