// 牌谱导入（方案 §9.5、§10.7）：把导出的 `lianhua-replay` JSON 读回本地库。
//
// 三条不许含糊的原则（与复现校验器同一套）：
// 1. **缺字段就报错，不用默认值顶替**：缺了什么就列出来，否则导入进来的是另一个画面；
// 2. **引用必须闭合**：各局的 `matchId` 必须指向被导入的场次，`roundCount` 必须与实到的局数一致，
//    否则导入的是"看起来能看、其实丢了一部分"的残档；
// 3. **版本只认认得的**：文件版本高于本程序能识别的版本 ⇒ 明确拒绝（§9.5 的"不能只递增常量就丢弃旧记录"，
//    反过来也一样：不能拿旧解析器硬解新格式）；低于当前版本视为旧格式，照常导入并标注。
import { REPLAY_SCHEMA_VERSION, type ReplayMatch, type ReplayRound } from './types'
import type { ReplayStorage } from './storage'

export interface ReplayImportVersion {
  /** 文件里声明的版本；没有该字段时为 null。 */
  found: number | null
  current: number
  /** 能否按当前解析器读取。 */
  readable: boolean
  /** 旧格式（版本低于当前）：可读，但界面上应说明。 */
  legacy: boolean
}

export interface ReplayImportResult {
  ok: boolean
  reason: string | null
  match: ReplayMatch | null
  rounds: ReplayRound[]
  version: ReplayImportVersion
  /** 可读但需要提醒的点（例如旧格式），界面直接展示。 */
  notes: string[]
}

function versionOf(payload: Record<string, unknown>): ReplayImportVersion {
  const raw = payload.schemaVersion
  const found = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  if (found === null) return { found, current: REPLAY_SCHEMA_VERSION, readable: true, legacy: true }
  return { found, current: REPLAY_SCHEMA_VERSION, readable: found <= REPLAY_SCHEMA_VERSION, legacy: found < REPLAY_SCHEMA_VERSION }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析导入文件；只做"能不能安全读入"的判定，不落库（落库见 `importReplayFile`）。 */
export function parseReplayImport(input: unknown): ReplayImportResult {
  const fail = (reason: string, version?: ReplayImportVersion): ReplayImportResult => ({
    ok: false, reason, match: null, rounds: [], notes: [],
    version: version ?? { found: null, current: REPLAY_SCHEMA_VERSION, readable: true, legacy: false },
  })
  if (!isRecord(input)) return fail('文件内容不是一个 JSON 对象')
  const version = versionOf(input)
  if (!version.readable) {
    return fail(`牌谱格式版本 ${version.found} 高于本程序能识别的 ${version.current}，请升级后再导入`, version)
  }
  if (input.kind !== 'lianhua-replay') {
    return fail(`不是牌谱文件（kind=${String(input.kind ?? '缺失')}，应为 lianhua-replay）`, version)
  }
  const match = input.match
  if (!isRecord(match)) return fail('缺少场次信息（match）', version)
  const missing: string[] = []
  if (typeof match.id !== 'string' || !match.id) missing.push('match.id')
  if (typeof match.rulesetId !== 'string' || !match.rulesetId) missing.push('match.rulesetId')
  if (typeof match.rulesetName !== 'string' || !match.rulesetName) missing.push('match.rulesetName')
  if (typeof match.matchName !== 'string' || !match.matchName) missing.push('match.matchName')
  if (typeof match.matchType !== 'string') missing.push('match.matchType')
  if (typeof match.gameMode !== 'string') missing.push('match.gameMode')
  if (typeof match.themeName !== 'string' || !match.themeName) missing.push('match.themeName')
  if (!Array.isArray(match.players) || !match.players.length) missing.push('match.players')
  if (typeof match.humanSeat !== 'number') missing.push('match.humanSeat')
  if (typeof match.startedAt !== 'number') missing.push('match.startedAt')
  if (typeof match.status !== 'string') missing.push('match.status')
  if (typeof match.roundCount !== 'number') missing.push('match.roundCount')
  if (missing.length) return fail(`牌谱缺少必需字段：${missing.join('、')}`, version)

  const roundsRaw = input.rounds
  if (!Array.isArray(roundsRaw) || !roundsRaw.length) return fail('牌谱里没有任何一局（rounds 为空）', version)
  const rounds: ReplayRound[] = []
  for (const [index, entry] of roundsRaw.entries()) {
    if (!isRecord(entry)) return fail(`第 ${index + 1} 局不是对象`, version)
    const roundMissing: string[] = []
    if (typeof entry.id !== 'string' || !entry.id) roundMissing.push('id')
    if (typeof entry.matchId !== 'string' || !entry.matchId) roundMissing.push('matchId')
    if (typeof entry.roundIndex !== 'number') roundMissing.push('roundIndex')
    if (!Array.isArray(entry.steps)) roundMissing.push('steps')
    if (roundMissing.length) return fail(`第 ${index + 1} 局缺少字段：${roundMissing.join('、')}`, version)
    // 引用闭合：局必须指向本场的 id，否则导入后这一局永远读不出来（悬空引用）
    if (entry.matchId !== match.id) {
      return fail(`第 ${index + 1} 局的 matchId（${String(entry.matchId)}）与场次 id（${String(match.id)}）不一致`, version)
    }
    rounds.push(entry as unknown as ReplayRound)
  }
  if (rounds.length !== match.roundCount) {
    return fail(`局数与场次记录不一致（实到 ${rounds.length} 局，场次记录 ${String(match.roundCount)} 局）`, version)
  }
  const notes: string[] = []
  if (version.legacy) notes.push(`旧格式牌谱（版本 ${version.found ?? '未标注'} < ${version.current}），已按兼容方式导入`)
  return {
    ok: true, reason: null,
    match: match as unknown as ReplayMatch,
    rounds: [...rounds].sort((a, b) => a.roundIndex - b.roundIndex),
    version, notes,
  }
}

export interface ReplayImportOutcome extends ReplayImportResult {
  /** 成功落库的场次 id。 */
  importedId: string | null
  /** 读取文件本身失败（不是文件内容的问题）。 */
  readError?: string
}

/**
 * 把牌谱文本导入本地库：解析 → 查重（同 id 已存在则拒绝，不静默覆盖）→ 写场次与各局。
 * 导入的场次没有分析记录，列表会标「缺少决策分析记录」（§10.7）。
 */
export async function importReplayFile(storage: ReplayStorage, text: string): Promise<ReplayImportOutcome> {
  if (!storage.available) {
    return {
      ...parseReplayImport(null), ok: false, importedId: null,
      reason: '本地回放存储不可用，无法导入', readError: 'storage-unavailable',
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ...parseReplayImport(null), ok: false, importedId: null,
      reason: `文件不是合法 JSON：${String(error instanceof Error ? error.message : error).slice(0, 80)}`,
    }
  }
  const result = parseReplayImport(parsed)
  if (!result.ok || !result.match) return { ...result, importedId: null }
  const existing = await storage.loadMatch(result.match.id)
  if (existing) {
    return { ...result, ok: false, importedId: null, reason: '本地已存在同一场次（id 相同），未导入以免覆盖' }
  }
  await storage.saveMatch(result.match)
  let written = 0
  for (const round of result.rounds) {
    await storage.saveRound(round)
    written += 1
  }
  if (written !== result.rounds.length) {
    return { ...result, ok: false, importedId: result.match.id, reason: `只写入了 ${written}/${result.rounds.length} 局（存储失败）` }
  }
  return { ...result, importedId: result.match.id }
}
