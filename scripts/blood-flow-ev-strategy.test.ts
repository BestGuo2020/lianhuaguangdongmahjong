// 血流新旧策略对比验收：legacy / legacy-min40 / ev 各 100 局自对局，
// 另加 ev×2 席 + legacy×2 席混合对局 100 局。分块产出 JSON 片段，最后汇总 records/strategy-ev.md。
// 只做固定种子统计，不修改生产策略；证据口径见输出报告。
import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { decideBloodFlowAction, decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { seededRandom } from '../src/game/variants/lotus/bloodFlow/simulation'
import { SEATS } from '../src/game/variants/lotus/bloodFlow/state'
import type { BloodFlowAction } from '../src/game/variants/lotus/bloodFlow/state'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG } from '../src/game/variants/lotus/bloodFlow/config'

type Policy = (view: BloodFlowSeatView) => BloodFlowAction | null
const legacyMin0: Policy = view => decideBloodFlowAction(view, 0)
const legacyMin40: Policy = view => decideBloodFlowAction(view, 40)
const ev: Policy = view => decideBloodFlowActionEv(view, BLOOD_FLOW_AI)

interface RoundStats {
  commands: number
  firstWinWall: number | null
  records: ReturnType<BloodFlowEngine['publicState']>['batches'] extends readonly (infer B)[] ? B extends { winners: readonly (infer W)[] } ? W[] : never : never
  endingScores: readonly [number, number, number, number]
  declines: number
  declinedImmediate: number
  reforms: number
}

function runRound(seed: number, policies: [Policy, Policy, Policy, Policy]): RoundStats {
  const engine = new BloodFlowEngine({ authorityEpoch: 'strategy-ev', roundId: `seed-${seed}`, random: seededRandom(seed), now: () => 0, winBeatMs: 0 })
  let steps = 0, firstWinWall: number | null = null
  let declines = 0, declinedImmediate = 0, reforms = 0
  while (!engine.result) {
    if (++steps > 2000) throw new Error(`Stalled seed ${seed}`)
    const window = engine.window!
    const seat = SEATS.find(s => window.options[s].length && !window.decisions[s])!
    const view = bloodFlowSeatView(engine, seat)
    const locked = view.public.seats[seat].locked
    const winOffered = view.ownActions.some(a => a.kind === 'win')
    const drawnIndex = view.players[seat].drawnTileIndex
    const action = policies[seat](view)
    if (action && winOffered && !locked && action.kind !== 'win') {
      declines++
      const payers = view.ownScore && (view.ownScore.source === 'self-draw' || view.ownScore.source === 'kong-bloom') ? 3 : 1
      declinedImmediate += (view.ownScore?.paymentPerPayer ?? 0) * payers
      if (action.kind === 'discard' && action.index !== drawnIndex) reforms++
    }
    expect(action).toBeTruthy()
    expect(engine.submit(engine.command(seat, action!))).toBe(true)
    engine.assertConservation()
    if (firstWinWall === null && engine.archives.length) firstWinWall = engine.wall.length
  }
  const records = engine.publicState().batches.flatMap(b => b.winners)
  return { commands: steps, firstWinWall, records, endingScores: engine.players.map(p => p.score) as RoundStats['endingScores'],
    declines, declinedImmediate, reforms }
}

interface StrategyReport {
  strategy: string
  rounds: number
  wins: number
  first: number
  repeats: number
  hard: number
  capped: number
  noWin: number
  meanFirstWall: number | null
  meanSpread: number
  maxSpread: number
  meanCommands: number
  declines: number
  declinedImmediate: number
  reforms: number
  patterns: Record<string, number>
  elapsedMs: number
}

function reportStrategy(strategy: string, policies: [Policy, Policy, Policy, Policy]): StrategyReport {
  const started = performance.now()
  let wins = 0, first = 0, hard = 0, capped = 0, commands = 0, noWin = 0, wallSum = 0
  let spreadSum = 0, maxSpread = 0, declines = 0, declinedImmediate = 0, reforms = 0
  const patterns: Record<string, number> = {}
  for (let seed = 1; seed <= 100; seed++) {
    const run = runRound(seed, policies)
    expect(run.endingScores.reduce((a, b) => a + b, 0)).toBe(8000)
    commands += run.commands; wins += run.records.length
    first += run.records.filter(r => r.ordinal === 1).length
    declines += run.declines; declinedImmediate += run.declinedImmediate; reforms += run.reforms
    if (run.firstWinWall === null) noWin++; else wallSum += run.firstWinWall
    const spread = Math.max(...run.endingScores) - Math.min(...run.endingScores)
    spreadSum += spread; maxSpread = Math.max(maxSpread, spread)
    for (const record of run.records) {
      if (record.score.hardWin) hard++
      if (record.score.capped) capped++
      for (const item of record.score.items) patterns[item.id] = (patterns[item.id] ?? 0) + 1
    }
  }
  return { strategy, rounds: 100, wins, first, repeats: wins - first, hard, capped, noWin,
    meanFirstWall: noWin === 100 ? null : wallSum / (100 - noWin), meanSpread: spreadSum / 100, maxSpread,
    meanCommands: commands / 100, declines, declinedImmediate, reforms, patterns, elapsedMs: performance.now() - started }
}

const dir = 'work/strategy-ev'
function saveFragment(name: string, value: unknown) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(value, null, 2))
}

it('self-play: legacy (min 0)', () => {
  saveFragment('legacy', reportStrategy('legacy', [legacyMin0, legacyMin0, legacyMin0, legacyMin0]))
}, 900_000)

it('self-play: legacy (min 40)', () => {
  saveFragment('legacy-min40', reportStrategy('legacy-min40', [legacyMin40, legacyMin40, legacyMin40, legacyMin40]))
}, 900_000)

it('self-play: greedy EV', () => {
  saveFragment('ev', reportStrategy('ev', [ev, ev, ev, ev]))
}, 900_000)

it('mixed table: EV seats 0/1 vs legacy seats 2/3', () => {
  const started = performance.now()
  let evSeats = 0, legacySeats = 0, evWins = 0, legacyWins = 0, declines = 0, reforms = 0, noWin = 0
  for (let seed = 1; seed <= 100; seed++) {
    const run = runRound(seed, [ev, ev, legacyMin0, legacyMin0])
    evSeats += run.endingScores[0] + run.endingScores[1] - 2 * BLOOD_FLOW_CONFIG.initialScore
    legacySeats += run.endingScores[2] + run.endingScores[3] - 2 * BLOOD_FLOW_CONFIG.initialScore
    for (const record of run.records) { if (record.winner < 2) evWins++; else legacyWins++ }
    declines += run.declines; reforms += run.reforms
    if (run.firstWinWall === null) noWin++
  }
  saveFragment('mixed', { rounds: 100, evSeats, legacySeats, evWins, legacyWins, declines, reforms, noWin, elapsedMs: performance.now() - started })
}, 900_000)

it('assembles the comparison report', () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const read = <T>(name: string): T | null => { try { return JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8')) as T } catch { return null } }
  const reports = [read<StrategyReport>('legacy'), read<StrategyReport>('legacy-min40'), read<StrategyReport>('ev')].filter(Boolean) as StrategyReport[]
  const mixed = read<{ rounds: number; evSeats: number; legacySeats: number; evWins: number; legacyWins: number; declines: number; reforms: number; noWin: number; elapsedMs: number }>('mixed')
  const row = (r: StrategyReport) => `| ${r.strategy} | ${r.first} | ${r.repeats} | ${r.noWin} | ${r.hard} | ${r.capped} | ${r.meanFirstWall?.toFixed(2) ?? '—'} | ${r.meanSpread.toFixed(2)} / ${r.maxSpread} | ${r.meanCommands.toFixed(2)} | ${r.declines} | ${r.declinedImmediate} | ${r.reforms} |`
  const detail = (r: StrategyReport) => `### ${r.strategy}\n\n耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒；硬胡占比 ${(100 * r.hard / Math.max(1, r.wins)).toFixed(2)}%；封顶占比 ${(100 * r.capped / Math.max(1, r.wins)).toFixed(2)}%；番型记录：${Object.entries(r.patterns).map(([id, n]) => `${id} ${n}`).join('、') || '无'}。`
  writeFileSync('docs/blood-flow/records/strategy-ev.md', `# 血流本地 AI 策略对比（legacy vs 贪婪 EV）

规则：${BLOOD_FLOW_CONFIG.version}；引擎提交：${commit}；每策略 100 局、种子 1～100，四席自我对局；另含 ev×2 席 + legacy×2 席混合对局 100 局。已胡后仍接受合法胡；显式关闭 UI 节拍；每动作检查 136 张物理牌与零和，全部结束、无停滞。ev 参数默认值见[策略设计](../design/ai-strategy.md#参数默认值集中在-configts)。

## 自对局

| 策略 | 首次成牌 | 重复胡 | 无胡局 | 硬胡 | 封顶 | 首胡墙长均值 | 分差均值/最大 | 命令均值 | 拒胡 | 拒胡放弃收入 | 改张 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${reports.map(row).join('\n')}

${reports.map(detail).join('\n\n')}

## 混合对局（ev 席 0/1，legacy 席 2/3）

${mixed ? `- ev 两席净变总分 ${mixed.evSeats}，legacy 两席净变总分 ${mixed.legacySeats}；胡记录 ev ${mixed.evWins} / legacy ${mixed.legacyWins}；无胡局 ${mixed.noWin}；ev 席拒胡 ${mixed.declines} 次、改张 ${mixed.reforms} 次；耗时 ${(mixed.elapsedMs / 1000).toFixed(1)} 秒。` : '- 未完成：混合对局片段缺失。'}

## 口径与边界

- 「拒胡」= 锁手前有胡可选却未选胡；「放弃收入」= 这些拒胡窗口的立即总收（按引擎精确分累计）；「改张」= 拒胡且弃非摸牌位（自摸窗口保留摸牌换听）。
- 这是固定种子小样本分布与守恒验收，不推出策略对抗胜率、LLM 强度或长期平衡结论；反事实「若胡实收」未逐笔重放，仅以放弃收入与终局净分对照。
`)
  expect(reports.length).toBeGreaterThan(0)
})
