import type { LlmStyle } from './config'

export type LlmSpeechPriority = 'normal' | 'important'

const GLOBAL_NORMAL_COOLDOWN_MS = 2_000
const STYLE_NORMAL_COOLDOWN_MS: Record<LlmStyle, number> = {
  话痨: 3_000,
  激进: 5_000,
  稳健: 7_000,
  高冷: 10_000,
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
}

/**
 * 单桌发言准入：重要台词始终放行；普通吐槽同时受全桌与座位性格冷却约束。
 * 使用时间而非随机数，保证前端/后端测试和同一局行为可复现。
 */
export class LlmSpeechPolicy {
  private lastGlobalAt = Number.NEGATIVE_INFINITY
  private readonly lastSeatAt = new Map<number, number>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  admit(candidate: LlmSpeechCandidate): boolean {
    const at = this.now()
    const priority = candidate.priority ?? 'normal'
    if (priority === 'important') {
      this.lastGlobalAt = at
      this.lastSeatAt.set(candidate.seat, at)
      return true
    }
    if (at - this.lastGlobalAt < GLOBAL_NORMAL_COOLDOWN_MS) return false
    if (at - (this.lastSeatAt.get(candidate.seat) ?? Number.NEGATIVE_INFINITY)
      < STYLE_NORMAL_COOLDOWN_MS[candidate.style]) return false
    this.lastGlobalAt = at
    this.lastSeatAt.set(candidate.seat, at)
    return true
  }

  reset(): void {
    this.lastGlobalAt = Number.NEGATIVE_INFINITY
    this.lastSeatAt.clear()
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
  maxSpeechCodePoints: MAX_SPEECH_CODE_POINTS,
} as const
