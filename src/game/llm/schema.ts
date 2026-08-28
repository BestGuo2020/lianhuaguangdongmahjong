// 规范请求/动作/特征类型 —— docs/llm-ai-design.md §2.1 / §6.4。
// 只做类型与镜像映射（无副作用）；前后端共用同一形状，差异作为 golden fixture 比对失败。
import type { TileType } from '../core/contracts/types'

/** 线协议规则 ID：只允许这两个值（后端内部 lianhua_guangma 只能经显式映射进入协议） */
export type RuleCode = 'lotus-classic' | 'lotus-legacy'

/** 决策类型：v1 只调用 turn/claim；discard_hu/rob_kong 保留在枚举以免遗漏控制器方法 */
export type DecisionKind = 'turn' | 'claim' | 'discard_hu' | 'rob_kong'

/** 中文牌名（prompt/规范状态一律用中文，见 §6.1） */
export type TileName = string

export type Band = '高' | '中' | '低'

export interface CandidateFeatures {
  shanten: number | 'n/a'
  ukeire: number | 'n/a'
  effectiveTiles: Array<{ tile: TileName; remaining: number }> | 'n/a'
  ready: boolean | 'unknown'
  waits: Array<{ tile: TileName; remaining: number }> | 'n/a'
  effectiveRemaining: number | 'n/a'
  specialPattern: string | 'none' | 'n/a'
  safety: Band | 'unknown' | 'n/a'
  efficiency: '优' | '中' | '差' | 'unknown' | 'n/a'
  /** 候选带来的即时自身收益档位（规则集在克隆分数上计算）；无即时收益 n/a（§5/§6.4） */
  scoreDeltaBand?: Band | 'n/a'
  /** 条件深思触发器使用的规则引擎即时收益；Prompt 仍只展示档位。 */
  scoreDelta?: number
  risks: string[]
}

/** 规范动作：内部牌面/索引，不直接等同 WS 报文（§6.4） */
export type CanonicalAction =
  | { kind: 'win' }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'wind-kong' }
  | { kind: 'discard'; handIndex: number }
  | { kind: 'gang' }
  | { kind: 'peng' }
  | { kind: 'chi'; optionIndex: number }
  | { kind: 'pass' }

export interface Candidate {
  /** 本次请求内唯一，如 A1 */
  id: string
  /** 仅用于 Prompt 展示 */
  label: string
  action: CanonicalAction
  features: CandidateFeatures
  /** 引擎状态摘要，用于执行前复核 */
  legalityKey: string
}

export interface MeldView {
  type: string
  tile: TileName
  tiles: TileName[]
}

export interface DiscardView {
  discards: TileName[]
  melds: MeldView[]
}

/** 规范化可见状态快照（§6.2）：只含当前玩家可见信息 */
export interface StateSnapshotV1 {
  schemaVersion: 1
  requestId: string
  stateVersion: string
  ruleCode: RuleCode
  decision: DecisionKind
  hand: TileName[]
  turnOrigin: 'draw' | 'peng' | 'chi' | 'kong-draw' | 'opening' | 'claim-response'
  drawnTile: TileName | null
  claimTile: TileName | null
  claimFrom: '上家' | '对家' | '下家' | null
  melds: MeldView[]
  snapshots: {
    self: DiscardView
    upper: DiscardView
    opposite: DiscardView
    lower: DiscardView
  }
  upperLastDiscard: TileName | null
  jokerTiles: TileName[]
  wildcardTiles: TileName[]
  wallCount: number
  earlyRound: boolean
  lateGame: boolean
  scores: number[]
  seatWind: string
  roundWind: string
  dealerIndex: number
  /** 当前决策者本人是否为庄家；避免模型猜测绝对座位编号。 */
  isDealer: boolean
  roundIndex: number
  dihu: boolean
}

export interface DecisionRequest {
  schemaVersion: 1
  requestId: string
  stateVersion: string
  ruleCode: RuleCode
  decision: DecisionKind
  state: StateSnapshotV1
  candidates: Candidate[]
  /** 引擎建议的候选 ID（确定性启发式 top-1）；回退即执行它 */
  engineSuggestion?: string
}

/** LLM 输出（解析产物） */
export interface LlmOutput {
  choice: string
  message: string
}

/** 来自供应商的原始回复解析失败 */
export class LlmParseError extends Error {}

/** 内部牌面 → 中文牌名（§6.1 固定映射） */
const TILE_NAMES: Record<TileType, string> = {
  m1: '1万', m2: '2万', m3: '3万', m4: '4万', m5: '5万', m6: '6万', m7: '7万', m8: '8万', m9: '9万',
  p1: '1筒', p2: '2筒', p3: '3筒', p4: '4筒', p5: '5筒', p6: '6筒', p7: '7筒', p8: '8筒', p9: '9筒',
  s1: '1条', s2: '2条', s3: '3条', s4: '4条', s5: '5条', s6: '6条', s7: '7条', s8: '8条', s9: '9条',
  east: '东风', south: '南风', west: '西风', north: '北风', red: '红中', green: '发财', white: '白板',
}

export function tileName(tile: TileType): TileName {
  return TILE_NAMES[tile]
}

/** 中文牌名 → 内部牌面；未知返回 undefined（用于输出校验） */
export function tileFromName(name: string): TileType | undefined {
  const entry = Object.entries(TILE_NAMES).find(([, value]) => value === name)
  return entry?.[0] as TileType | undefined
}

/** 规则集代码 → 线协议规则 ID */
export function toRuleCode(code: string): RuleCode {
  if (code === 'lotus-legacy') return 'lotus-legacy'
  return 'lotus-classic'
}
