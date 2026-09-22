// Jev 自对弈确定性摘要：读 work/jev-selfplay/<run-id>/ 的分析包，产出 digest.json + digest.md。
// 不用 LLM、不做主观判断——只做机器可核对的账本/来源/一致率/校准分桶/A-B 配对统计，
// 并把值得大模型复盘的窗口（拒胡、高置信分歧、大额赔付、执行异常）标记进 flagged。
//
// Usage: node scripts/analyze-jev-selfplay.mjs <run-dir>
//   run-dir 形如 work/jev-selfplay/2026-09-22-17-26-29-tag（含 run-manifest.json 与 analysis-*.json）
//
// 口径注意（与 blood-flow-ai 技能一致）：
// - decision 记录在 chosen/receipt 各推一次：按 id 去重取最后状态；attempt 按 id 去重。
// - 结算 kind 读实际编码：win / self-draw / kong-*（杠净分与胡牌收支分开统计）。
// - 「一致率」的对标是**本地 EV 引擎推荐**（engineSuggestion），不是"正确动作"；
//   真校准（概率 vs 实际得失）需要对标记窗口跑反事实，属于后续步骤，本脚本不冒充。
// - 每场是一个样本点；同场多个窗口不当独立样本，收益差不跨场相加成"可追回分数"。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const runDir = process.argv[2]
if (!runDir) {
  throw new Error('Usage: node scripts/analyze-jev-selfplay.mjs <run-dir>（如 work/jev-selfplay/2026-09-22-17-26-29-smoke）')
}
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const sha16 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)
const sum = (values) => values.reduce((a, b) => a + b, 0)

const manifest = read(join(runDir, 'run-manifest.json'))
const summary = read(join(runDir, 'summary.json'))

// ── 1. 盘点与去重 ─────────────────────────────────────────────
const files = readdirSync(runDir).filter((name) => /^analysis-.+-match\d+\.json$/.test(name)).sort()
if (!files.length) throw new Error(`${runDir} 下没有 analysis-*.json`)

const matches = files.map((file) => {
  const path = join(runDir, file)
  const payload = read(path)
  const parsed = /^analysis-(.+)-match(\d+)\.json$/.exec(file)
  const decisionsById = new Map()
  const attemptsById = new Map()
  const decisionStatesById = new Map()
  const settlements = []
  const reproductions = []
  const gaps = []
  for (const part of payload.records ?? []) {
    const value = part.value
    if (part.tag === 'decision') decisionsById.set(value.id, value)
    else if (part.tag === 'llm') attemptsById.set(value.id, value)
    else if (part.tag === 'decisionState') decisionStatesById.set(value.id, value)
    else if (part.tag === 'settlement') settlements.push(value)
    else if (part.tag === 'reproduction') reproductions.push(value)
    else if (part.tag === 'gaps') gaps.push(value)
  }
  const summaryEntry = summary.find((entry) => entry.arm === parsed?.[1] && entry.matchIndex === Number(parsed?.[2]))
  return {
    file, arm: parsed?.[1] ?? 'unknown', matchIndex: Number(parsed?.[2] ?? -1), sha16: sha16(path),
    payload, summaryEntry,
    decisions: [...decisionsById.values()],
    attempts: [...attemptsById.values()],
    decisionStates: decisionStatesById,
    settlements, reproductions, gaps,
  }
})

// ── 2. 账本校验（终局 = 开局 + 胡收入 − 胡付款 + 杠净分；逐结算零和） ──
function ledgerOf(match) {
  const per = [0, 1, 2, 3].map(() => ({ winIncome: 0, winPaid: 0, kongNet: 0, dealIns: 0, wins: 0 }))
  const zeroSumFailures = []
  for (const settlement of match.settlements) {
    if (Math.abs(sum(settlement.deltas)) > 1e-9) zeroSumFailures.push(settlement.id)
    const kong = String(settlement.kind).startsWith('kong')
    settlement.deltas.forEach((delta, seat) => {
      if (kong) per[seat].kongNet += delta
      else if (delta > 0) { per[seat].winIncome += delta; per[seat].wins += 1 }
      else per[seat].winPaid += -delta
    })
    if (!kong && settlement.kind !== 'self-draw') {
      const payers = settlement.deltas.map((delta, seat) => (delta < 0 ? seat : -1)).filter((seat) => seat >= 0)
      if (payers.length === 1) per[payers[0]].dealIns += 1
    }
  }
  const opening = match.reproductions[0]?.openingScores ?? [2000, 2000, 2000, 2000]
  const finalScores = match.summaryEntry?.finalScores ?? []
  const mismatches = []
  per.forEach((entry, seat) => {
    const derived = opening[seat] + entry.winIncome - entry.winPaid + entry.kongNet
    if (finalScores[seat] !== undefined && derived !== finalScores[seat]) {
      mismatches.push({ seat, derived, actual: finalScores[seat] })
    }
  })
  return { per, zeroSumFailures, mismatches, opening }
}

// ── 3. 座位决策统计（默认 seat0=被测座位） ──────────────────
function seatDecisionStats(match, seat) {
  const own = match.decisions.filter((decision) => decision.seat === seat)
  const sources = {}
  const executions = {}
  let declinedWin = 0
  let passed = 0
  let recommended = 0
  let agreed = 0
  const declinedWindows = []
  for (const decision of own) {
    sources[decision.source] = (sources[decision.source] ?? 0) + 1
    const status = decision.execution?.status ?? 'unknown'
    executions[status] = (executions[status] ?? 0) + 1
    if (decision.declinedWin) {
      declinedWin += 1
      declinedWindows.push({
        windowId: decision.windowId, roundIndex: decision.roundIndex, windowKind: decision.windowKind,
        chosen: decision.choice?.known ? decision.choice.value.action : null,
        source: decision.source,
      })
    }
    if (decision.passed) passed += 1
    if (decision.recommended?.known && decision.choice?.known) {
      recommended += 1
      if (decision.choice.value.legalActionId === decision.recommended.value.legalActionId) agreed += 1
    }
  }
  return { total: own.length, sources, executions, declinedWin, passed, recommended, agreed, declinedWindows }
}

// ── 4. Jev attempt 统计与置信分桶（对标=EV 推荐一致率，非真校准） ──
function jevAttemptStats(match) {
  const attempts = match.attempts.filter((attempt) => String(attempt.provider).startsWith('jev'))
  const outcomes = {}
  const entries = []
  for (const attempt of attempts) {
    outcomes[attempt.outcome] = (outcomes[attempt.outcome] ?? 0) + 1
    if (attempt.outcome !== 'success' || !attempt.answer?.known) continue
    const decision = match.decisions.find((candidate) => candidate.id === attempt.decisionId)
    let note = {}
    try { note = JSON.parse(attempt.answer.value.note ?? '{}') } catch { /* 留空 */ }
    const probabilities = Object.entries(note.probabilities ?? {}).sort((a, b) => b[1] - a[1])
    entries.push({
      decisionId: attempt.decisionId,
      windowId: decision?.windowId ?? null,
      seat: attempt.seat,
      windowKind: decision?.windowKind ?? null,
      confidence: typeof note.confidence === 'number' ? note.confidence : null,
      margin: probabilities.length >= 2 ? probabilities[0][1] - probabilities[1][1] : null,
      candidateId: attempt.answer.value.candidateId ?? null,
      agreedWithEv: decision?.recommended?.known && decision?.choice?.known
        ? decision.choice.value.legalActionId === decision.recommended.value.legalActionId
        : null,
      declinedWin: Boolean(decision?.declinedWin),
      durationMs: attempt.timing?.durationMs ?? null,
    })
  }
  const buckets = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01].slice(0, -1).map((low, index, array) => {
    const high = array[index + 1] ?? 1.01
    const inside = entries.filter((entry) => entry.confidence !== null && entry.confidence >= low && entry.confidence < high)
    const scored = inside.filter((entry) => entry.agreedWithEv !== null)
    return {
      range: `[${low.toFixed(1)},${Math.min(high, 1).toFixed(1)})`,
      count: inside.length,
      agreement: scored.length ? scored.filter((entry) => entry.agreedWithEv).length / scored.length : null,
      declinedWin: inside.filter((entry) => entry.declinedWin).length,
    }
  }).filter((bucket) => bucket.count > 0)
  return {
    attempts: attempts.length, outcomes, entries,
    agreement: (() => {
      const scored = entries.filter((entry) => entry.agreedWithEv !== null)
      return scored.length ? scored.filter((entry) => entry.agreedWithEv).length / scored.length : null
    })(),
    meanConfidence: mean(entries.map((entry) => entry.confidence).filter((value) => value !== null)),
    meanDurationMs: mean(entries.map((entry) => entry.durationMs).filter((value) => value !== null)),
    buckets,
  }
}

// ── 5. 标记窗口（给大模型复盘的输入；带上决策前态的关键字段） ──
function flagWindows(match, seat, jevStats) {
  const flags = []
  const contextOf = (decision) => {
    const state = decision.stateId ? match.decisionStates.get(decision.stateId) : null
    const attempt = match.attempts.find((candidate) => decision.llmAttemptIds?.includes(candidate.id))
    let note = null
    try { note = attempt?.answer?.known ? JSON.parse(attempt.answer.value.note ?? 'null') : null } catch { /* 留空 */ }
    return {
      ref: { file: match.file, windowId: decision.windowId, seat: decision.seat, decisionId: decision.id },
      roundIndex: decision.roundIndex, windowKind: decision.windowKind, source: decision.source,
      hand: state?.hand ?? null, drawnTileIndex: state?.drawnTileIndex ?? null,
      legalActions: (decision.legalActions ?? state?.legalActions ?? []).map((action) => ({ id: action.id, kind: action.kind, tile: action.tile ?? null })),
      chosen: decision.choice?.known ? decision.choice.value.legalActionId : null,
      recommended: decision.recommended?.known ? decision.recommended.value.legalActionId : null,
      confidence: note?.confidence ?? null,
      probabilities: note?.probabilities ?? null,
      execution: decision.execution?.status ?? null,
    }
  }
  for (const decision of match.decisions) {
    if (decision.seat !== seat) continue
    if (decision.declinedWin) flags.push({ kind: 'declined-win', ...contextOf(decision) })
    const entry = jevStats.entries.find((candidate) => candidate.decisionId === decision.id)
    if (entry && entry.agreedWithEv === false && entry.confidence !== null && entry.confidence >= 0.7) {
      flags.push({ kind: 'high-confidence-disagreement', confidence: entry.confidence, ...contextOf(decision) })
    }
    if (decision.execution?.status === 'state-changed') flags.push({ kind: 'execution-anomaly', ...contextOf(decision) })
  }
  const ledger = ledgerOf(match)
  for (const settlement of match.settlements) {
    const delta = settlement.deltas[seat] ?? 0
    if (delta <= -200) {
      flags.push({
        kind: 'large-payment',
        ref: { file: match.file, settlementId: settlement.id },
        roundIndex: settlement.roundIndex, settlementKind: settlement.kind,
        delta, winners: settlement.winners, batchId: settlement.batchId,
      })
    }
  }
  const CAP = 60
  return { count: flags.length, truncated: flags.length > CAP, flags: flags.slice(0, CAP), ledgerSeat: ledger.per[seat] }
}

// ── 6. 汇总 ───────────────────────────────────────────────────
const perMatch = matches.map((match) => {
  const ledger = ledgerOf(match)
  const seat0 = seatDecisionStats(match, 0)
  const jev = jevAttemptStats(match)
  const flagged = flagWindows(match, 0, jev)
  return {
    file: match.file, arm: match.arm, matchIndex: match.matchIndex, sha16: match.sha16,
    seed: match.summaryEntry?.seed ?? null,
    reproductionCapable: match.payload.reproductionCapable,
    completeness: match.payload.completeness,
    gaps: [...(match.payload.gaps ?? []), ...match.gaps],
    ledger: { per: ledger.per, zeroSumFailures: ledger.zeroSumFailures, mismatches: ledger.mismatches },
    seat0: { ...seat0, declinedWindows: seat0.declinedWindows.slice(0, 20) },
    jev: { ...jev, entries: undefined },
    flagged,
  }
})

const arms = [...new Set(matches.map((match) => match.arm))]
const armRows = arms.map((arm) => {
  const armMatches = perMatch.filter((entry) => entry.arm === arm)
  const armSummary = summary.filter((entry) => entry.arm === arm)
  const deltas = armSummary.map((entry) => entry.seat0Delta)
  const ranks = armSummary.map((entry) => {
    const sorted = [...entry.finalScores].sort((a, b) => b - a)
    return sorted.indexOf(entry.finalScores[0]) + 1
  })
  return {
    arm,
    matches: armMatches.length,
    seat0MeanDelta: mean(deltas),
    seat0Deltas: deltas,
    seat0MeanRank: mean(ranks),
    seat0Wins: sum(armSummary.flatMap((entry) => entry.winCounts.map((counts) => counts[0]))),
    seat0DealIns: sum(armMatches.map((entry) => entry.ledger.per[0].dealIns)),
    seat0WinIncome: sum(armMatches.map((entry) => entry.ledger.per[0].winIncome)),
    seat0WinPaid: sum(armMatches.map((entry) => entry.ledger.per[0].winPaid)),
    seat0KongNet: sum(armMatches.map((entry) => entry.ledger.per[0].kongNet)),
    declinedWins: sum(armMatches.map((entry) => entry.seat0.declinedWin)),
    evAgreement: mean(armMatches.map((entry) => entry.jev.agreement).filter((value) => value !== null)),
    // seat0 全部决策（不限 Jev 尝试）与 EV 推荐的一致率：baseline 臂应≈100%（策略与推荐同源），
    // jev 臂与 evAgreement（仅 Jev 成功请求）互为印证。
    seat0EvAgreement: (() => {
      const recommended = sum(armMatches.map((entry) => entry.seat0.recommended))
      const agreed = sum(armMatches.map((entry) => entry.seat0.agreed))
      return recommended ? agreed / recommended : null
    })(),
    meanConfidence: mean(armMatches.map((entry) => entry.jev.meanConfidence).filter((value) => value !== null)),
    meanDecisionMs: mean(armMatches.map((entry) => entry.jev.meanDurationMs).filter((value) => value !== null)),
    jevRequests: sum(armSummary.map((entry) => entry.jev.requests)),
    jevFailures: sum(armSummary.map((entry) => entry.jev.failures)),
    jevFallbacks: sum(armSummary.map((entry) => entry.jev.fallbacks)),
    modelShare: (() => {
      const totals = {}
      for (const entry of armMatches) for (const [source, count] of Object.entries(entry.seat0.sources)) totals[source] = (totals[source] ?? 0) + count
      const all = sum(Object.values(totals))
      return all ? (totals.model ?? 0) / all : null
    })(),
  }
})

// 配对差（同种子 arm − baseline）：每场一个样本点，不做显著性宣称
const baselineBySeed = new Map(summary.filter((entry) => entry.arm === 'baseline').map((entry) => [entry.seed, entry.seat0Delta]))
const paired = armRows.filter((row) => row.arm !== 'baseline').map((row) => {
  const armEntries = summary.filter((entry) => entry.arm === row.arm)
  const diffs = armEntries
    .filter((entry) => baselineBySeed.has(entry.seed))
    .map((entry) => ({ seed: entry.seed, diff: entry.seat0Delta - baselineBySeed.get(entry.seed) }))
  return { arm: row.arm, pairs: diffs.length, meanDiff: mean(diffs.map((diff) => diff.diff)), diffs }
})

const integrity = {
  files: matches.length,
  ledgerMismatches: sum(perMatch.map((entry) => entry.ledger.mismatches.length)),
  zeroSumFailures: sum(perMatch.map((entry) => entry.ledger.zeroSumFailures.length)),
  notReproductionCapable: perMatch.filter((entry) => !entry.reproductionCapable).map((entry) => entry.file),
  gaps: perMatch.flatMap((entry) => entry.gaps),
}

const digest = {
  generatedAt: new Date().toISOString(),
  runDir,
  manifest: { engineBuild: manifest.engineBuild, tag: manifest.tag, arms: manifest.arms, matchesPerArm: manifest.matchesPerArm, roundsPerMatch: manifest.roundsPerMatch, seeds: manifest.seeds, jev: manifest.jev },
  integrity,
  arms: armRows,
  paired,
  matches: perMatch,
  limitations: [
    '一致率对标本地 EV 推荐（engineSuggestion），不是"正确动作"；真校准需对标记窗口跑反事实。',
    '每场是一个样本点；配对差未做显著性检验，结案标准见 A/B 协议文档。',
    'large-payment 阈值固定 -200 点，未按番型语境归一。',
    'flagged 每场上限 60 条，超出被截断（truncated 标记）。',
  ],
}

writeFileSync(join(runDir, 'digest.json'), JSON.stringify(digest, null, 2))

// ── 7. markdown 报告 ─────────────────────────────────────────
const percent = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`)
const number = (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(1))
const lines = [
  `# Jev 自对弈摘要（${manifest.tag}）`,
  '',
  `- 构建：\`${manifest.engineBuild}\`；生成：${digest.generatedAt}`,
  `- 臂：${manifest.arms.join('、')}；每臂 ${manifest.matchesPerArm} 场 × ${manifest.roundsPerMatch} 局；种子 ${manifest.seeds[0]}–${manifest.seeds.at(-1)}`,
  `- Jev 端点：${manifest.jev ? `${manifest.jev.backend} @ ${manifest.jev.baseUrl}（model=${manifest.jev.model}）` : '无（baseline-only 运行）'}`,
  `- 完整性：账本失配 ${integrity.ledgerMismatches}；零和失败 ${integrity.zeroSumFailures}；不可复现包 ${integrity.notReproductionCapable.length}；gaps ${integrity.gaps.length}`,
  '',
  '## 臂对比（seat0 = 被测座位）',
  '',
  '| 臂 | 场 | 平均净分 | 平均名次 | 胡牌 | 放炮 | seat0 EV一致率 | Jev请求一致率 | 平均置信 | 拒胡 | model占比 | Jev失败/回退 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...armRows.map((row) => `| ${row.arm} | ${row.matches} | ${number(row.seat0MeanDelta)} | ${number(row.seat0MeanRank)} | ${row.seat0Wins} | ${row.seat0DealIns} | ${percent(row.seat0EvAgreement)} | ${percent(row.evAgreement)} | ${percent(row.meanConfidence)} | ${row.declinedWins} | ${percent(row.modelShare)} | ${row.jevFailures}/${row.jevFallbacks} |`),
  '',
  '## 配对差（同种子 arm − baseline，每场一个样本）',
  '',
  ...paired.map((entry) => `- ${entry.arm}：${entry.pairs} 对，平均差 ${number(entry.meanDiff)}（明细见 digest.json）`),
  paired.length ? '' : '（无 baseline 对照或未跑 jev 臂）',
  '',
  '## 标记窗口（供大模型复盘；完整清单在 digest.json 的 matches[].flagged）',
  '',
  ...perMatch.flatMap((entry) => {
    const counts = {}
    for (const flag of entry.flagged.flags) counts[flag.kind] = (counts[flag.kind] ?? 0) + 1
    return entry.flagged.count
      ? [`- \`${entry.file}\`（seed ${entry.seed}）：${Object.entries(counts).map(([kind, count]) => `${kind}×${count}`).join('、')}${entry.flagged.truncated ? '（已截断）' : ''}`]
      : []
  }),
  '',
  '## 局限',
  '',
  ...digest.limitations.map((item) => `- ${item}`),
  '',
]
writeFileSync(join(runDir, 'digest.md'), lines.join('\n'))

console.log(JSON.stringify({
  runDir,
  files: matches.length,
  integrity,
  arms: armRows.map(({ arm, matches: count, seat0MeanDelta, evAgreement, declinedWins, jevFailures }) => ({ arm, count, seat0MeanDelta, evAgreement, declinedWins, jevFailures })),
  paired: paired.map(({ arm, pairs, meanDiff }) => ({ arm, pairs, meanDiff })),
  outputs: [join(runDir, 'digest.json'), join(runDir, 'digest.md')],
}, null, 2))
