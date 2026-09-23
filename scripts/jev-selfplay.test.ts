// Jev 无头自对弈冒烟：显式 CLI 运行（不混入 vitest run src）：
//   node node_modules/vitest/vitest.mjs run --dir scripts jev-selfplay.test.ts
// 覆盖：纯本地四人局（守恒/回放/分析包）、mock /v1/systemone 真 HTTP 往返（记录形状）、
// Jev 端点不可用时的 EV 回退（对局必须完整跑完）、同种子确定性。
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { LlmProviderConfig } from '../src/game/llm/config'
import { runJevSelfplayMatch, type SelfplaySeatPolicy } from './jev-selfplay'

const SEATS_LOCAL: readonly [SelfplaySeatPolicy, SelfplaySeatPolicy, SelfplaySeatPolicy, SelfplaySeatPolicy] =
  ['ev', 'heuristic', 'ev', 'heuristic']

function jevConfig(baseUrl: string): LlmProviderConfig {
  return {
    providerType: 'custom', baseUrl, apiKey: 'selfplay-test',
    model: 'mock-jev', style: '稳健', timeoutMs: 10_000, timeoutEnabled: true,
  }
}

// ── mock /v1/systemone：确定性选第一个候选，概率均分（OpenJev wire 兼容形状） ──
let server: Server | null = null
let baseUrl = ''
let servedRequests = 0
let lastRequestBody: { state?: unknown; questions?: Record<string, { type?: string; criteria?: Record<string, unknown> }> } | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      servedRequests += 1
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      lastRequestBody = body
      const answers: Record<string, unknown> = {}
      for (const [name, question] of Object.entries(body.questions ?? {})) {
        if (question.type === 'choice') {
          const keys = Object.keys(question.criteria ?? {})
          const even = keys.length ? 1 / keys.length : 1
          answers[name] = {
            choice: keys[0] ?? '',
            probabilities: Object.fromEntries(keys.map((key) => [key, even])),
            confidence: 0.25,
          }
        } else if (question.type === 'noul') {
          answers[name] = { noul: 0.5 }
        } else {
          answers[name] = { score: 1, probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0 }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ answers }))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())))
})

describe('jev-selfplay 冒烟', () => {
  it('纯本地四人局：分数守恒、回放与分析包自洽', async () => {
    const result = await runJevSelfplayMatch({ matchSeed: 42, rounds: 2, seats: SEATS_LOCAL, engineBuild: 'test' })
    expect(result.rounds).toHaveLength(2)
    for (const round of result.rounds) {
      expect(round.endingScores.reduce((sum, score) => sum + score, 0)).toBe(4 * 2000)
      expect(round.reason).toBe('wall-exhausted')
      expect(round.submits).toBeGreaterThan(10)
    }
    // 携分：第 2 局开局 = 第 1 局终局
    expect(result.rounds[1].openingScores).toEqual(result.rounds[0].endingScores)
    expect(result.replayMatch?.status).toBe('finished')
    expect(result.replayRounds).toHaveLength(2)
    expect(result.analysis).not.toBeNull()
    expect(result.analysis!.parts).toBeGreaterThan(0)
    const payload = result.exportPayload!
    expect(payload.kind).toBe('lianhua-analysis')
    expect(payload.manifest.configReferencesClosed).toBe(true)
    expect(payload.manifest.includesReplay).toBe(true)
    const tags = payload.manifest.records
    for (const tag of ['config', 'decisionState', 'decision', 'settlement', 'reproduction']) {
      expect(tags[tag], `缺少 ${tag} 记录`).toBeGreaterThan(0)
    }
    // 复现数据带完整命令与 legalActionId（§10.6 精确重放前提）
    const reproductions = payload.records.filter((part) => part.tag === 'reproduction')
      .map((part) => part.value as { commands?: Array<{ legalActionId?: string; windowId?: string }> })
    expect(reproductions).toHaveLength(2)
    for (const reproduction of reproductions) {
      expect(reproduction.commands!.length).toBeGreaterThan(10)
      expect(reproduction.commands!.every((command) => command.legalActionId)).toBe(true)
    }
    expect(payload.reproductionCapable).toBe(true)
  }, 300_000)

  it('jev-blind 座位走真 HTTP mock：请求形状正确、记录 model 来源与概率；collect 的 claim 行带 claim 指令', async () => {
    servedRequests = 0
    lastRequestBody = null
    const collectPath = 'work/jev-smoke-collect.jsonl'
    if (existsSync(collectPath)) rmSync(collectPath)
    const result = await runJevSelfplayMatch({
      matchSeed: 7,
      seats: ['jev-blind', 'ev', 'ev', 'ev'],
      jev: { config: jevConfig(baseUrl), backend: 'mock' },
      engineBuild: 'test',
      collect: { path: collectPath, mode: 'hint' },
    })
    expect(servedRequests).toBeGreaterThan(0)
    expect(result.rounds[0].jev.requests).toBe(servedRequests)
    expect(result.rounds[0].jev.failures).toBe(0)
    expect(result.collectedSamples).toBeGreaterThan(0)
    // 集成回归（v2 bug）：claim 窗口的 instructions 必须由真实 request.state.decision 驱动
    const lines = readFileSync(collectPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(lines).toHaveLength(result.collectedSamples)
    const claimLines = lines.filter((line) => line.state.situation.decision === 'claim')
    const turnLines = lines.filter((line) => line.state.situation.decision === 'turn')
    expect(turnLines.length).toBeGreaterThan(0)
    expect(claimLines.length, 'seed 7 单局应出现至少一个响应窗口样本').toBeGreaterThan(0)
    expect(claimLines.every((line) => String(line.questions.action.instructions).includes('claimTile'))).toBe(true)
    expect(turnLines.every((line) => String(line.questions.action.instructions).includes('轮到本家行动'))).toBe(true)
    expect(lines.every((line) => line.state.template === 'jev-bf-hint-v3')).toBe(true)
    rmSync(collectPath)
    // wire 形状：state 为对象、主问题为 choice、criteria 值不含推荐标记
    expect(lastRequestBody).not.toBeNull()
    expect(lastRequestBody!.state).toBeTypeOf('object')
    const payload = result.exportPayload!
    const attempts = payload.records.filter((part) => part.tag === 'llm').map((part) => part.value as Record<string, unknown>)
    expect(attempts.length).toBe(servedRequests)
    for (const attempt of attempts) {
      expect(attempt.provider).toBe('jev:mock')
      expect(attempt.outcome).toBe('success')
      const answer = attempt.answer as { known: boolean; value: { candidateId?: string; note?: string } }
      expect(answer.known).toBe(true)
      expect(answer.value.candidateId).toBeTypeOf('string')
      const note = JSON.parse(answer.value.note ?? '{}') as { probabilities?: Record<string, number>; confidence?: number }
      expect(note.confidence).toBe(0.25)
      expect(Object.values(note.probabilities ?? {}).length).toBeGreaterThan(0)
    }
    // Jev 座位的决策来源应为 model（mock 永不失败）
    const decisions = payload.records.filter((part) => part.tag === 'decision').map((part) => part.value as { seat: number; source: string; llmAttemptIds?: string[] })
    const jevSeatDecisions = decisions.filter((decision) => decision.llmAttemptIds?.length)
    expect(jevSeatDecisions.length).toBeGreaterThan(0)
    expect(jevSeatDecisions.every((decision) => decision.seat === 0 && decision.source === 'model')).toBe(true)
    expect(result.rounds[0].endingScores.reduce((sum, score) => sum + score, 0)).toBe(8000)
  }, 300_000)

  it('Jev 端点不可用：EV 回退接管，对局完整跑完且来源记为 model-fallback', async () => {
    const result = await runJevSelfplayMatch({
      matchSeed: 99,
      seats: ['jev-hint', 'ev', 'ev', 'ev'],
      // 端口 1：连接立即被拒（network 错误）
      jev: { config: jevConfig('http://127.0.0.1:1'), backend: 'unreachable' },
      engineBuild: 'test',
    })
    expect(result.rounds[0].reason).toBe('wall-exhausted')
    expect(result.rounds[0].jev.failures).toBe(result.rounds[0].jev.requests)
    expect(result.rounds[0].jev.fallbacks).toBe(result.rounds[0].jev.requests)
    const payload = result.exportPayload!
    const attempts = payload.records.filter((part) => part.tag === 'llm').map((part) => part.value as { outcome: string; fallback?: { strategy: string } })
    expect(attempts.length).toBeGreaterThan(0)
    expect(attempts.every((attempt) => attempt.outcome === 'network-error' && attempt.fallback?.strategy === 'ev')).toBe(true)
    const decisions = payload.records.filter((part) => part.tag === 'decision').map((part) => part.value as { source: string; llmAttemptIds?: string[] })
    expect(decisions.filter((decision) => decision.llmAttemptIds?.length).every((decision) => decision.source === 'model-fallback')).toBe(true)
    expect(result.rounds[0].endingScores.reduce((sum, score) => sum + score, 0)).toBe(8000)
  }, 300_000)

  it('同种子确定性：两次本地对局终局分数一致', async () => {
    const first = await runJevSelfplayMatch({ matchSeed: 1234, seats: SEATS_LOCAL, engineBuild: 'test' })
    const second = await runJevSelfplayMatch({ matchSeed: 1234, seats: SEATS_LOCAL, engineBuild: 'test' })
    expect(first.rounds[0].endingScores).toEqual(second.rounds[0].endingScores)
    expect(first.rounds[0].submits).toBe(second.rounds[0].submits)
  }, 300_000)
})
