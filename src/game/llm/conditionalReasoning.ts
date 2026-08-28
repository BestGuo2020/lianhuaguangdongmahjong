import type { Candidate, DecisionRequest, RuleCode } from './schema'

export interface ConditionalReasoningConfig {
  enabled: boolean
  maxPerRound: number
  maxPerMatch: number
  deadlineMs: number
  minRemainingBudgetMs: number
  trigger: {
    candidateScoreGap: number
    lateWallCount: number
    opponentThreat: number
    scoreSwing: number
  }
  auditSampleRate: number
}

export const DEFAULT_CONDITIONAL_REASONING: Readonly<ConditionalReasoningConfig> = {
  enabled: true,
  maxPerRound: 2,
  maxPerMatch: 8,
  deadlineMs: 40_000,
  minRemainingBudgetMs: 45_000,
  trigger: {
    candidateScoreGap: 8,
    lateWallCount: 12,
    opponentThreat: 70,
    scoreSwing: 800,
  },
  auditSampleRate: 0.02,
}

export interface ReasoningTriggerResult {
  enabled: boolean
  reasons: Array<'close-candidates' | 'late-wall' | 'opponent-threat' | 'score-swing' | 'audit'>
  candidateScoreGap: number
  opponentThreat: number
  scoreSwing: number
}

function band(value: unknown, high: number, medium: number, low = 0): number {
  return value === '高' || value === '优' ? high : value === '中' ? medium : low
}

/** 将候选已有的牌效、安全和即时收益压到同一 0～100 尺度，仅用于判断“是否难选”。 */
export function candidateDecisionScore(candidate: Candidate, ruleCode: RuleCode): number {
  const features = candidate.features
  let score = 50
  if (typeof features.shanten === 'number') score -= features.shanten * 14
  if (typeof features.ukeire === 'number') score += Math.min(24, features.ukeire * 2)
  if (typeof features.effectiveRemaining === 'number') score += Math.min(20, features.effectiveRemaining)
  score += band(features.efficiency, 12, 4, -8)
  if (ruleCode !== 'lotus-classic') score += band(features.safety, 10, 2, -8)
  score += band(features.scoreDeltaBand, 14, 7)
  if (features.ready === true) score += 18
  score -= features.risks.length * 8
  if (candidate.action.kind === 'pass') score -= 2
  return score
}

export function candidateScoreGap(request: DecisionRequest): number {
  const scores = request.candidates
    .map((candidate) => candidateDecisionScore(candidate, request.ruleCode))
    .sort((a, b) => b - a)
  return scores.length < 2 ? Number.POSITIVE_INFINITY : Math.abs(scores[0] - scores[1])
}

function suitOf(tile: string): string | null {
  if (tile.endsWith('万')) return '万'
  if (tile.endsWith('筒')) return '筒'
  if (tile.endsWith('条')) return '条'
  return null
}

/** 公开信息威胁值：副露为主，叠加染手集中度、后段与短牌河异常。 */
export function estimateOpponentThreat(request: DecisionRequest): number {
  if (request.ruleCode === 'lotus-classic') return 0
  const opponents = [request.state.snapshots.upper, request.state.snapshots.opposite, request.state.snapshots.lower]
  return Math.max(0, ...opponents.map((view) => {
    const exposedTiles = view.melds.flatMap((meld) => meld.tiles)
    const suits = exposedTiles.map(suitOf).filter((value): value is string => value !== null)
    const suitCounts = new Map<string, number>()
    suits.forEach((suit) => suitCounts.set(suit, (suitCounts.get(suit) ?? 0) + 1))
    const dominant = suits.length ? Math.max(...suitCounts.values()) / suits.length : 0
    let threat = view.melds.length * 20
    if (view.melds.length >= 2 && dominant >= 0.75) threat += 22
    if (request.state.wallCount <= 24) threat += 10
    if (view.melds.length >= 2 && view.discards.length <= 7) threat += 8
    return Math.min(100, threat)
  }))
}

export function estimateScoreSwing(request: DecisionRequest): number {
  return request.candidates.reduce((largest, candidate) => {
    const value = candidate.features.scoreDelta ?? 0
    return Math.max(largest, value)
  }, 0)
}

export function evaluateReasoningTriggers(
  request: DecisionRequest,
  config: ConditionalReasoningConfig = DEFAULT_CONDITIONAL_REASONING,
  random: () => number = Math.random,
): ReasoningTriggerResult {
  const gap = candidateScoreGap(request)
  const threat = request.ruleCode === 'lotus-classic' ? 0 : estimateOpponentThreat(request)
  const swing = estimateScoreSwing(request)
  const reasons: ReasoningTriggerResult['reasons'] = []
  if (gap <= config.trigger.candidateScoreGap) reasons.push('close-candidates')
  if (request.state.wallCount <= config.trigger.lateWallCount) reasons.push('late-wall')
  if (threat >= config.trigger.opponentThreat) reasons.push('opponent-threat')
  if (swing >= config.trigger.scoreSwing) reasons.push('score-swing')
  if (random() < config.auditSampleRate) reasons.push('audit')
  return { enabled: reasons.length > 0, reasons, candidateScoreGap: gap, opponentThreat: threat, scoreSwing: swing }
}

/** 一场牌共用一个协调器；roundIndex 变化即自然切换小局限额。深思请求最多等待 40 秒。 */
export class ConditionalReasoningCoordinator {
  private matchUses = 0
  private readonly roundUses = new Map<number, number>()
  private lastRoundIndex: number | null = null

  constructor(
    readonly config: ConditionalReasoningConfig = DEFAULT_CONDITIONAL_REASONING,
    private readonly random: () => number = Math.random,
  ) {}

  admit(request: DecisionRequest, remainingBudgetMs: number): ReasoningTriggerResult {
    if (this.lastRoundIndex !== null && request.state.roundIndex < this.lastRoundIndex) this.reset()
    this.lastRoundIndex = request.state.roundIndex
    const result = evaluateReasoningTriggers(request, this.config, this.random)
    const round = request.state.roundIndex
    const allowed = this.config.enabled
      && remainingBudgetMs >= this.config.minRemainingBudgetMs
      && this.matchUses < this.config.maxPerMatch
      && (this.roundUses.get(round) ?? 0) < this.config.maxPerRound
      && result.enabled
    if (!allowed) return { ...result, enabled: false }
    this.matchUses += 1
    this.roundUses.set(round, (this.roundUses.get(round) ?? 0) + 1)
    return result
  }

  reset(): void {
    this.matchUses = 0
    this.roundUses.clear()
    this.lastRoundIndex = null
  }
}
