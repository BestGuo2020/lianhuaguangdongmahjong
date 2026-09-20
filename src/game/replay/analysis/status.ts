// 分析区状态的展示口径（§9.2、§10.7）。
//
// 单独成模块的理由：四态 + 旧录像的区分是**规则**，不是排版 ——
// 「未开启」（当时就没开录制）与「缺少决策分析记录」（旧录像、或记录已丢失）含义完全不同，
// 混为一谈会让用户以为分析数据丢过。放在纯函数里才能被单测固定住。
import type { AnalysisAreaStatus } from './types'

/** 列表行需要的场次信息（只取判定用得到的字段，便于测试与复用）。 */
export interface AnalysisStatusSubject {
  /** 录制本场时是否开着分析录制；旧记录没有该字段。 */
  analysisRecorded?: boolean
}

/**
 * 行内状态文案：
 * - `complete` / `partial` / `deleted` / `missing` 直接对应落库状态；
 * - 没有该场的分析元数据时（`disabled`）再分两种：
 *   本场当时就没开录制 ⇒「未开启」；本场开着录制或不知道（旧录像）⇒「缺少决策分析记录」。
 */
export function analysisAreaLabel(subject: AnalysisStatusSubject, status: AnalysisAreaStatus | undefined): string {
  if (!status) return '分析：不可用'      // 分析区整体不可用（无 IndexedDB／驱动因失败停用）
  if (status === 'complete') return '分析：完整'
  if (status === 'partial') return '分析：部分缺失'
  if (status === 'deleted') return '分析：已删除'
  if (status === 'missing') return '分析：缺少决策分析记录'
  // status === 'disabled'：分析区里没有这一场
  return subject.analysisRecorded === false ? '分析：未开启' : '分析：缺少决策分析记录'
}

/** 有分析记录可读（可导出、可删除）。 */
export function analysisHasRecords(status: AnalysisAreaStatus | undefined): boolean {
  return status === 'complete' || status === 'partial'
}
