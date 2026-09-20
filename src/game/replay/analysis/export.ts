// 分析包导出（方案 §9.2、§9.3、§9.5、§10.7）。
//
// 设计约束：
// - **自包含**：§9.2 要求"分析包必须包含其依赖的局面／配置，不能导出一堆只能在原数据库解析的引用"。
//   因此包里同时带三样东西：分析记录（decisions／states／llmAttempts／settlements／reproduction）、
//   被它们引用的配置（按版本去重的那份），以及**展示回放本身**（§9.3 把公开字段的唯一来源定为展示回放，
//   不带它就无法还原公开局面）。依赖清单（manifest）逐项列出带了什么，读方可核对引用是否闭合。
// - **不谎称完整**：分析记录缺失／不完整时如实标注（`reproductionCapable` 为 false），
//   导出成功不等于"可精确复现"（§9.5、§10.6）。
// - 格式版本独立于展示回放（`ANALYSIS_FORMAT_VERSION`）；读到无法识别的版本时明确标记，
//   不按当前格式硬解（§9.5）。
import type { ReplayMatch, ReplayRound } from '../types'
import { REPLAY_SCHEMA_VERSION } from '../types'
import { downloadJsonFile } from '../export'
import { ANALYSIS_FORMAT_VERSION, type AnalysisAreaStatus, type AnalysisCompleteness } from './types'
import type { AnalysisBlockPart } from './codec'

export interface AnalysisExportCounts { [tag: string]: number }

export interface AnalysisExportPayload {
  schemaVersion: number
  kind: 'lianhua-analysis'
  exportedAt: number
  /** 分析区状态（未开启／完整／部分缺失／已删除）。 */
  status: AnalysisAreaStatus
  completeness: AnalysisCompleteness
  /** 缺了哪一段、为什么（§9.5）；空数组表示没有已知缺失。 */
  gaps: Array<{ scope: string; from?: number; to?: number; reason: string }>
  /**
   * 能不能用这份包做 §10.6 的精确复现：只有"完整 + 有复现数据"才为 true。
   * 不完整时明确为 false，避免"导出成功"被读成"可以精确复现"。
   */
  reproductionCapable: boolean
  /** 引用闭合清单：带走了什么、还差什么。 */
  manifest: {
    records: AnalysisExportCounts
    recordsTotal: number
    configurations: number
    replayRounds: number
    includesReplay: boolean
    /** 记录里引用到的配置 id 是否都在 `configurations` 中（引用闭合的机器可判据）。 */
    configReferencesClosed: boolean
    missing: string[]
  }
  match: ReplayMatch
  /** 配置按版本去重存一份（§3.1、§9.4）：分析记录只引用它们，不重复内嵌。 */
  configurations: unknown[]
  /** 分析记录（已解码；tag 用于分流：config／decisionState／decision／llmAttempt／settlement／reproduction）。 */
  records: AnalysisBlockPart[]
  /** 展示回放（§9.3：公开字段的唯一来源，必须随包带走）。 */
  replay: { schemaVersion: number; match: ReplayMatch; rounds: ReplayRound[] }
}

export interface BuildAnalysisExportInput {
  match: ReplayMatch
  /** 展示回放的各局事件流（§9.3 的公开字段来源）。 */
  rounds: readonly ReplayRound[]
  /** 分析区已解码的记录；为空表示这场没有分析数据（未开启或已删除）。 */
  parts: readonly AnalysisBlockPart[]
  /** 该场引用的配置正文（storage.readConfigs）。 */
  configurations: readonly unknown[]
  status: AnalysisAreaStatus
  gaps?: ReadonlyArray<{ scope: string; from?: number; to?: number; reason: string }>
  exportedAt?: number
}

/** 记录里出现过的配置 id（决策与配置记录都引用它）。 */
function referencedConfigIds(parts: readonly AnalysisBlockPart[]): string[] {
  const ids = new Set<string>()
  for (const part of parts) {
    const value = part.value as { id?: unknown; configId?: unknown } | null
    if (!value || typeof value !== 'object') continue
    if (part.tag === 'config' && typeof value.id === 'string') ids.add(value.id)
    if (typeof value.configId === 'string') ids.add(value.configId)
  }
  return [...ids]
}

function configIdOf(value: unknown): string | null {
  const record = value as { id?: unknown } | null
  return record && typeof record === 'object' && typeof record.id === 'string' ? record.id : null
}

/**
 * 打包分析包。`available` 之外的一切都如实反映输入：缺记录就是缺记录，不补造。
 * 纯函数，便于单测；下载由 `downloadAnalysisExport` 负责（浏览器专用）。
 */
export function buildAnalysisExport(input: BuildAnalysisExportInput): AnalysisExportPayload {
  const records = [...input.parts]
  const counts: AnalysisExportCounts = {}
  for (const part of records) counts[part.tag] = (counts[part.tag] ?? 0) + 1
  const hasReproduction = (counts.reproduction ?? 0) > 0
  const complete = input.status === 'complete'
  const wantedConfigs = referencedConfigIds(records)
  const providedConfigs = new Set(input.configurations.map(configIdOf).filter((id): id is string => Boolean(id)))
  const missing: string[] = []
  for (const id of wantedConfigs) if (!providedConfigs.has(id)) missing.push(`配置 ${id}`)
  if (!records.length) missing.push('分析记录（这场未开启分析录制或已删除）')
  if (complete && !hasReproduction) missing.push('复现数据（reproduction）')
  const configReferencesClosed = wantedConfigs.every(id => providedConfigs.has(id))
  return {
    schemaVersion: ANALYSIS_FORMAT_VERSION,
    kind: 'lianhua-analysis',
    exportedAt: input.exportedAt ?? Date.now(),
    status: input.status,
    completeness: input.status === 'deleted' ? 'missing' : complete ? 'complete' : records.length ? 'partial' : 'missing',
    gaps: [...(input.gaps ?? [])],
    reproductionCapable: complete && hasReproduction && configReferencesClosed,
    manifest: {
      records: counts,
      recordsTotal: records.length,
      configurations: input.configurations.length,
      replayRounds: input.rounds.length,
      includesReplay: input.rounds.length > 0,
      configReferencesClosed,
      missing,
    },
    match: input.match,
    configurations: [...input.configurations],
    records,
    replay: {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      match: input.match,
      rounds: [...input.rounds].sort((a, b) => a.roundIndex - b.roundIndex),
    },
  }
}

/** 记录里声明的分析格式版本（配置记录上）；读不到返回 null。 */
export function analysisFormatVersionOf(parts: readonly AnalysisBlockPart[]): number | null {
  for (const part of parts) {
    if (part.tag !== 'config') continue
    const version = (part.value as { formatVersion?: unknown } | null)?.formatVersion
    if (typeof version === 'number') return version
  }
  return null
}

/**
 * 版本可读性判定（§9.5）：只认当前格式版本；更高版本明确报"无法识别"，
 * 不按旧规则硬解（那会把新字段悄悄丢掉，看起来像"记录缺字段"）。
 */
export function analysisFormatReadable(parts: readonly AnalysisBlockPart[]): { readable: boolean; version: number | null; reason: string | null } {
  const version = analysisFormatVersionOf(parts)
  if (version === null) return { readable: true, version: null, reason: null }
  if (version > ANALYSIS_FORMAT_VERSION) {
    return { readable: false, version, reason: `分析区格式版本 ${version} 高于本程序识别的 ${ANALYSIS_FORMAT_VERSION}，请升级后再读` }
  }
  return { readable: true, version, reason: null }
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 文件名：与牌谱导出同风格（ASCII，跨平台安全），前缀 analysis- 以便区分。 */
export function analysisExportFilename(match: ReplayMatch, exportedAt = Date.now()): string {
  const date = new Date(exportedAt)
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  const shortId = match.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'match'
  return `analysis-${match.rulesetId}-${stamp}-${shortId}.json`
}

/** 触发浏览器下载（复用牌谱导出的同一实现；无 DOM 环境返回 false）。 */
export function downloadAnalysisExport(payload: AnalysisExportPayload, filename: string): boolean {
  return downloadJsonFile(payload, filename)
}
