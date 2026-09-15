// 回放列表与牌谱的纯文案工具（全部无副作用，便于单测）。
import type { MatchType, TileType } from '../core/contracts/types'
import { tileName } from '../core/rules/tiles'
import type { ReplayMatch, ReplayMeldKind, ReplayStep } from './types'

const pad = (value: number) => String(value).padStart(2, '0')

/** 「东风场」/「半庄场」。 */
export const MATCH_NAME_LABELS: Record<MatchType, string> = { east: '东风场', hanchan: '半庄场' }

/**
 * 对局日期：今天 → 「21:03」；本年内 → 「9月14日 21:03」；跨年 → 「2025年9月14日」。
 * 用本地时间手工拼装，避免 toLocaleString 在不同环境下的格式差异。
 */
export function formatMatchDate(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  const today = new Date(now)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  if (sameDay) return time
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}年${day}`
}

/** 位次：1~4 位；未打完显示「—」。 */
export function formatRank(rank?: number): string {
  return typeof rank === 'number' && rank > 0 ? `${rank}位` : '—'
}

export type RankTone = 'first' | 'second' | 'third' | 'fourth' | 'none'

export function rankTone(rank?: number): RankTone {
  if (rank === 1) return 'first'
  if (rank === 2) return 'second'
  if (rank === 3) return 'third'
  if (rank === 4) return 'fourth'
  return 'none'
}

/** 净胜分：带符号，0 显示「±0」。 */
export function formatDelta(delta?: number): string {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return '±0'
  if (delta === 0) return '±0'
  return `${delta > 0 ? '+' : ''}${delta}`
}

/** 局数文案：与 gameSelectors 同一套规则（东风场 1-4 东，半庄场 5-8 南）。 */
export function roundLabelFor(round: number, _matchType: MatchType): string {
  const wind = round > 4 ? '南' : '东'
  return `${wind}${((round - 1) % 4) + 1}局`
}

/** 巡目：每 4 次出牌为一巡。 */
export function formatTurn(turn: number): string {
  return `${Math.max(1, turn)}巡`
}

export function formatPosition(index: number, total: number): string {
  return `${index}/${total}`
}

const MELD_LABELS: Record<ReplayMeldKind, string> = {
  peng: '碰',
  chi: '吃',
  'gang-discard': '杠',
  'gang-concealed': '暗杠',
  'gang-added': '加杠',
  'gang-flower': '花杠',
  'gang-wind': '风杠',
}

export function meldLabel(kind?: ReplayMeldKind): string {
  return kind ? MELD_LABELS[kind] : '鸣牌'
}

/** 牌谱事件一句话文案（不含玩家名，玩家名由组件按座位拼）。 */
export function stepSummary(step: ReplayStep): string {
  const tile = step.tile ? tileName(step.tile) : ''
  switch (step.t) {
    case 'draw':
      return step.fromTail ? `补牌 ${tile}` : `摸 ${tile}`
    case 'discard':
      return `打 ${tile}`
    case 'meld':
      return `${meldLabel(step.kind)} ${tile}`
    case 'win':
      if (step.actionType === 'robbed-kong-win') return `抢杠胡 ${tile}`
      if (step.actionType === 'discard-win') return `胡 ${tile}`
      return `自摸 ${tile}`
    default:
      return tile
  }
}

/** 列表副标题：局数 · 位次 · 净胜分。 */
export function matchSubtitle(match: Pick<ReplayMatch, 'roundCount' | 'myRank' | 'myScore' | 'status'>): string {
  const rounds = `${match.roundCount}局`
  if (match.status === 'aborted') return `${rounds} · 未完成`
  return `${rounds} · ${formatRank(match.myRank)} · ${formatDelta(match.myScore)}分`
}
