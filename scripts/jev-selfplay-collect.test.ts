// Jev gold 数据采集（显式门控，不进门禁测试）：
//   $env:JEV_SELFPLAY_COLLECT='1'; $env:JEV_COLLECT_TAG='train'; $env:JEV_COLLECT_MATCHES='20'; $env:JEV_COLLECT_SEED='1000'
//   node node_modules/vitest/vitest.mjs run --dir scripts jev-selfplay-collect.test.ts
//
// 产物：work/jev-calibration/<tag>.jsonl + <tag>.manifest.json
// 口径：四座全本地 EV（无需 /v1/systemone 端点）；gold = engineSuggestion（BLOOD_FLOW_LLM_AI 候选层）；
//   样本与 pilot 请求**同源构造**（jev-selfplay.ts 内同一个 buildJevBloodFlowRequest）——模板漂移即校准数据失效。
// 环境变量：JEV_COLLECT_TAG / MATCHES / SEED / MODE(hint|blind) / TIMEOUT_MS
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { jevBloodFlowTemplateId, type JevBloodFlowMode } from '../src/game/llm/jevBloodFlowInput'
import { runJevSelfplayMatch, type SelfplaySeatPolicy } from './jev-selfplay'

const EV_SEATS: readonly [SelfplaySeatPolicy, SelfplaySeatPolicy, SelfplaySeatPolicy, SelfplaySeatPolicy] =
  ['ev', 'ev', 'ev', 'ev']

it.skipIf(process.env.JEV_SELFPLAY_COLLECT !== '1')('采集 OpenJev 校正用 gold JSONL', async () => {
  const tag = process.env.JEV_COLLECT_TAG ?? 'train'
  const matches = Number(process.env.JEV_COLLECT_MATCHES ?? 20)
  const seedBase = Number(process.env.JEV_COLLECT_SEED ?? 1000)
  const mode = (process.env.JEV_COLLECT_MODE ?? 'hint') as JevBloodFlowMode
  if (!Number.isFinite(matches) || matches < 1) throw new Error('JEV_COLLECT_MATCHES 必须是正数')
  if (mode !== 'hint' && mode !== 'blind') throw new Error(`未知采集模式：${mode}`)
  const dir = 'work/jev-calibration'
  mkdirSync(dir, { recursive: true })
  const path = `${dir}/${tag}.jsonl`
  if (existsSync(path)) throw new Error(`${path} 已存在：拒绝向旧文件追加（换 tag 或先删除）`)
  const engineBuild = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  const perMatch: Array<{ seed: number; samples: number; elapsedMs: number }> = []
  let samples = 0
  for (let index = 0; index < matches; index += 1) {
    const seed = seedBase + index
    const result = await runJevSelfplayMatch({
      matchSeed: seed,
      rounds: 1,
      seats: EV_SEATS,
      engineBuild,
      analysis: false,
      collect: { path, mode },
    })
    samples += result.collectedSamples
    perMatch.push({ seed, samples: result.collectedSamples, elapsedMs: Math.round(result.totalElapsedMs) })
  }

  writeFileSync(`${dir}/${tag}.manifest.json`, JSON.stringify({
    tag,
    mode,
    templateId: jevBloodFlowTemplateId(mode),
    matches,
    seedRange: [seedBase, seedBase + matches - 1],
    policy: 'ev-all-seats; gold=engineSuggestion (BLOOD_FLOW_LLM_AI)',
    engineBuild,
    samples,
    samplesPerMatch: samples / matches,
    perMatch,
    bytes: statSync(path).size,
    collectedAt: new Date().toISOString(),
    format: '每行 {state, questions:{action:{type:choice,...}}, gold:{action}}（OpenJev calibrate/eval 格式）',
    caveat: '状态来自 EV 策略自身轨迹（teacher-on-policy）；学生（Jev）访问的状态分布略有偏移，迭代采集（DAgger 式）属后续轮次',
  }, null, 2))
  // 每场全四座应产出约 80–200 条样本；低于 50/场说明采集路径出了问题
  expect(samples).toBeGreaterThan(matches * 50)
}, Number(process.env.JEV_COLLECT_TIMEOUT_MS ?? 7_200_000))
