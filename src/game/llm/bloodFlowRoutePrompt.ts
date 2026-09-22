import type { BloodFlowAction } from '../variants/lotus/bloodFlow/state'

const ACTION_NAMES: Record<BloodFlowAction['kind'], string> = {
  win: '胡牌', pass: '过', discard: '弃牌', chi: '吃', peng: '碰', gang: '直杠',
  'concealed-kong': '暗杠', 'added-kong': '补杠', 'wind-kong': '风杠',
}

/** Describe the actual filter result; commitment alone says nothing about which actions survived. */
export function bloodFlowRouteInstruction(input: {
  collapsedByRoute: boolean
  bigHandRoute: { label: string } | null
  candidates: readonly { id: string; action: BloodFlowAction }[]
  collapsedActions: readonly { action: BloodFlowAction }[]
  request: { engineSuggestion?: string }
}): string {
  if (!input.collapsedByRoute) return ''
  const available = [...new Set(input.candidates.map(c => ACTION_NAMES[c.action.kind]))]
  const removed = new Map<BloodFlowAction['kind'], number>()
  for (const { action } of input.collapsedActions) removed.set(action.kind, (removed.get(action.kind) ?? 0) + 1)
  const parts = [
    `已应用${input.bigHandRoute?.label ?? '大牌'}路线的候选筛选。`,
    `当前保留的动作类型：${available.join('、') || '无'}。`,
    removed.size
      ? `本次路线筛除的候选：${[...removed].map(([kind, count]) => `${ACTION_NAMES[kind]}${count}个`).join('、')}。`
      : '本窗口没有因路线筛选移除候选。',
  ]
  if (input.candidates.some(c => c.action.kind === 'win')) parts.push('胡牌仍可选择，应比较即时收益和后续机会。')
  else if (removed.has('win')) parts.push('本次路线筛选已移除胡牌候选。')
  const suggested = input.candidates.find(c => c.id === input.request.engineSuggestion)
  if (suggested) parts.push(`本地推荐是${suggested.id}（${ACTION_NAMES[suggested.action.kind]}）。`)
  parts.push('只选择 candidates 中实际列出的候选ID；路线名称不替代各候选的收益比较。')
  return parts.join('')
}
