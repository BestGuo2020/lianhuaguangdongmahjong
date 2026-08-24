// 候选枚举 + 引擎特征计算 —— docs/llm-ai-design.md §4/§5/§6。
// 职责：从控制器上下文（含 v1.1 元数据）构建规范 DecisionRequest；
// LLM 只能在候选编号内选择；合法性复核在控制器/引擎执行层再次进行。
import type { Meld, TileType } from '../core/contracts/types'
import { DEFAULT_RULESET } from '../core/rules/ruleset'
import { matchingCount, applyKongScore } from '../core/rules/rules'
import { decideTurn as coreDecideTurn, decideClaim as coreDecideClaim } from '../core/controllers/ai'
import { decideTurn as lotusDecideTurn, decideClaim as lotusDecideClaim } from '../variants/lotus/lotusAi'
import {
  LOTUS_RULESET, evaluateBasePattern, windKong, waitingTiles as lotusWaitingTiles, type BasePattern, type ChiMeld,
} from '../variants/lotus/lotusRules'
import { hasReadyDiscard, projectKongBloom } from '../variants/lotus/kongProjection'
import {
  tileName, type Candidate, type CanonicalAction, type DecisionKind, type DecisionRequest,
  type RuleCode, type StateSnapshotV1, type TileName,
} from './schema'

export interface DecisionInput {
  ruleCode: RuleCode
  decision: Extract<DecisionKind, 'turn' | 'claim'>
  /** 决策者座位（绝对索引） */
  playerIndex: number
  hand: TileType[]
  melds: Meld[]
  exposedMelds: number
  kongBloom?: boolean
  skipDraw?: boolean
  // claim 专属：
  canPeng?: boolean
  canGang?: boolean
  chiOptions?: ChiMeld[]
  tile?: TileType
  from?: number
  // v1.1 元数据（LlMAdapterFields）：
  scores?: number[]
  peers?: Array<{ discards: TileType[]; melds: Array<{ type: string; tile: TileType; tiles: TileType[] }> }>
  seatWind?: string
  roundWind?: string
  dealerIndex?: number
  roundIndex?: number
  requestId?: string
  stateVersion?: string
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  upperLastDiscard?: TileType | null
  earlyRound?: boolean
  wallCount?: number
  jokerTiles?: TileType[]
  wildcardTiles?: TileType[]
}

export interface BuiltRequest {
  request: DecisionRequest | null
  /** 回退动作：候选白名单之一或 null（无候选时由调用方按规则短路） */
  fallbackAction: CanonicalAction | null
}

const isLotus = (input: DecisionInput) => input.ruleCode === 'lotus-legacy'

const SPECIAL_PATTERN_LABELS: Partial<Record<BasePattern, string>> = {
  sevenPairs: '七对子', shiSanLan: '十三烂', qiXing: '七星十三烂', thirteenOrphans: '十三幺',
}

function jokersOf(input: DecisionInput): TileType[] {
  return input.jokerTiles ?? (isLotus(input) ? [] : [])
}

function wildcardsOf(input: DecisionInput): TileType[] {
  return input.wildcardTiles ?? (isLotus(input) ? ['white'] : [])
}

/** 广麻保护白板；莲花麻将保护双精牌和受限替代白板。 */
export function protectedDiscardTiles(input: DecisionInput): Set<TileType> {
  return new Set(isLotus(input) ? [...jokersOf(input), ...wildcardsOf(input)] : ['white'])
}

function countsOf(input: DecisionInput): Map<TileType, number> {
  const map = new Map<TileType, number>()
  for (const tile of input.visibleTiles ?? []) map.set(tile, (map.get(tile) ?? 0) + 1)
  return map
}

/** 听口：给定手牌（3n+1 听牌态）能胡的牌。 */
function waitsOf(input: DecisionInput, hand: TileType[]): TileType[] {
  const exposed = input.exposedMelds
  if (isLotus(input)) {
    return lotusWaitingTiles(hand, exposed, jokersOf(input), wildcardsOf(input))
  }
  return DEFAULT_RULESET.win.waitingTiles(hand, exposed)
}

function isTenpai(input: DecisionInput, hand: TileType[]): boolean {
  if (isLotus(input)) return hasReadyDiscard(hand, input.exposedMelds, jokersOf(input))
  const protectedTiles = protectedDiscardTiles(input)
  const hasNatural = hand.some((tile) => !protectedTiles.has(tile))
  return hand.some((tile, index) => {
    if (hasNatural && protectedTiles.has(tile)) return false
    return waitsOf(input, hand.filter((_, candidateIndex) => candidateIndex !== index)).length > 0
  })
}

/** 基础牌效分：同牌×4 + 相邻靠张×2 + 字牌罚 6（与两套启发式一致的确定性简化）。 */
export function heuristicScore(hand: TileType[], tile: TileType, protectedTiles: ReadonlySet<TileType> = new Set()): number {
  const same = matchingCount(hand, tile) - 1
  const suited = /^([mps])([1-9])$/.exec(tile)
  let neighbors = 0
  if (suited) {
    const rank = Number(suited[2])
    neighbors += hand.includes(`${suited[1]}${rank - 1}` as TileType) ? 1 : 0
    neighbors += hand.includes(`${suited[1]}${rank + 1}` as TileType) ? 1 : 0
  }
  const honor = suited ? 0 : 6
  return same * 4 + neighbors * 2 + honor + (protectedTiles.has(tile) ? 100 : 0)
}

function specialPatternOf(input: DecisionInput, hand: TileType[], waits: TileType[]): string {
  if (!isLotus(input) || input.exposedMelds > 0 || waits.length === 0) return 'none'
  const patterns = new Set<string>()
  for (const wait of waits) {
    const result = evaluateBasePattern(
      [...hand, wait], input.exposedMelds, jokersOf(input), [], wildcardsOf(input),
    )
    const label = result ? SPECIAL_PATTERN_LABELS[result.pattern] : undefined
    if (label) patterns.add(`${label}听牌`)
  }
  return patterns.size ? [...patterns].join('、') : 'none'
}

function safetyBand(input: DecisionInput, tile: TileType): '高' | '中' | '低' {
  if (input.upperLastDiscard === tile) return '高'
  const count = matchingCount(input.publicTiles ?? [], tile)
  if (count >= 2) return '高'
  if (count === 1) return '中'
  return '低'
}

/** 剩余张数 = 4 - 可见张数（可见 = 己手+牌河+副露，传入方保证）。 */
function remaining(input: DecisionInput, tile: TileType): number {
  return Math.max(0, 4 - (countsOf(input).get(tile) ?? 0))
}

/** 打出某张后的听口质量（听牌 + 听口明细 + 有效剩余）。 */
function qualityOf(input: DecisionInput, after: TileType[]) {
  const waits = waitsOf(input, after)
  if (waits.length === 0) {
    return { ready: false as const, waits: [] as TileType[], effectiveRemaining: 0 }
  }
  const effectiveRemaining = waits.reduce((sum, tile) => sum + remaining(input, tile), 0)
  return { ready: true as const, waits, effectiveRemaining }
}

function featuresOf(
  input: DecisionInput,
  action: CanonicalAction,
  efficiency: '优' | '中' | '差' | 'unknown',
): Candidate['features'] {
  const id = action.kind === 'discard' ? action.handIndex : action.kind === 'added-kong' ? action.meldIndex : -1
  const base: Candidate['features'] = {
    ready: 'unknown', waits: 'n/a', effectiveRemaining: 'n/a',
    specialPattern: 'n/a', safety: 'unknown', efficiency, risks: [],
  }
  // discard / peng / chi 后的听口
  if (action.kind === 'discard') {
    const after = input.hand.filter((_, index) => index !== id)
    const quality = qualityOf(input, after)
    base.ready = quality.ready
    base.waits = quality.ready
      ? quality.waits.map((t) => ({ tile: tileName(t), remaining: remaining(input, t) }))
      : 'n/a'
    base.effectiveRemaining = quality.ready ? quality.effectiveRemaining : 'n/a'
    base.specialPattern = specialPatternOf(input, after, quality.waits)
    base.safety = safetyBand(input, input.hand[id])
    if (protectedDiscardTiles(input).has(input.hand[id])) {
      base.risks.push('癞子/精牌，通常必须保留；当前无普通牌可打')
    }
    return base
  }
  if (action.kind === 'gang') {
    base.ready = 'unknown'
    base.safety = input.tile ? safetyBand(input, input.tile) : 'unknown'
    base.risks = isTenpai(input, input.hand) ? ['碰/杠可能破坏听牌'] : []
    if (input.tile) base.scoreDeltaBand = scoreDeltaBand(input, action)
    return base
  }
  if (action.kind === 'peng' || action.kind === 'chi') {
    const after = removeClaimed(input, action)
    const best = bestDiscardQuality(input, after, input.exposedMelds + 1)
    if (best) {
      base.ready = best.ready
      base.waits = best.ready ? best.waits.map((t) => ({ tile: tileName(t), remaining: remaining(input, t) })) : 'n/a'
      base.effectiveRemaining = best.ready ? best.effectiveRemaining : 'n/a'
    }
    base.specialPattern = 'none'
    base.safety = input.tile ? safetyBand(input, input.tile) : 'unknown'
    // 副露后仍有可弃牌由控制器自校验；这里只评估听口 vs 现状
    const baseline = bestDiscardQuality(input, input.hand, input.exposedMelds)
    const post = best
    base.efficiency = post && baseline && post.waits.length > baseline.waits.length ? '优'
      : post && baseline && post.waits.length === baseline.waits.length ? '中' : '差'
    return base
  }
  if (action.kind === 'added-kong' || action.kind === 'concealed-kong' || action.kind === 'wind-kong') {
    base.ready = 'unknown'
    base.waits = 'n/a'
    base.specialPattern = 'none'
    base.safety = action.kind === 'concealed-kong'
      ? safetyBand(input, action.tile)
      : action.kind === 'wind-kong' ? 'unknown' : safetyBand(input, input.melds[id]?.tile ?? '' as TileType)
    const risks: string[] = []
    if (isTenpai(input, input.hand)) risks.push('可能破坏听牌')
    if (action.kind === 'added-kong') {
      const tile = input.melds[id]?.tile
      if (tile && matchingCount(input.publicTiles ?? [], tile) === 0) risks.push('被抢杠概率较高')
    }
    base.risks = risks
    base.scoreDeltaBand = scoreDeltaBand(input, action)
    return base
  }
  // pass
  base.ready = 'unknown'
  base.waits = 'n/a'
  base.specialPattern = 'n/a'
  base.safety = 'n/a'
  return base
}

function removeClaimed(input: DecisionInput, action: Extract<CanonicalAction, { kind: 'peng' | 'chi' }>): TileType[] {
  if (action.kind === 'peng') {
    if (!input.tile) return input.hand
    let removed = 0
    return input.hand.filter((t) => {
      if (t === input.tile && removed < 2) { removed += 1; return false }
      return true
    })
  }
  const meld = (input.chiOptions ?? [])[action.optionIndex]
  if (!meld) return input.hand
  const remainingHand = [...input.hand]
  for (const t of meld.tiles) {
    if (t === input.tile) continue
    const index = remainingHand.indexOf(t)
    if (index >= 0) remainingHand.splice(index, 1)
  }
  return remainingHand
}

/** 副露后（再弃一张）的最佳听口质量。 */
function bestDiscardQuality(input: DecisionInput, hand: TileType[], exposedMelds: number) {
  let best: { ready: boolean; waits: TileType[]; effectiveRemaining: number } | null = null
  for (let index = 0; index < hand.length; index += 1) {
    const after = hand.filter((_, i) => i !== index)
    const quality = qualityOf(input, after)
    if (best === null || quality.waits.length > best.waits.length) best = quality
  }
  return best
}

/** 杠分（即时收益）档位：在克隆分数上应用规则集杠分，delta>0 按档位。 */
function scoreDeltaBand(input: DecisionInput, action: CanonicalAction): '高' | '中' | 'n/a' {
  const playerIndex = input.playerIndex
  const scores = input.scores
  if (!scores || !scores[playerIndex]) return 'n/a'
  const before = scores[playerIndex]
  const players = scores.map((score) => ({ score })) as unknown as Array<{ score: number }>
  if (action.kind === 'added-kong') {
    applyKongScore(players as never, playerIndex, 'added', input.from ?? null)
  } else if (action.kind === 'concealed-kong') {
    applyKongScore(players as never, playerIndex, 'concealed', null)
  } else if (action.kind === 'wind-kong') {
    applyKongScore(players as never, playerIndex, 'concealed', null)
  } else if (action.kind === 'gang') {
    applyKongScore(players as never, playerIndex, 'discard', input.from ?? null)
  } else {
    return 'n/a'
  }
  const delta = (players[playerIndex] as { score: number }).score - before
  if (delta <= 0) return 'n/a'
  return delta >= 400 ? '高' : '中'
}

/** 排序 & 档位化：候选内确定性排序（§5 tie-break：牌面固定顺序由候选枚举顺序保证）。 */
function bandedEfficiency(scores: Array<{ index?: number; heuristic: number }>, side: 'discard' | 'claim'): Map<number, '优' | '中' | '差'> {
  const sorted = [...scores].sort((a, b) => a.heuristic - b.heuristic)
  const map = new Map<number, '优' | '中' | '差'>()
  sorted.forEach((entry, rank) => {
    const fraction = sorted.length <= 1 ? 0 : rank / (sorted.length - 1)
    map.set(entry.index ?? rank, fraction <= 0.34 ? '优' : fraction <= 0.67 ? '中' : '差')
  })
  return map
}

function snapshotOf(input: DecisionInput): StateSnapshotV1 {
  const peers = input.peers ?? []
  const rel = (offset: number) => {
    const index = ((input.playerIndex + offset) % 4 + 4) % 4
    const peer = peers[index]
    return {
      discards: (peer?.discards ?? []).map(tileName),
      melds: (peer?.melds ?? []).map((meld) => ({ type: meld.type, tile: tileName(meld.tile), tiles: meld.tiles.map(tileName) })),
    }
  }
  return {
    schemaVersion: 1,
    requestId: input.requestId ?? '',
    stateVersion: input.stateVersion ?? '',
    ruleCode: input.ruleCode,
    decision: input.decision,
    hand: input.hand.map(tileName),
    melds: input.melds.map((meld) => ({
      type: meld.type, tile: tileName(meld.tile), tiles: meld.tiles.map(tileName),
    })),
    snapshots: { self: rel(0), upper: rel(-1), opposite: rel(2), lower: rel(1) },
    upperLastDiscard: input.upperLastDiscard ? tileName(input.upperLastDiscard) : null,
    jokerTiles: jokersOf(input).map(tileName),
    wildcardTiles: wildcardsOf(input).map(tileName),
    wallCount: input.wallCount ?? 0,
    earlyRound: input.earlyRound ?? false,
    lateGame: (input.wallCount ?? 99) <= 8,
    scores: input.scores ?? [],
    seatWind: input.seatWind ?? '',
    roundWind: input.roundWind ?? '',
    dealerIndex: input.dealerIndex ?? -1,
    roundIndex: input.roundIndex ?? 0,
    dihu: false,
  }
}

/** 构建规范请求；跳过（claim 无候选可决策）时返回 request=null。 */
export function buildDecisionRequest(input: DecisionInput): BuiltRequest {
  const candidates = input.decision === 'turn' ? turnCandidates(input) : claimCandidates(input)
  if (candidates.length === 0) return { request: null, fallbackAction: null }
  // 引擎建议：确定性启发式（random=0），映射到候选 ID
  const suggestionAction = input.decision === 'turn'
    ? suggestionForTurn(input)
    : suggestionForClaim(input)
  const suggestionId = suggestionAction
    ? candidates.find((candidate) => actionsMatch(candidate.action, suggestionAction))?.id
    : undefined
  return {
    request: {
      schemaVersion: 1,
      requestId: input.requestId ?? '',
      stateVersion: input.stateVersion ?? '',
      ruleCode: input.ruleCode,
      decision: input.decision,
      state: snapshotOf(input),
      candidates,
      engineSuggestion: suggestionId,
    } satisfies DecisionRequest,
    fallbackAction: candidates[suggestionId ? candidates.findIndex((c) => c.id === suggestionId) : 0]?.action ?? candidates[0].action,
  }
}

function turnCandidates(input: DecisionInput): Candidate[] {
  const candidates: Candidate[] = []
  const skipDraw = input.skipDraw ?? false
  const currentReady = isLotus(input) && isTenpai(input, input.hand)
  // skipDraw：只允许出牌（§4.1；胡由控制器短路，杠非法）
  if (!skipDraw) {
    input.melds.forEach((meld, meldIndex) => {
      if (meld.type === 'peng' && input.hand.includes(meld.tile)) {
        candidates.push(candidateOf(input, { id: `K${meldIndex + 1}`, label: `补杠${tileName(meld.tile)}`, action: { kind: 'added-kong', meldIndex } }))
      }
    })
    for (const tile of concealedKongsOf(input)) {
      const guaranteed = isLotus(input) && projectKongBloom({
        kind: 'concealed-kong', hand: input.hand, exposedMelds: input.exposedMelds,
        jokers: jokersOf(input), tile, visibleTiles: input.visibleTiles,
      }).guaranteedKongBloom
      if (!currentReady || guaranteed) {
        candidates.push(candidateOf(input, { id: `G${tile}`, label: `暗杠${tileName(tile)}`, action: { kind: 'concealed-kong', tile } }))
      }
    }
    if (isLotus(input) && windKong(input.hand, jokersOf(input))) {
      const guaranteed = projectKongBloom({
        kind: 'wind-kong', hand: input.hand, exposedMelds: input.exposedMelds,
        jokers: jokersOf(input), visibleTiles: input.visibleTiles,
      }).guaranteedKongBloom
      if (!currentReady || guaranteed) {
        candidates.push(candidateOf(input, { id: 'GW', label: '乱风杠', action: { kind: 'wind-kong' } }))
      }
    }
  }
  const discardScores: Array<{ index: number; heuristic: number }> = []
  const protectedTiles = protectedDiscardTiles(input)
  const hasNaturalDiscard = input.hand.some((tile) => !protectedTiles.has(tile))
  const seen = new Set<TileType>()
  input.hand.forEach((tile, handIndex) => {
    if (hasNaturalDiscard && protectedTiles.has(tile)) return
    if (seen.has(tile)) return
    seen.add(tile)
    candidates.push({
      id: `A${discardScores.length + 1}`,
      label: `出${tileName(tile)}`,
      action: { kind: 'discard', handIndex },
      features: { ready: 'unknown' as const, waits: 'n/a' as const, effectiveRemaining: 'n/a' as const, specialPattern: 'none', safety: 'unknown' as const, efficiency: '差', risks: [] },
      legalityKey: `discard:${tile}`,
    })
    discardScores.push({ index: candidates.length - 1, heuristic: heuristicScore(input.hand, tile, protectedTiles) })
  })
  // 听口/安全度回填 + 确定性档位
  const bands = bandedEfficiency(discardScores.map((d) => ({ index: d.index, heuristic: d.heuristic })), 'discard')
  candidates.forEach((candidate, index) => {
    if (candidate.action.kind !== 'discard') return
    candidate.features = featuresOf(input, candidate.action, bands.get(index) ?? '中')
  })
  return candidates
}

function claimCandidates(input: DecisionInput): Candidate[] {
  const candidates: Candidate[] = []
  const canGang = input.canGang ?? false
  const canPeng = input.canPeng ?? false
  candidates.push({ id: 'Z', label: '过', action: { kind: 'pass' }, features: featuresOf(input, { kind: 'pass' }, 'unknown'), legalityKey: 'pass' })
  if (canGang) {
    candidates.push({ id: 'G', label: `杠${input.tile ? tileName(input.tile) : ''}`, action: { kind: 'gang' }, features: featuresOf(input, { kind: 'gang' }, '中'), legalityKey: 'gang' })
  }
  if (canPeng) {
    candidates.push({ id: 'P', label: `碰${input.tile ? tileName(input.tile) : ''}`, action: { kind: 'peng' }, features: featuresOf(input, { kind: 'peng' }, '中'), legalityKey: 'peng' })
  }
  ;(input.chiOptions ?? []).forEach((meld, optionIndex) => {
    candidates.push({
      id: `C${optionIndex + 1}`,
      label: `吃${meld.tiles.map(tileName).join('+')}`,
      action: { kind: 'chi', optionIndex },
      features: featuresOf(input, { kind: 'chi', optionIndex }, '中'),
      legalityKey: `chi:${optionIndex}`,
    })
  })
  return candidates
}

function candidateOf(input: DecisionInput, spec: {
  id: string; label: string; action: CanonicalAction
}): Candidate {
  return {
    id: spec.id,
    label: spec.label,
    action: spec.action,
    features: featuresOf(input, spec.action, '中'),
    legalityKey: legalityKeyOf(spec.action),
  }
}

function legalityKeyOf(action: CanonicalAction): string {
  switch (action.kind) {
    case 'added-kong': return `added-kong:${action.meldIndex}`
    case 'concealed-kong': return `concealed-kong:${action.tile}`
    case 'wind-kong': return 'wind-kong'
    case 'discard': return `discard:${action.handIndex}`
    default: return action.kind
  }
}

function concealedKongsOf(input: DecisionInput): TileType[] {
  if (isLotus(input)) return LOTUS_RULESET.win.concealedKongs(input.hand, { jokers: jokersOf(input) })
  return DEFAULT_RULESET.win.concealedKongs(input.hand)
}

function suggestionForTurn(input: DecisionInput): CanonicalAction | null {
  if (isLotus(input)) {
    const decision = lotusDecideTurn({
      hand: input.hand, melds: input.melds, exposedMelds: input.exposedMelds, kongBloom: input.kongBloom ?? false,
      jokers: jokersOf(input), visibleTiles: input.visibleTiles, publicTiles: input.publicTiles,
      upperLastDiscard: input.upperLastDiscard ?? undefined, earlyRound: input.earlyRound, wallCount: input.wallCount,
      ruleset: LOTUS_RULESET,
    }, () => 0)
    return decision.kind === 'win' ? null : decision as CanonicalAction
  }
  const decision = coreDecideTurn({
    hand: input.hand, melds: input.melds, exposedMelds: input.exposedMelds, kongBloom: input.kongBloom ?? false,
    ruleset: DEFAULT_RULESET,
  }, () => 0)
  return decision.kind === 'win' ? null : decision as CanonicalAction
}

function suggestionForClaim(input: DecisionInput): CanonicalAction | null {
  if (isLotus(input)) {
    const decision = lotusDecideClaim({
      hand: input.hand, exposedMelds: input.exposedMelds, jokers: jokersOf(input), tile: input.tile,
      from: input.from ?? 0,
      canGang: input.canGang ?? false, canPeng: input.canPeng ?? false, chiOptions: input.chiOptions ?? [],
      visibleTiles: input.visibleTiles, publicTiles: input.publicTiles,
      upperLastDiscard: input.upperLastDiscard ?? undefined, earlyRound: input.earlyRound, wallCount: input.wallCount,
    })
    return decision.kind === 'pass' ? { kind: 'pass' } : decision as CanonicalAction
  }
  const decision = coreDecideClaim({
    hand: input.hand, canGang: input.canGang ?? false, tile: input.tile, from: input.from ?? 0,
    exposedMelds: input.exposedMelds, ruleset: DEFAULT_RULESET,
  })
  return { kind: decision }
}

/** 幂等比较：规范动作是否语义一致（discard 按牌面，不按索引）。 */
function actionsMatch(a: CanonicalAction, b: CanonicalAction): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'discard' && b.kind === 'discard') return a.handIndex === b.handIndex
  if ((a.kind === 'added-kong' && b.kind === 'added-kong')) return a.meldIndex === b.meldIndex
  if ((a.kind === 'concealed-kong' && b.kind === 'concealed-kong')) return a.tile === b.tile
  return true
}
