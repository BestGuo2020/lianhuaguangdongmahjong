import type { LlmStyle } from './config'

export type LlmSpeechPriority = 'normal' | 'important'

const GLOBAL_NORMAL_COOLDOWN_MS = 6_000
const STYLE_NORMAL_COOLDOWN_MS: Record<LlmStyle, number> = {
  话痨: 8_000,
  激进: 12_000,
  稳健: 16_000,
  高冷: 24_000,
}
/** 普通弃牌/过牌的确定性抽稀：首次说，之后每 N 次可发言机会说一次。 */
const STYLE_NORMAL_EVERY: Record<LlmStyle, number> = {
  话痨: 1,
  激进: 3,
  稳健: 4,
  高冷: 6,
}
const MAX_SPEECH_CODE_POINTS = 16
const BACKSTAGE_TERMS = [
  '引擎', '候选', '编号', '模型', '系统', '提示词', '基线', '默认建议', '默认参考',
  '人工智能', '程序', '算法', '规则摘要', 'choice', 'message', 'json',
]
const INTERNAL_MARKER_PATTERN = /(?:^|[^A-Za-z])AI(?:$|[^A-Za-z])|[A-Z]\d+/i

export interface LlmSpeechCandidate {
  seat: number
  style: LlmStyle
  priority?: LlmSpeechPriority
  /** 话痨摸打等明确要求逐次发言的事件，不参与普通冷却和抽稀。 */
  mandatory?: boolean
}

/** 单机与联机共用：关键动作直通，普通弃牌/过牌按全桌冷却、座位冷却和性格频率抽稀。 */
export class LlmSpeechPolicy {
  private lastGlobalAt = Number.NEGATIVE_INFINITY
  private readonly lastSeatAt = new Map<number, number>()
  private readonly normalAttempts = new Map<number, number>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  admit(candidate: LlmSpeechCandidate): boolean {
    const at = this.now()
    const priority = candidate.priority ?? 'normal'
    if (candidate.mandatory) return true
    if (priority === 'important') {
      this.lastGlobalAt = at
      this.lastSeatAt.set(candidate.seat, at)
      return true
    }
    if (at - this.lastGlobalAt < GLOBAL_NORMAL_COOLDOWN_MS) return false
    if (at - (this.lastSeatAt.get(candidate.seat) ?? Number.NEGATIVE_INFINITY)
      < STYLE_NORMAL_COOLDOWN_MS[candidate.style]) return false
    const attempt = (this.normalAttempts.get(candidate.seat) ?? 0) + 1
    this.normalAttempts.set(candidate.seat, attempt)
    if ((attempt - 1) % STYLE_NORMAL_EVERY[candidate.style] !== 0) return false
    this.lastGlobalAt = at
    this.lastSeatAt.set(candidate.seat, at)
    return true
  }

  reset(): void {
    this.lastGlobalAt = Number.NEGATIVE_INFINITY
    this.lastSeatAt.clear()
    this.normalAttempts.clear()
  }
}

/** 丢弃幕后术语，只读第一句并限制 16 个 Unicode code point。 */
export function compactLlmSpeechText(text: string): string {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const lower = normalized.toLocaleLowerCase()
  if (BACKSTAGE_TERMS.some((term) => lower.includes(term.toLocaleLowerCase()))
    || INTERNAL_MARKER_PATTERN.test(normalized)) return ''
  const points = [...normalized]
  const punctuation = new Set(['。', '！', '？', '!', '?'])
  const firstEnd = points.findIndex((point) => punctuation.has(point))
  const firstSentence = firstEnd >= 0 ? points.slice(0, firstEnd + 1) : points
  return firstSentence.slice(0, MAX_SPEECH_CODE_POINTS).join('').trim()
}

export const LLM_SPEECH_POLICY_LIMITS = {
  globalNormalCooldownMs: GLOBAL_NORMAL_COOLDOWN_MS,
  styleNormalCooldownMs: STYLE_NORMAL_COOLDOWN_MS,
  styleNormalEvery: STYLE_NORMAL_EVERY,
  maxSpeechCodePoints: MAX_SPEECH_CODE_POINTS,
} as const
