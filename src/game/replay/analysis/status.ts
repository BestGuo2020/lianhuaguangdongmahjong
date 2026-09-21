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
 * - `complete` / `partial` / `deleted` 直接对应落库状态；
 * - `missing` / `disabled`（库里没有这一场的记录）再分三种：
 *   本场当时就没开录制 ⇒「未开启」；**开着录制但一条记录都没写** ⇒「未记录到任何数据」
 *   （例如该玩法还没接分析记录 —— 这句必须是"没录到"，不能写成"缺少/丢失"）；其余（旧录像）⇒「缺少决策分析记录」。
 */
export function analysisAreaLabel(subject: AnalysisStatusSubject, status: AnalysisAreaStatus | undefined): string {
  if (!status) return '分析：不可用'      // 分析区整体不可用（无 IndexedDB／驱动因失败停用）
  if (status === 'complete') return '分析：完整'
  if (status === 'partial') return '分析：部分缺失'
  if (status === 'deleted') return '分析：已删除'
  if (subject.analysisRecorded === false) return '分析：未开启'
  // 开着录制却拿不到这一场的数据：只可能是"这一场什么都没写进去"（玩法未接线、或全程没有决策窗口），
  // 不能写成"缺少决策分析记录" —— 那是"曾经有、现在丢了"的意思（§10.7 的两态区分）。
  if (subject.analysisRecorded === true) return '分析：未记录到任何数据'
  return '分析：缺少决策分析记录'
}

/** 有分析记录可读（可导出、可删除）。 */
export function analysisHasRecords(status: AnalysisAreaStatus | undefined): boolean {
  return status === 'complete' || status === 'partial'
}
