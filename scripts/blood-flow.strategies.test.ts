// Explicit acceptance run; this does not change production strategy or timing.
import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { decideBloodFlowAction } from '../src/game/variants/lotus/bloodFlow/ai'
import { seededRandom, simulateRound } from '../src/game/variants/lotus/bloodFlow/simulation'
import { SEATS } from '../src/game/variants/lotus/bloodFlow/state'
import { BLOOD_FLOW_CONFIG } from '../src/game/variants/lotus/bloodFlow/config'

it('compares fixed-seed distributions for stress, rule AI and a first-win threshold', () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const reports = []
  for (const strategy of ['stress', 'rules-ai', 'rules-ai-min40'] as const) {
    let wins = 0, first = 0, hard = 0, capped = 0, commands = 0, noWin = 0, wallSum = 0, spreadSum = 0, maxSpread = 0
    const patterns: Record<string, number> = {}, started = performance.now()
    for (let seed = 1; seed <= 100; seed++) {
      const run = strategy === 'stress' ? simulateRound(seed) : (() => {
        const engine = new BloodFlowEngine({ authorityEpoch: 'strategy-sample', roundId: `seed-${seed}`,
          random: seededRandom(seed), now: () => 0, winBeatMs: 0 })
        let steps = 0, firstWinWall: number | null = null
        while (!engine.result) {
          if (++steps > 2000) throw new Error(`Stalled ${strategy} seed ${seed}`)
          const window = engine.window!, seat = SEATS.find(s => window.options[s].length && !window.decisions[s])!
          const action = decideBloodFlowAction(bloodFlowSeatView(engine, seat), strategy === 'rules-ai-min40' ? 40 : 0)
          const before = engine.wall.length
          expect(action).toBeTruthy()
          expect(engine.submit(engine.command(seat, action!))).toBe(true)
          engine.assertConservation()
          if (firstWinWall === null && engine.archives.length) firstWinWall = before
        }
        return { commands: steps, firstWinWall, result: engine.result, records: engine.publicState().batches.flatMap(b => b.winners),
          endingScores: engine.players.map(p => p.score) }
      })()
      expect(run.endingScores.reduce((a, b) => a + b, 0)).toBe(8000)
      expect(run.result.reason).toBe('wall-exhausted')
      commands += run.commands; wins += run.records.length; first += run.result.winCounts.filter(n => n > 0).length
      if (run.firstWinWall === null) noWin++; else wallSum += run.firstWinWall
      const spread = Math.max(...run.endingScores) - Math.min(...run.endingScores)
      spreadSum += spread; maxSpread = Math.max(maxSpread, spread)
      for (const record of run.records) {
        if (record.score.hardWin) hard++
        if (record.score.capped) capped++
        for (const item of record.score.items) patterns[item.id] = (patterns[item.id] ?? 0) + 1
      }
    }
    reports.push({ strategy, rounds: 100, wins, first, repeats: wins - first, hard, capped, noWin,
      meanFirstWall: noWin === 100 ? null : wallSum / (100 - noWin), meanSpread: spreadSum / 100, maxSpread,
      meanCommands: commands / 100, patterns, elapsedMs: performance.now() - started })
  }
  writeFileSync('work/blood-flow-strategies.json', JSON.stringify({ commit, ruleVersion: BLOOD_FLOW_CONFIG.version, seeds: [1, 100], reports }, null, 2))
  writeFileSync('docs/lotus-blood-flow-strategies.md', `# 血流固定种子策略分布\n\n规则：${BLOOD_FLOW_CONFIG.version}；引擎提交：${commit}；每策略 100 局，种子 1～100。\n\n各策略四席自我对局，使用相同开局种子。stress 为随机合法弃牌；rules-ai 为生产规则 AI（仅己方手牌与公开信息）；rules-ai-min40 使用同一 AI，但首次胡要求单家至少 40 分。已胡后仍接受合法胡。显式关闭 UI 节拍；每动作检查 136 张物理牌与零和，全部结束，无停滞。\n\n| 策略 | 首次成牌 | 重复胡 | 无胡局 | 硬胡记录 | 封顶记录 | 首胡墙长均值 | 终局分差均值/最大 | 命令数均值 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${reports.map(r => `| ${r.strategy} | ${r.first} | ${r.repeats} | ${r.noWin} | ${r.hard} | ${r.capped} | ${r.meanFirstWall?.toFixed(2) ?? '—'} | ${r.meanSpread.toFixed(2)} / ${r.maxSpread} | ${r.meanCommands.toFixed(2)} |`).join('\n')}\n\n${reports.map(r => `## ${r.strategy}\n\n运行耗时 ${(r.elapsedMs / 1000).toFixed(2)} 秒；硬胡占比 ${(100 * r.hard / Math.max(1, r.wins)).toFixed(2)}%；封顶占比 ${(100 * r.capped / Math.max(1, r.wins)).toFixed(2)}%。番型记录（含同手重复）：${Object.entries(r.patterns).map(([id,n])=>`${id} ${n}`).join('、')}。`).join('\n\n')}\n\n这是小样本分布与守恒验收，不能推出策略对抗胜率、LLM 强度或长期平衡结论。没有真实模型请求；条件大牌三响及十三幺/封顶黄金样本另行列明，不混入随机发生率。\n`)
}, 300_000)
