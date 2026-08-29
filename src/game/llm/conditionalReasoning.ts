import type { Candidate, DecisionRequest, RuleCode } from './schema'

export interface ConditionalReasoningConfig {
  enabled: boolean
  maxPerSeatPerRound: number
  /** 每座每小局最多一次普通“候选接近/审计”升级，为听牌、残局等强触发预留额度。 */
  maxSoftPerSeatPerRound: number
  maxPerMatch: number
  deadlineMs: number
  minRemainingBudgetMs: number
  trigger: {
    candidateScoreGap: number
    lateWallCount: number
    opponentThreat: number
    /** 前两巡只允许极高置信度的公开威胁越过早巡门槛。 */
    earlyOpponentThreat: number
    scoreSwing: number
  }
  auditSampleRate: number
}

export const DEFAULT_CONDITIONAL_REASONING: Readonly<ConditionalReasoningConfig> = {
  enabled: true,
  maxPerSeatPerRound: 2,
  maxSoftPerSeatPerRound: 1,
  maxPerMatch: 24,
  deadlineMs: 40_000,
  minRemainingBudgetMs: 45_000,
  trigger: {
    candidateScoreGap: 8,
    lateWallCount: 12,
    opponentThreat: 70,
    earlyOpponentThreat: 90,
    scoreSwing: 800,
  },
  auditSampleRate: 0.02,
}

export interface ReasoningTriggerResult {
  enabled: boolean
  reasons: Array<'ready-choice' | 'close-candidates' | 'late-wall' | 'opponent-threat' | 'score-swing' | 'audit'>
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

function featureSignature(candidate: Candidate): string {
  const features = candidate.features
  const tiles = (value: Candidate['features']['effectiveTiles'] | Candidate['features']['waits']) => value === 'n/a'
    ? value
    : value.map((item) => `${item.tile}:${item.remaining}`).sort()
  return JSON.stringify({
    actionKind: candidate.action.kind,
    shanten: features.shanten,
    ukeire: features.ukeire,
    effectiveTiles: tiles(features.effectiveTiles),
    ready: features.ready,
    waits: tiles(features.waits),
    effectiveRemaining: features.effectiveRemaining,
    specialPattern: features.specialPattern,
    safety: features.safety,
    efficiency: features.efficiency,
    scoreDeltaBand: features.scoreDeltaBand,
    scoreDelta: features.scoreDelta,
    risks: [...features.risks].sort(),
  })
}

function hasDistinctContender(
  candidates: Candidate[],
  ruleCode: RuleCode,
  maxGap: number,
): boolean {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: candidateDecisionScore(candidate, ruleCode) }))
    .sort((a, b) => b.score - a.score)
  const best = ranked[0]
  if (!best) return false
  const bestSignature = featureSignature(best.candidate)
  return ranked.slice(1).some(({ candidate, score }) => (
    best.score - score <= maxGap && featureSignature(candidate) !== bestSignature
  ))
}

/** 完全同质的候选只是确定性并列，不是值得增加延迟的疑难选择。 */
export function hasMeaningfulCloseChoice(request: DecisionRequest, maxGap: number): boolean {
  return hasDistinctContender(request.candidates, request.ruleCode, maxGap)
}

/**
 * AI 自己的暗手可精确判断：多个不同听牌方案，或碰/杠可能破坏听牌时，
 * 即使在前两巡也属于强触发。唯一听牌解与完全同质听口交给确定性引擎。
 */
export function hasReadyDecisionTradeoff(request: DecisionRequest, maxGap: number): boolean {
  const readyCandidates = request.candidates.filter((candidate) => candidate.features.ready === true)
  const mayBreakReady = request.candidates.some((candidate) => (
    candidate.features.risks.some((risk) => risk.includes('破坏听牌'))
  ))
  return mayBreakReady || (
    readyCandidates.length >= 2
    && hasDistinctContender(readyCandidates, request.ruleCode, maxGap)
  )
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
  const opening = request.state.turnOrigin === 'opening'
  const early = opening || request.state.earlyRound
  const reasons: ReasoningTriggerResult['reasons'] = []
  if (hasReadyDecisionTradeoff(request, config.trigger.candidateScoreGap)) reasons.push('ready-choice')
  if (!early
    && gap <= config.trigger.candidateScoreGap
    && hasMeaningfulCloseChoice(request, config.trigger.candidateScoreGap)) reasons.push('close-candidates')
  if (request.state.wallCount <= config.trigger.lateWallCount) reasons.push('late-wall')
  const threatThreshold = early ? config.trigger.earlyOpponentThreat : config.trigger.opponentThreat
  if (threat >= threatThreshold) reasons.push('opponent-threat')
  if (swing >= config.trigger.scoreSwing) reasons.push('score-swing')
  if (!early && random() < config.auditSampleRate) reasons.push('audit')
  return { enabled: reasons.length > 0, reasons, candidateScoreGap: gap, opponentThreat: threat, scoreSwing: swing }
}

/** 一场牌共用一个协调器；roundIndex 变化即自然切换小局限额。深思请求最多等待 40 秒。 */
export class ConditionalReasoningCoordinator {
  private matchUses = 0
  private readonly roundSeatUses = new Map<string, number>()
  private readonly roundSeatSoftUses = new Map<string, number>()
  private lastRoundIndex: number | null = null

  constructor(
    readonly config: ConditionalReasoningConfig = DEFAULT_CONDITIONAL_REASONING,
    private readonly random: () => number = Math.random,
  ) {}

  admit(request: DecisionRequest, seat: number, remainingBudgetMs: number): ReasoningTriggerResult {
    if (this.lastRoundIndex !== null && request.state.roundIndex < this.lastRoundIndex) this.reset()
    this.lastRoundIndex = request.state.roundIndex
    const result = evaluateReasoningTriggers(request, this.config, this.random)
    const round = request.state.roundIndex
    const roundSeatKey = `${round}:${seat}`
    const strong = result.reasons.some((reason) => reason !== 'close-candidates' && reason !== 'audit')
    const allowed = this.config.enabled
      && remainingBudgetMs >= this.config.minRemainingBudgetMs
      && this.matchUses < this.config.maxPerMatch
      && (this.roundSeatUses.get(roundSeatKey) ?? 0) < this.config.maxPerSeatPerRound
      && (strong || (this.roundSeatSoftUses.get(roundSeatKey) ?? 0) < this.config.maxSoftPerSeatPerRound)
      && result.enabled
    if (!allowed) return { ...result, enabled: false }
    this.matchUses += 1
    this.roundSeatUses.set(roundSeatKey, (this.roundSeatUses.get(roundSeatKey) ?? 0) + 1)
    if (!strong) this.roundSeatSoftUses.set(roundSeatKey, (this.roundSeatSoftUses.get(roundSeatKey) ?? 0) + 1)
    return result
  }

  reset(): void {
    this.matchUses = 0
    this.roundSeatUses.clear()
    this.roundSeatSoftUses.clear()
    this.lastRoundIndex = null
  }
}
