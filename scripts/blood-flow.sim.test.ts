// Explicit CLI: node node_modules/vitest/vitest.mjs run --dir scripts blood-flow.sim.test.ts
// Not part of `vitest run src`; uses the actual TypeScript engine, not a Python surrogate.
import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { simulateRound } from '../src/game/variants/lotus/bloodFlow/simulation'
import { BLOOD_FLOW_CONFIG } from '../src/game/variants/lotus/bloodFlow/config'

it('1000 fixed seeds conserve physical tiles and money and complete without stalls', () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const patterns: Record<string, number> = {}
  let records = 0, independent = 0, hard = 0, capped = 0, noWins = 0, commands = 0, maxCommands = 0
  const firstWalls: number[] = [], spreads: number[] = []
  const began = performance.now()
  for (let seed = 1; seed <= 1000; seed++) {
    const run = simulateRound(seed)
    expect(run.endingScores.reduce((a, b) => a + b, 0), `seed ${seed}`).toBe(8000)
    expect(run.result.reason).toBe('wall-exhausted')
    records += run.records.length
    independent += run.result.winCounts.filter(n => n > 0).length
    if (!run.records.length) noWins++
    if (run.firstWinWall !== null) firstWalls.push(run.firstWinWall)
    commands += run.commands; maxCommands = Math.max(maxCommands, run.commands)
    spreads.push(Math.max(...run.endingScores) - Math.min(...run.endingScores))
    for (const record of run.records) {
      if (record.score.hardWin) hard++
      if (record.score.finalMultiplier === BLOOD_FLOW_CONFIG.maxMultiplierPerPayer) capped++
      for (const pattern of record.score.items) patterns[pattern.id] = (patterns[pattern.id] ?? 0) + 1
    }
  }
  const mean = (a: number[]) => a.length ? a.reduce((a, b) => a + b, 0) / a.length : null
  const report = { ruleVersion: BLOOD_FLOW_CONFIG.version, commit, seeds: [1, 1000], rounds: 1000,
    strategy: 'legal-action-stress: accept wins; random legal discard; first available meld',
    uiPacingDisabled: true, records, independentFirstWins: independent, repeatedWins: records - independent, noWinRounds: noWins,
    hardWins: hard, hardShare: records ? hard / records : null, cappedWins: capped, capShare: records ? capped / records : null,
    meanFirstWinWall: mean(firstWalls), meanFinalSpread: mean(spreads), maxFinalSpread: Math.max(...spreads),
    meanCommands: commands / 1000, maxCommands, patternRecordCounts: patterns, elapsedMs: performance.now() - began,
    limitations: ['Counts include repeated wins from locked hands; independent first wins reported separately.',
      'Random legal stress policy is not a balance or strategy-strength estimate.',
      'Rare patterns require the separately verified conditional hand fixtures; no Python experiment results reused.'] }
  mkdirSync('work', { recursive: true })
  writeFileSync('work/blood-flow-simulation.json', JSON.stringify(report, null, 2))
  writeFileSync('docs/lotus-blood-flow-simulation.md', `# 血流 TypeScript 千局守恒报告\n\n规则：${report.ruleVersion}；提交：${commit}；种子：1～1000；样本：1000 局。\n\n策略：合法动作压力策略（有胡即胡、随机合法弃牌、首个合法副露）；为提速关闭 UI 节拍，其他规则与实际引擎相同。每个动作均检查 136 张物理牌、有效手牌张数和积分零和；全部完成，无停滞。\n\n| 指标 | 结果 |\n|---|---:|\n| 胡牌记录 | ${records} |\n| 独立首次成牌 | ${independent} |\n| 锁手后重复胡 | ${records - independent} |\n| 无人胡的局 | ${noWins} |\n| 硬胡占比 | ${(100 * hard / Math.max(1, records)).toFixed(2)}% |\n| 封顶占比 | ${(100 * capped / Math.max(1, records)).toFixed(2)}% |\n| 首胡平均剩余墙长 | ${mean(firstWalls)?.toFixed(2) ?? '无样本'} |\n| 平均终局分差 | ${mean(spreads)?.toFixed(2)} |\n| 最大终局分差 | ${Math.max(...spreads)} |\n| 平均命令数 | ${(commands / 1000).toFixed(2)} |\n| 最大命令数 | ${maxCommands} |\n\n番型记录（包含同手重复胡）：\n\n${Object.entries(patterns).sort((a,b)=>b[1]-a[1]).map(([id,n])=>`- ${id}：${n}`).join('\n')}\n\n此结果验证守恒与推进，不证明规则 AI/LLM 强度或玩法平衡。稀有番型另用黄金与条件压力样本验证；没有以旧 Python 数据代替新版本结果。\n`)
}, 300_000)
