export type LlmSpeechPriority = 'normal' | 'important'

const MAX_SPEECH_CODE_POINTS = 16
const BACKSTAGE_TERMS = [
  '引擎', '候选', '编号', '模型', '系统', '提示词', '基线', '默认建议', '默认参考',
  '人工智能', '程序', '算法', '规则摘要', 'choice', 'message', 'json',
]
const INTERNAL_MARKER_PATTERN = /(?:^|[^A-Za-z])AI(?:$|[^A-Za-z])|[A-Z]\d+/i

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
  maxSpeechCodePoints: MAX_SPEECH_CODE_POINTS,
} as const
