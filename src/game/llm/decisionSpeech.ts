import type { LlmStyle } from './config'
import type { CanonicalAction } from './schema'
import { compactLlmSpeechText } from './speechPolicy'

type DecisionSpeechKind = CanonicalAction['kind']
type RelativeSeat = '上家' | '对家' | '下家'

export interface DecisionSpeechFacts {
  isDealer?: boolean
  publicMeldTypes?: Partial<Record<RelativeSeat, readonly string[]>>
  currentDiscard?: { from: RelativeSeat; tile: string } | null
  discardedTile?: string
}

const PUBLIC_ACTION_PATTERN = /(上家|对家|下家)(?:刚才|刚刚|刚|已经|又|也)?(暗杠|明杠|补杠|杠|碰|吃)(?:了|过|成)?/g
const PUBLIC_DISCARD_PATTERN = /(上家|对家|下家)(?:刚才|刚刚|刚)?(?:打出|打了|打的|出了)(?:一张)?([1-9][万筒条]|东风|南风|西风|北风|红中|发财|白板)?/g

const LINES: Record<DecisionSpeechKind, Record<LlmStyle, readonly string[]>> = {
  discard: {
    激进: ['这张不要了。', '先打出去。', '这一张走。'],
    稳健: ['这张先走。', '先打这一张。', '按牌路来。'],
    话痨: ['先把这张放出去。', '这一张先打掉。', '轮到我出牌啦。'],
    高冷: ['打。', '这张。', '出牌。'],
  },
  gang: {
    激进: ['大明杠，开！', '这杠我拿了！', '直接杠！'],
    稳健: ['大明杠。', '这杠可以开。', '顺势开杠。'],
    话痨: ['这张正好大明杠！', '来得巧，我杠了！', '四张齐了，开杠！'],
    高冷: ['杠。', '大明杠。', '开杠。'],
  },
  peng: {
    激进: ['碰！', '这张我要了！', '直接碰！'],
    稳健: ['碰一个。', '这张可以碰。', '顺势碰。'],
    话痨: ['来得正好，我碰！', '这张我可要碰啦！', '凑齐了，碰一个！'],
    高冷: ['碰。', '收下。', '碰了。'],
  },
  chi: {
    激进: ['直接吃！', '这张我吃了！', '顺手拿下！'],
    稳健: ['顺手吃了。', '这张可以吃。', '吃一组。'],
    话痨: ['刚好连上，我吃啦！', '这张来得正合适！', '顺子齐了，吃一个！'],
    高冷: ['吃。', '收下。', '吃了。'],
  },
  pass: {
    激进: ['先放你一手。', '这次不要。', '继续来。'],
    稳健: ['先看看。', '这次先过。', '不急这一手。'],
    话痨: ['这张我先不要啦。', '你们继续，我看看。', '先过，后面再说！'],
    高冷: ['过。', '不要。', '继续。'],
  },
  'added-kong': {
    激进: ['补杠，开！', '这张补上！', '补杠拿下！'],
    稳健: ['补杠。', '顺势补杠。', '这一张补上。'],
    话痨: ['第四张到了，补杠！', '刚好补上这一杠！', '等到了，补杠啦！'],
    高冷: ['补杠。', '补上。', '杠。'],
  },
  'concealed-kong': {
    激进: ['暗杠，开！', '四张在手，杠！', '直接暗杠！'],
    稳健: ['暗杠。', '这手开暗杠。', '暗杠正合适。'],
    话痨: ['四张都在手，暗杠！', '藏得好好的，开杠啦！', '这一组正好暗杠！'],
    高冷: ['暗杠。', '杠。', '开。'],
  },
  'wind-kong': {
    激进: ['乱风杠，开！', '四风齐了！', '风杠拿下！'],
    稳健: ['乱风杠。', '四风成杠。', '这一手风杠。'],
    话痨: ['东南西北齐了，风杠！', '四风都到手啦！', '这手正好乱风杠！'],
    高冷: ['风杠。', '四风齐。', '杠。'],
  },
  win: {
    激进: ['拿下！'], 稳健: ['收下了。'], 话痨: ['这手我拿下啦！'], 高冷: ['胡。'],
  },
}

export const REASONING_STATUS_LINES: Record<LlmStyle, readonly string[]> = {
  激进: ['让我算算怎么打。', '这手得想清楚。', '先别急，我算一下。'],
  稳健: ['让我想想怎么打。', '这手要仔细看看。', '容我想一想。'],
  话痨: ['等等，让我好好想想。', '这手有点难，我算算。', '我得认真琢磨一下。'],
  高冷: ['稍等。', '容我想想。', '这手要算。'],
}

export function reasoningStatusSpeech(style: LlmStyle, sequence = 0): string {
  const variants = REASONING_STATUS_LINES[style]
  return variants[Math.abs(sequence) % variants.length]
}

/** 动作通过合法性校验后生成台词；不消费模型自由文本，因此语义必与动作一致。 */
export function decisionSpeech(action: CanonicalAction, style: LlmStyle, sequence = 0): string {
  const variants = LINES[action.kind][style]
  return variants[Math.abs(sequence) % variants.length]
}

/** 自由 message 合规则保留；仅缺失或幕后内容回退程序台词。 */
export function resolveDecisionSpeech(
  message: string,
  action: CanonicalAction,
  style: LlmStyle,
  sequence = 0,
  facts: DecisionSpeechFacts = {},
): string {
  const compact = compactLlmSpeechText(message)
  const deniesDealer = /我(?:可|并)?不是庄家|我非庄家|我不坐庄/.test(compact)
  const claimsDealer = /本庄|庄家(?:是|就是)我|我(?:可是|就是|是|当|来当|在当|要当|坐|来坐|在坐)庄家?|这把我坐庄|我是东家/.test(compact)
  const contradictsDealer = facts.isDealer === false
    ? claimsDealer && !deniesDealer
    : facts.isDealer === true ? deniesDealer : false
  const contradictsPublicAction = [...compact.matchAll(PUBLIC_ACTION_PATTERN)].some((match) => {
    const seat = match[1] as RelativeSeat
    const claim = match[2]
    const types = facts.publicMeldTypes?.[seat]
    if (!types) return false
    if (claim === '吃') return !types.includes('chi')
    if (claim === '碰') return !types.includes('peng')
    if (claim === '暗杠') return !types.includes('angang')
    if (claim === '明杠' || claim === '补杠') return !types.includes('gang')
    return !types.some((type) => type === 'gang' || type === 'angang')
  })
  const contradictsCurrentDiscard = facts.currentDiscard
    ? [...compact.matchAll(PUBLIC_DISCARD_PATTERN)].some((match) => {
      const from = match[1] as RelativeSeat
      const tile = match[2]
      return from !== facts.currentDiscard!.from || Boolean(tile && tile !== facts.currentDiscard!.tile)
    })
    : false
  const keepTerms = '(?:留着|保留|留下|不打|当宝)'
  const genericKeepPattern = new RegExp(`(?:这张|这牌|此牌).{0,4}${keepTerms}|${keepTerms}.{0,4}(?:这张|这牌|此牌)`)
  const namedKeepPattern = facts.discardedTile
    ? new RegExp(`${facts.discardedTile}.{0,4}${keepTerms}|${keepTerms}.{0,4}${facts.discardedTile}`)
    : null
  const contradictsDiscardCommitment = action.kind === 'discard'
    && (genericKeepPattern.test(compact) || Boolean(namedKeepPattern?.test(compact)))
  // 先移除“下家杠了”等他家公开事实，再判断剩余文本是否承诺了自己的动作。
  const selfSpeech = compact.replace(PUBLIC_ACTION_PATTERN, '')
  const claimedKongKind: CanonicalAction['kind'] | null = /暗杠/.test(selfSpeech) ? 'concealed-kong'
    : /补杠/.test(selfSpeech) ? 'added-kong'
      : /乱风杠|风杠/.test(selfSpeech) ? 'wind-kong'
        : /大明杠|明杠/.test(selfSpeech) ? 'gang' : null
  const claimsGenericKong = /我要杠|我杠了|开杠|直接杠/.test(selfSpeech)
  const claimedAction = /吃定了|我要吃|我吃了|这牌我吃|直接吃/.test(selfSpeech) ? 'chi'
    : /我要碰|我碰了|碰一个|直接碰|这牌我碰/.test(selfSpeech) ? 'peng'
      : claimedKongKind || claimsGenericKong ? 'gang'
        : /我过了|这次我过|我要过/.test(selfSpeech) ? 'pass' : null
  const actionMatchesClaim = !claimedAction
    || claimedAction === action.kind
    || (claimedAction === 'gang' && ['gang', 'added-kong', 'concealed-kong', 'wind-kong'].includes(action.kind))
  const kongSubtypeMatches = !claimedKongKind || action.kind === claimedKongKind
  if (compact && !contradictsDealer && !contradictsPublicAction && !contradictsCurrentDiscard
    && !contradictsDiscardCommitment && actionMatchesClaim && kongSubtypeMatches) return compact
  return decisionSpeech(action, style, sequence)
}

export const DECISION_SPEECH_LINES = LINES
