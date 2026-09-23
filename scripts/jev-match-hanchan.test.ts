// Jev 蒸馏模型 vs 本地 AI 一局血流半庄 + 完整对局数据导出（显式门控）：
//   $env:JEV_MATCH_RUN='1'; $env:JEV_BASE_URL='http://127.0.0.1:8300'
//   node node_modules/vitest/vitest.mjs run --dir scripts jev-match-hanchan.test.ts
// 产物 work/jev-match-hanchan-<stamp>/：
//   match-analysis.json  自包含分析包（分析记录 + 展示回放 + 配置，可进应用回放导入器）
//   match-replay.json    展示回放子集（match + rounds）
//   summary.json         人读摘要（座位/分数/名次/逐局收支/Jev 请求统计）
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { runJevSelfplayMatch } from './jev-selfplay'

it.skipIf(process.env.JEV_MATCH_RUN !== '1')('Jev 蒸馏模型 vs 本地 AI 血流半庄一局 + 完整导出', async () => {
  const baseUrl = process.env.JEV_BASE_URL ?? 'http://127.0.0.1:8300'
  const seed = Number(process.env.JEV_MATCH_SEED ?? 20260924)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const dir = `work/jev-match-hanchan-${stamp}`
  mkdirSync(dir, { recursive: true })
  const result = await runJevSelfplayMatch({
    matchSeed: seed,
    rounds: 8,
    matchType: 'hanchan',
    seats: ['jev-hint', 'ev', 'ev', 'ev'],
    jev: {
      config: {
        providerType: 'custom', baseUrl, apiKey: 'local',
        model: process.env.JEV_MODEL ?? 'jev-latest',
        style: '稳健', timeoutMs: 60_000, timeoutEnabled: true,
      },
      backend: process.env.JEV_BACKEND ?? 'openjev-qwen2.5-1.5b-lora-v3-cal',
    },
    engineBuild: 'match-export',
  })
  const payload = result.exportPayload
  if (!payload) throw new Error('无导出包（分析录制未开启？）')
  writeFileSync(`${dir}/match-analysis.json`, JSON.stringify(payload, null, 2))
  writeFileSync(`${dir}/match-replay.json`, JSON.stringify(payload.replay, null, 2))
  writeFileSync(`${dir}/summary.json`, JSON.stringify({
    seed,
    matchType: 'hanchan',
    rounds: 8,
    seats: ['jev-hint(distilled+calibrated)', 'ev', 'ev', 'ev'],
    finalScores: result.finalScores,
    standings: result.standings,
    rounds: result.rounds.map((r) => ({
      round: r.roundIndex, dealer: r.dealer, deltas: r.deltas, winCounts: r.winCounts, jev: r.jev,
    })),
    reproductionCapable: payload.reproductionCapable,
    manifest: payload.manifest,
  }, null, 2))
  expect(result.rounds).toHaveLength(8)
  expect(payload.reproductionCapable).toBe(true)
  for (const r of result.rounds) expect(r.deltas.reduce((a, b) => a + b, 0)).toBe(0)
}, 7_200_000)
