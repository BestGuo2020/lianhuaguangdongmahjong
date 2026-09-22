// Jev 自对弈批量运行（显式门控，不进门禁测试）：
//   $env:JEV_SELFPLAY_RUN='1'; node node_modules/vitest/vitest.mjs run --dir scripts jev-selfplay-run.test.ts
//
// 环境变量：
//   JEV_SELFPLAY_RUN=1        必填门控
//   JEV_SELFPLAY_TAG          run-id 标签（默认 smoke）
//   JEV_SELFPLAY_ARMS         逗号分隔：blind,hint,baseline（默认全部）
//   JEV_SELFPLAY_MATCHES      每臂场数（默认 4）
//   JEV_SELFPLAY_ROUNDS       每场局数（默认 1）
//   JEV_SELFPLAY_SEED         起始种子（默认 1000）；三臂共用同一种子列（配对比较）
//   JEV_SELFPLAY_TIMEOUT_MS   测试超时（默认 3600000）
//   JEV_BASE_URL              /v1/systemone 服务根（blind/hint 臂必填，如 http://127.0.0.1:8000）
//   JEV_API_KEY               Bearer 凭证（默认 local-dev；OpenJev 未设 OPENJEV_API_KEY 时任意值）
//   JEV_MODEL                 请求 model 字段（默认 jev-latest）
//   JEV_BACKEND               分析记录里的后端标注（默认 openjev；建议写清基座，如 openjev-qwen2.5-1.5b）
//
// 产物（work/jev-selfplay/<run-id>/）：
//   analysis-<arm>-match<N>.json  每场自包含分析包（buildAnalysisExport）
//   summary.json                  每场结果摘要（分数/胡牌/Jev 请求统计/耗时）
//   run-manifest.json             运行清单（commit、臂、种子、端点、模型、计数）
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { LlmProviderConfig } from '../src/game/llm/config'
import { runJevSelfplayMatch, type JevSelfplayMatchResult, type SelfplaySeatPolicy } from './jev-selfplay'

type Arm = 'blind' | 'hint' | 'baseline'

const ARM_SEATS: Record<Arm, readonly [SelfplaySeatPolicy, SelfplaySeatPolicy, SelfplaySeatPolicy, SelfplaySeatPolicy]> = {
  // 被测座位恒为 seat 0；其余三座为同一本地 EV 策略（配对比较只改被测者）。
  blind: ['jev-blind', 'ev', 'ev', 'ev'],
  hint: ['jev-hint', 'ev', 'ev', 'ev'],
  baseline: ['ev', 'ev', 'ev', 'ev'],
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) throw new Error(`${name} 必须是数字`)
  return value
}

it.skipIf(process.env.JEV_SELFPLAY_RUN !== '1')('Jev 自对弈批量运行并落盘分析包', async () => {
  const tag = process.env.JEV_SELFPLAY_TAG ?? 'smoke'
  const arms = (process.env.JEV_SELFPLAY_ARMS ?? 'blind,hint,baseline').split(',').map((arm) => arm.trim()) as Arm[]
  for (const arm of arms) {
    if (!ARM_SEATS[arm]) throw new Error(`未知臂：${arm}（可选 blind,hint,baseline）`)
  }
  const matches = envNumber('JEV_SELFPLAY_MATCHES', 4)
  const rounds = envNumber('JEV_SELFPLAY_ROUNDS', 1)
  const seedBase = envNumber('JEV_SELFPLAY_SEED', 1000)
  const jevBaseUrl = process.env.JEV_BASE_URL ?? ''
  if (arms.some((arm) => arm !== 'baseline') && !jevBaseUrl) {
    throw new Error('blind/hint 臂需要 JEV_BASE_URL（如 http://127.0.0.1:8000；OpenJev: openjev serve --model <基座> --port 8000）')
  }
  const jevConfig: LlmProviderConfig = {
    providerType: 'custom',
    baseUrl: jevBaseUrl || 'http://127.0.0.1:8000',
    apiKey: process.env.JEV_API_KEY ?? 'local-dev',
    model: process.env.JEV_MODEL ?? 'jev-latest',
    style: '稳健',
    // CPU 上 OpenJev 单请求可能到秒级；给足预算，超时走 EV 回退并如实入账。
    timeoutMs: envNumber('JEV_TIMEOUT_MS', 60_000),
    timeoutEnabled: true,
  }
  const backend = process.env.JEV_BACKEND ?? 'openjev'
  const engineBuild = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${tag}`
  const dir = `work/jev-selfplay/${runId}`
  mkdirSync(dir, { recursive: true })

  const summaries: Array<{
    arm: Arm; matchIndex: number; seed: number
    finalScores: number[]; seat0Delta: number; winCounts: number[][]
    jev: JevSelfplayMatchResult['rounds'][number]['jev']
    analysisParts: number | null; reproductionCapable: boolean | null
    elapsedMs: number
  }> = []

  for (const arm of arms) {
    for (let matchIndex = 0; matchIndex < matches; matchIndex += 1) {
      // 三臂共用同一种子列：同种子 = 同牌墙同开局，差异只来自被测座位的策略。
      const seed = seedBase + matchIndex
      const startedAt = performance.now()
      const result = await runJevSelfplayMatch({
        matchSeed: seed,
        rounds,
        seats: ARM_SEATS[arm],
        ...(arm === 'baseline' ? {} : { jev: { config: jevConfig, backend } }),
        engineBuild,
      })
      const file = `${dir}/analysis-${arm}-match${matchIndex}.json`
      writeFileSync(file, JSON.stringify(result.exportPayload))
      const jevTotals = result.rounds.reduce(
        (total, round) => ({
          requests: total.requests + round.jev.requests,
          failures: total.failures + round.jev.failures,
          fallbacks: total.fallbacks + round.jev.fallbacks,
          totalMs: total.totalMs + round.jev.totalMs,
        }),
        { requests: 0, failures: 0, fallbacks: 0, totalMs: 0 },
      )
      summaries.push({
        arm, matchIndex, seed,
        finalScores: result.finalScores,
        seat0Delta: result.finalScores[0] - result.rounds[0].openingScores[0],
        winCounts: result.rounds.map((round) => round.winCounts),
        jev: jevTotals,
        analysisParts: result.analysis?.parts ?? null,
        reproductionCapable: result.exportPayload?.reproductionCapable ?? null,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
      // 每场都必须完整：分数守恒 + 分析包可复现（不守恒的场次会污染摘要，宁可当场失败）
      for (const round of result.rounds) {
        expect(round.endingScores.reduce((sum, score) => sum + score, 0), `${arm} match${matchIndex} round${round.roundIndex}`).toBe(round.openingScores.reduce((sum, score) => sum + score, 0))
      }
      expect(result.exportPayload?.reproductionCapable, `${arm} match${matchIndex} 分析包不可复现`).toBe(true)
    }
  }

  writeFileSync(`${dir}/summary.json`, JSON.stringify(summaries, null, 2))
  writeFileSync(`${dir}/run-manifest.json`, JSON.stringify({
    generatedAt: new Date().toISOString(),
    engineBuild,
    tag,
    arms,
    armSeats: Object.fromEntries(arms.map((arm) => [arm, ARM_SEATS[arm]])),
    matchesPerArm: matches,
    roundsPerMatch: rounds,
    seeds: Array.from({ length: matches }, (_, index) => seedBase + index),
    jev: arms.some((arm) => arm !== 'baseline')
      ? { baseUrl: jevBaseUrl, backend, model: jevConfig.model, timeoutMs: jevConfig.timeoutMs }
      : null,
    files: summaries.map((summary) => `analysis-${summary.arm}-match${summary.matchIndex}.json`),
    notes: [
      '三臂共用种子列（同牌墙同开局）；seat0 为被测座位，其余三座为同一本地 EV 策略。',
      'Jev 概率分布记录在每条 llm attempt 的 answer.value.note（JSON 字符串）。',
      '引擎时钟为虚拟时钟（提交步进 1s）；attempt timing 为真实单调时钟。',
    ],
  }, null, 2))
}, envNumber('JEV_SELFPLAY_TIMEOUT_MS', 3_600_000))
