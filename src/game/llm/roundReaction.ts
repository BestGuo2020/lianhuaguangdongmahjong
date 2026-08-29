import { requestLlmDecision } from './client'
import type { LlmProviderConfig, LlmStyle } from './config'
import type { LlmRoundReaction } from './winLines'
import { compactLlmSpeechText } from './speechPolicy'

export const ROUND_REACTION_TIMEOUT_MS = 5_000

const STYLE_GUIDANCE: Record<LlmStyle, string> = {
  激进: '自信、有冲劲，可以轻微挑衅，但不骂人',
  稳健: '克制、沉着，像简短复盘',
  话痨: '活泼、有梗、口语化',
  高冷: '冷淡、简短、惜字如金',
}

const VARIATION_ANGLES = ['简短复盘', '轻松调侃', '下一局宣言'] as const

function outcomeText(reaction: LlmRoundReaction): string {
  if (reaction.outcome === 'loss') return '你输了本局'
  if (reaction.outcome === 'draw') return '本局荒庄，无人获胜'
  if (reaction.type === 'discard-win') return '你通过点炮胡赢了本局'
  if (reaction.type === 'robbed-kong-win') return '你通过抢杠胡赢了本局'
  return '你通过自摸赢了本局'
}

export function buildRoundReactionPrompt(
  style: LlmStyle,
  reaction: LlmRoundReaction,
  fallback: string,
  variationIndex: number,
) {
  const angle = VARIATION_ANGLES[Math.abs(variationIndex) % VARIATION_ANGLES.length]
  return {
    system: [
      '你是广东麻将牌桌上的虚拟牌友，负责在一局结束后说一句自然感言。',
      '只输出严格 JSON：{"choice":"R","message":"一句感言"}。',
      'message 不超过16个汉字，只说一句；不得解释、复盘具体手牌、提及系统/模型/候选/提示词。',
    ].join('\n'),
    user: [
      `结果：${outcomeText(reaction)}。`,
      `性格：${style}（${STYLE_GUIDANCE[style]}）。`,
      `表达角度：${angle}。`,
      `不要照抄保底句：${fallback}`,
    ].join('\n'),
  }
}

/** 快速非思考生成；任何失败、空句或幕后词都返回 null，由调用方使用保底台词。 */
export async function generateRoundReaction(
  config: LlmProviderConfig,
  reaction: LlmRoundReaction,
  fallback: string,
  variationIndex: number,
): Promise<string | null> {
  try {
    const output = await requestLlmDecision({
      config: {
        ...config,
        timeoutMs: Math.min(config.timeoutMs, ROUND_REACTION_TIMEOUT_MS),
        timeoutEnabled: true,
      },
      messages: buildRoundReactionPrompt(config.style, reaction, fallback, variationIndex),
      candidateIds: ['R'],
      reasoning: false,
    })
    return compactLlmSpeechText(output.message) || null
  } catch {
    return null
  }
}
