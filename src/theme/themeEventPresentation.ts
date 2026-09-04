import type { RoundResult } from '../game/core/contracts/gamePort'
import type { TableActionEvent } from '../game/core/contracts/types'

export type ActionPresentationKind = 'chi' | 'peng' | 'gang' | 'win'
export type PresentationStrength = 'medium' | 'strong' | 'climax'

export interface TableActionPresentation {
  label: string
  kind: ActionPresentationKind
  strength: PresentationStrength
}

export const TABLE_ACTION_PRESENTATIONS = {
  chi: { label: '吃', kind: 'chi', strength: 'medium' },
  peng: { label: '碰', kind: 'peng', strength: 'medium' },
  'discard-gang': { label: '杠', kind: 'gang', strength: 'strong' },
  'concealed-gang': { label: '杠', kind: 'gang', strength: 'strong' },
  'added-gang': { label: '杠', kind: 'gang', strength: 'strong' },
  'flower-gang': { label: '杠', kind: 'gang', strength: 'strong' },
  'wind-kong': { label: '风杠', kind: 'gang', strength: 'strong' },
  'self-draw': { label: '自摸', kind: 'win', strength: 'climax' },
  'discard-win': { label: '胡', kind: 'win', strength: 'climax' },
  'robbed-kong-win': { label: '抢杠胡', kind: 'win', strength: 'climax' },
} as const satisfies Record<TableActionEvent['type'], TableActionPresentation>

export function resolveTableActionPresentation(type: TableActionEvent['type']): TableActionPresentation {
  return TABLE_ACTION_PRESENTATIONS[type]
}

export type RoundResultPresentationKind =
  | 'draw'
  | 'self-draw'
  | 'discard'
  | 'robbed-kong'
  | 'tianhu'
  | 'dihu'

export interface RoundResultPresentation {
  kind: RoundResultPresentationKind
  label: string
  strength: PresentationStrength
}

const ROUND_RESULT_PRESENTATIONS: Record<RoundResultPresentationKind, RoundResultPresentation> = {
  draw: { kind: 'draw', label: '流局', strength: 'medium' },
  'self-draw': { kind: 'self-draw', label: '自摸', strength: 'climax' },
  discard: { kind: 'discard', label: '点炮', strength: 'climax' },
  'robbed-kong': { kind: 'robbed-kong', label: '抢杠胡', strength: 'climax' },
  tianhu: { kind: 'tianhu', label: '天胡', strength: 'climax' },
  dihu: { kind: 'dihu', label: '地胡', strength: 'climax' },
}

export function resolveRoundResultPresentation(result: RoundResult | null | undefined): RoundResultPresentation {
  if (!result || result.draw) return ROUND_RESULT_PRESENTATIONS.draw
  const kind = result.winType
    ?? (result.robbedKong ? 'robbed-kong' : 'self-draw')
  return ROUND_RESULT_PRESENTATIONS[kind]
}

export type ScoreDirection = 'positive' | 'negative' | 'neutral'

export function scoreDirection(amount: number): ScoreDirection {
  if (amount > 0) return 'positive'
  if (amount < 0) return 'negative'
  return 'neutral'
}
