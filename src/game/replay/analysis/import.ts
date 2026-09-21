// 分析包导入（方案 §9.2、§9.3、§9.5、§10.7）：把导出的 `lianhua-analysis` 包读回本地。
//
// 为什么必须支持：§9.2 说"需要长期留存某场分析时，出口是导出自包含分析包"，
// 且"导出成功不自动等于可以删除" —— 只有导入能把包变回可读的分析区，
// 这条出口才算真的成立（也让"引用闭合"从声明变成可验证的行为）。
//
// 判定原则与牌谱导入一致：缺字段就报错、引用不闭合就拒绝、版本不认识就拒绝。
// 额外两条针对分析包：
// - **必须自带展示回放**（§9.3 把公开字段的唯一来源定为展示回放），没有它就不算自包含；
// - 包里的记录、配置要能原样写回（不重新计算、不补造），缺什么就报什么。
import type { ReplayMatch, ReplayRound } from '../types'
import type { ReplayStorage } from '../storage'
import type { AnalysisBlockPart } from './codec'
import { ANALYSIS_FORMAT_VERSION, type AnalysisAreaStatus, type AnalysisCompleteness } from './types'
import { analysisFormatReadable } from './export'
import type { AnalysisStorage } from './storage'

export interface AnalysisImportResult {
  ok: boolean
  reason: string | null
  match: ReplayMatch | null
  rounds: ReplayRound[]
  records: AnalysisBlockPart[]
  configurations: unknown[]
  /** 包声明的完整性：导入后要按它落库（不把 partial 的包标成 complete）。 */
  completeness: AnalysisCompleteness
  gaps: Array<{ scope: string; from?: number; to?: number; reason: string }>
  version: { found: number | null; current: number; readable: boolean }
  /** 可读但需要提醒的点（例如缺配置正文但记录不引用它）。 */
  notes: string[]
}

export interface AnalysisImportOutcome extends AnalysisImportResult {
  /** 落库后的场次 id。 */
  importedId: string | null
  /** 写回的分析记录条数（与 `records.length` 不一致即为失败）。 */
  writtenRecords: number
  /** 这次是否连展示回放一起写入了。 */
  wroteReplay: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(reason: string, extra: Partial<AnalysisImportResult> = {}): AnalysisImportResult {
  return {
    ok: false, reason, match: null, rounds: [], records: [], configurations: [],
    completeness: 'missing', gaps: [], version: { found: null, current: ANALYSIS_FORMAT_VERSION, readable: true }, notes: [],
    ...extra,
  }
}

function configIdOf(value: unknown): string | null {
  const record = value as { id?: unknown } | null
  return record && typeof record === 'object' && typeof record.id === 'string' ? record.id : null
}

/** 解析分析包；只判定"能不能安全读回"，不落库（落库见 `importAnalysisFile`）。 */
export function parseAnalysisImport(input: unknown): AnalysisImportResult {
  if (!isRecord(input)) return fail('文件内容不是一个 JSON 对象')
  if (input.kind !== 'lianhua-analysis') {
    return fail(`不是分析包（kind=${String(input.kind ?? '缺失')}，应为 lianhua-analysis）`)
  }
  const parts = Array.isArray(input.records) ? input.records as AnalysisBlockPart[] : null
  if (!parts) return fail('缺少分析记录（records）')
  const version = analysisFormatReadable(parts)
  const versionInfo = { found: version.version, current: ANALYSIS_FORMAT_VERSION, readable: version.readable }
  if (!version.readable) return fail(version.reason ?? '分析包格式版本无法识别', { version: versionInfo })
  if (!parts.length) return fail('分析包里没有任何记录', { version: versionInfo })

  // §9.3：公开字段的唯一来源是展示回放 ⇒ 没有展示回放的包不算自包含，拒绝导入
  const replay = input.replay
  if (!isRecord(replay)) return fail('分析包不含展示回放（replay），无法还原公开局面', { version: versionInfo })
  const match = replay.match
  if (!isRecord(match) || typeof match.id !== 'string' || !match.id) {
    return fail('分析包里的展示回放缺少场次信息（replay.match.id）', { version: versionInfo })
  }
  const roundsRaw = replay.rounds
  if (!Array.isArray(roundsRaw) || !roundsRaw.length) {
    return fail('分析包里的展示回放没有任何一局（replay.rounds 为空）', { version: versionInfo })
  }
  const rounds: ReplayRound[] = []
  for (const [index, entry] of roundsRaw.entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.roundIndex !== 'number' || !Array.isArray(entry.steps)) {
      return fail(`展示回放的第 ${index + 1} 局结构不完整（需要 id／roundIndex／steps）`, { version: versionInfo })
    }
    if (entry.matchId !== match.id) {
      return fail(`展示回放第 ${index + 1} 局的 matchId 与场次 id 不一致（引用不闭合）`, { version: versionInfo })
    }
    rounds.push(entry as unknown as ReplayRound)
  }

  const configurations = Array.isArray(input.configurations) ? [...input.configurations] : []
  const missingConfigIds = parts
    .map(part => (isRecord(part.value) ? (part.value as { configId?: unknown }).configId : undefined))
    .filter((id): id is string => typeof id === 'string')
    .filter(id => !configurations.some(config => configIdOf(config) === id))
  if (missingConfigIds.length) {
    return fail(`分析包缺少被引用的配置正文：${[...new Set(missingConfigIds)].join('、')}（引用不闭合）`, { version: versionInfo })
  }
  const badConfigs = configurations.filter(config => !configIdOf(config))
  if (badConfigs.length) {
    return fail('分析包里的配置缺少 id，无法登记引用')
  }

  const manifest = isRecord(input.manifest) ? input.manifest : null
  const completenessRaw = input.completeness
  const completeness: AnalysisCompleteness = completenessRaw === 'complete' || completenessRaw === 'partial' || completenessRaw === 'missing'
    ? completenessRaw
    : 'complete'
  const gapsRaw = Array.isArray(input.gaps) ? input.gaps : []
  const gaps = gapsRaw.filter(isRecord).map(gap => ({
    scope: String(gap.scope ?? 'unknown'),
    ...(typeof gap.from === 'number' ? { from: gap.from } : {}),
    ...(typeof gap.to === 'number' ? { to: gap.to } : {}),
    reason: String(gap.reason ?? '未说明'),
  }))
  const notes: string[] = []
  if (versionInfo.found !== null && versionInfo.found < ANALYSIS_FORMAT_VERSION) {
    notes.push(`旧格式分析包（版本 ${versionInfo.found} < ${ANALYSIS_FORMAT_VERSION}），已按兼容方式导入`)
  }
  if (completeness !== 'complete') notes.push('该包本身标注为不完整，导入后仍标为「部分缺失」')
  if (manifest && manifest.configReferencesClosed === false) notes.push('导出时引用就未闭合（配置正文缺失）')
  return {
    ok: true, reason: null,
    match: match as unknown as ReplayMatch,
    rounds: [...rounds].sort((a, b) => a.roundIndex - b.roundIndex),
    records: parts,
    configurations,
    completeness,
    gaps,
    version: versionInfo,
    notes,
  }
}

/**
 * 把分析包写回本地：先补展示回放（本地没有同 id 场次时），再登记配置引用、写回分析记录。
 * 顺序刻意如此：§9.2 要求分析区不得比它引用的展示回放活得更久 ⇒ 先有牌谱，再有分析。
 */
export async function importAnalysisFile(options: {
  replay: ReplayStorage
  analysis: AnalysisStorage
  text: string
}): Promise<AnalysisImportOutcome> {
  const empty = { importedId: null, writtenRecords: 0, wroteReplay: false }
  if (!options.analysis.available()) {
    return { ...fail('分析区不可用，无法导入分析包'), ...empty }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(options.text)
  } catch (error) {
    return { ...fail(`文件不是合法 JSON：${String(error instanceof Error ? error.message : error).slice(0, 80)}`), ...empty }
  }
  const result = parseAnalysisImport(parsed)
  if (!result.ok || !result.match) return { ...result, ...empty }
  const matchId = result.match.id

  // 本地已有同 id 场次：保留现有的（以本地为准），只补分析记录
  const existing = await options.replay.loadMatch(matchId)
  let wroteReplay = false
  if (!existing) {
    await options.replay.saveMatch(result.match)
    for (const round of result.rounds) await options.replay.saveRound(round)
    wroteReplay = true
  }

  for (const config of result.configurations) {
    const id = configIdOf(config)
    if (!id) continue
    await options.analysis.retainConfig(matchId, { id, value: config })
  }
  const write = await options.analysis.write(matchId, { rulesetId: result.match.rulesetId }, result.records)
  if (!write.ok) {
    return {
      ...result, ok: false, importedId: matchId, writtenRecords: write.blocks, wroteReplay,
      reason: `分析记录写回失败（${String(write.reason)}），已导入 ${write.blocks} 个块`,
    }
  }
  // 包本身标为不完整时如实留痕：别把 partial 的包标成 complete（§9.5）
  for (const gap of result.gaps) await options.analysis.noteGap(matchId, gap)
  if (result.completeness === 'partial' && !result.gaps.length) {
    await options.analysis.noteGap(matchId, { scope: 'import', reason: 'package-marked-partial' })
  }
  // §9.4：批量导入后复检一次同源容量（有节制的检查）
  void options.analysis.capability?.().refreshEstimate().catch(() => {})
  return {
    ...result, ok: true, importedId: matchId, writtenRecords: result.records.length, wroteReplay,
  }
}

/** 导入后分析区应显示的状态（供界面提示，避免"导入成功"被误读成"完整"）。 */
export function importedAreaStatus(result: AnalysisImportOutcome): AnalysisAreaStatus {
  if (!result.ok) return 'missing'
  return result.completeness === 'complete' ? 'complete' : 'partial'
}
