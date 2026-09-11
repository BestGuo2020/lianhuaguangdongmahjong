import type { Meld, TileType } from '../../../core/contracts/types'
import { matchPatterns } from '../patterns/catalog'
import { visitDecompositions } from '../patterns/decompose'
import { scorePatterns } from '../patterns/score'
import { BLOOD_FLOW_CONFIG } from './config'
import type { PublicWinScore, WinEvaluationInput, WinSource } from './types'

/**
 * 开发期胡牌诊断（仅 DEV）。
 *
 * 用途：现场定位「这一手为什么没算某某番」。引擎每次评估出自摸/点炮胡时留档，
 * 事后可重跑**全部拆解**，把每条拆解的牌型、番型、倍率、收付摊开对比。
 *
 * 控制台用法（DEV）：
 *   __bfExplainWin()        // 最近一次胡牌的全部拆解（按收付从高到低）
 *   __bfExplainWin(1)       // 上一次
 *   __bfWinLog()            // 最近 20 次胡牌的输入与报出结果
 * 也可用 `?winDiag=1` 打开页面：每次胡牌自动打印一行摘要。
 *
 * 隐私边界：留档只存在于浏览器内存（模块级数组），不进入任何网络载荷、快照或 LLM 请求；
 * 生产构建里 `winDiagnosticsEnabled()` 恒定 false，所有函数直接返回、不落任何数据。
 */
const MAX_ENTRIES = 20

export interface WinDiagnosticEntry {
  readonly at: number
  readonly seat: number
  /** 权威侧评估输入（仅本席手牌），用于事后重跑拆解。 */
  readonly input: WinEvaluationInput
  readonly reported: PublicWinScore
}

export interface ExplainedDecomposition {
  /** 拆解牌型，按面子顺序，如 `redredred | greengreengreen | m5m6m7 | m9m9`。 */
  readonly groups: string
  readonly items: string
  readonly patternMultiplier: number
  readonly finalMultiplier: number
  readonly paymentPerPayer: number
  readonly hardWin: boolean
  readonly hasBigThreeDragons: boolean
}

export interface WinExplanation {
  readonly reported: string
  readonly decompositions: ExplainedDecomposition[]
  /** 三元刻相关摘要：本次是否存在含「大三元」的拆解，以及它最好的收付。 */
  readonly bigThree: { found: boolean; bestPayment: number | null; items: string | null }
}

const log: WinDiagnosticEntry[] = []
let installed = false

export function winDiagnosticsEnabled(): boolean {
  return Boolean(import.meta.env.DEV)
}

function autoPrint(): boolean {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).has('winDiag')
}

function describeReported(entry: WinDiagnosticEntry): string {
  const { reported: score } = entry
  const items = score.items.map(item => `${item.label}×${item.weight}`).join(' + ') || '无番型'
  return `座位${entry.seat} ${score.source === 'self-draw' ? '自摸' : score.source === 'discard' ? '点炮' : score.source} `
    + `胡 ${entry.input.winningTile}｜${items}｜${score.finalMultiplier}倍${score.hardWin ? '（硬胡）' : '（软胡）'}｜每家 ${score.paymentPerPayer}`
}

/** 引擎每次评估出胡牌时调用；非 DEV 直接返回。 */
export function recordWinEvaluation(entry: WinDiagnosticEntry): void {
  if (!winDiagnosticsEnabled()) return
  log.unshift(entry)
  if (log.length > MAX_ENTRIES) log.length = MAX_ENTRIES
  installWinDiagnostics()
  if (autoPrint()) console.log(`[血流胡牌] ${describeReported(entry)}（__bfExplainWin() 看全部拆解）`)
}

export function winDiagnosticLog(): readonly WinDiagnosticEntry[] {
  return log
}

export function clearWinDiagnostics(): void {
  log.length = 0
}

/** 重跑某次胡牌的全部拆解，按收付从高到低返回。 */
export function explainWin(entry: WinDiagnosticEntry | undefined = log[0]): WinExplanation | null {
  if (!entry || !winDiagnosticsEnabled()) return null
  const rows: ExplainedDecomposition[] = []
  const seen = new Set<string>()
  visitDecompositions(entry.input, decomposition => {
    const ids = matchPatterns(decomposition)
    const score = scorePatterns(ids, decomposition.natural, entry.input.source as WinSource, entry.input.opening, BLOOD_FLOW_CONFIG)
    const groups = decomposition.groups.map(group => group.tiles.join('')).join(' | ')
    const key = `${groups}|${score.items.map(item => item.id).join(',')}|${score.hardWin}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({
      groups,
      items: score.items.map(item => `${item.label}×${item.weight}`).join(' + ') || '无番型',
      patternMultiplier: score.patternMultiplier,
      finalMultiplier: score.finalMultiplier,
      paymentPerPayer: score.paymentPerPayer,
      hardWin: score.hardWin,
      hasBigThreeDragons: ids.includes('big-three-dragons'),
    })
  })
  rows.sort((left, right) => right.paymentPerPayer - left.paymentPerPayer || Number(right.hardWin) - Number(left.hardWin))
  const bigRows = rows.filter(row => row.hasBigThreeDragons)
  return {
    reported: describeReported(entry),
    decompositions: rows,
    bigThree: { found: bigRows.length > 0, bestPayment: bigRows[0]?.paymentPerPayer ?? null, items: bigRows[0]?.items ?? null },
  }
}

/** 打印一条拆解表并返回结构化结果，方便控制台复制。 */
export function printWinExplanation(entry: WinDiagnosticEntry | undefined = log[0]): WinExplanation | null {
  const explanation = explainWin(entry)
  if (!explanation) {
    console.log('[血流胡牌] 没有留档（DEV 下打一局胡牌后可用；或该次不是本机权威评估）')
    return null
  }
  console.log(`[血流胡牌] 实际报出：${explanation.reported}`)
  console.log(explanation.bigThree.found
    ? `[血流胡牌] 含大三元的拆解：${explanation.bigThree.items}，最好收付 ${explanation.bigThree.bestPayment}`
    : '[血流胡牌] 本次没有任何含大三元的拆解（牌型不成立或已被更高赔付的拆解取代）')
  console.table(explanation.decompositions.map(row => ({
    牌型: row.groups, 番型: row.items, 倍率: row.finalMultiplier, 硬胡: row.hardWin ? '是' : '否',
    每家付: row.paymentPerPayer, 含大三元: row.hasBigThreeDragons ? '是' : '',
  })))
  return explanation
}

/** DEV 下挂 `__bfWinLog()` / `__bfExplainWin()`；重复调用无副作用。
 *  默认挂到 `self`：页面里就是 window，本地/联机权威跑在 Worker 里时挂到 worker 全局，
 *  在 devtools 把控制台上下文切到该 worker 即可调用。 */
export function installWinDiagnostics(target: unknown = typeof self === 'undefined' ? undefined : self): void {
  if (!winDiagnosticsEnabled() || !target || installed) return
  installed = true
  const host = target as Record<string, unknown>
  host.__bfWinLog = () => winDiagnosticLog()
  host.__bfExplainWin = (index = 0) => printWinExplanation(winDiagnosticLog()[index])
}
