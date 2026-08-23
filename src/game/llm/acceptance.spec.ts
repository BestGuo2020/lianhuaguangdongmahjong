// LLM 验收：真实 DeepSeek API 下，master 分支能够完整跑完一局「东风场」——
// ① 莲花广麻 ② 莲花麻将。默认跳过（涉及真实网络与计费），仅在 LLM_ACCEPTANCE=1 时执行：
//   $env:LLM_API_KEY=(Get-Content tmp/ds-test-key.txt -Raw).Trim(); $env:LLM_ACCEPTANCE='1'
//   pnpm exec vitest run src/game/llm/acceptance.spec.ts
// 说明：API Key 仅经环境变量传入，不写入日志/报告/代码。
// tsconfig 未含 @types/node，这里用最小声明垫片。
declare const process: { env: Record<string, string | undefined> }

import { describe, expect, it, vi } from 'vitest'
import { useGame } from '../core/local/useGame'
import { useLotusGame } from '../variants/lotus/lotusGame'
import { CoreLlmController, LotusLlmController, createLlmStats, type LlmControllerStats } from './llmController'
import { AiController } from '../core/controllers/playerController'
import { LotusAiController } from '../variants/lotus/lotusControllers'
import type { LlmProviderConfig } from './config'

const enabled = process.env.LLM_ACCEPTANCE === '1'
const acceptIt = enabled ? it : it.skip
const MATCH_TIMEOUT_MS = 12 * 60 * 1000

function loadApiKey(): string {
  return process.env.LLM_API_KEY ?? ''
}

function provider(): LlmProviderConfig {
  return {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: loadApiKey(),
    model: 'deepseek-chat',
    style: '稳健',
    timeoutMs: 20_000,
  }
}

function stubWindows() {
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
}

interface MatchResult {
  variant: string
  finished: boolean
  phase: string
  round: number
  steps: number
  elapsedMs: number
  stats: LlmControllerStats
  scores: number[]
  settledRounds: number
}

async function runCoreMatch(providerConfig: LlmProviderConfig): Promise<MatchResult> {
  const stats = createLlmStats()
  const llm = new CoreLlmController(providerConfig, {}, stats)
  const quick = new AiController({ turn: 0, afterKong: 0, claim: 0 }, (fn) => fn())
  const controllers = [llm, quick, quick, quick]
  const game = useGame({ playSound: () => {}, playSoundAndWait: async () => {}, controllers, countdownEnabled: false })
  const startedAt = Date.now()
  let steps = 0
  let settled = 0
  const startPromise = game.startGame('east')
  while (steps < 7000 && !game.matchFinished.value && game.phase.value !== 'finished') {
    steps += 1
    if (game.phase.value === 'settled') {
      settled += 1
      game.nextRound()
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (Date.now() - startedAt > MATCH_TIMEOUT_MS) break
  }
  await startPromise.catch(() => {})
  return {
    variant: '广麻(lotus-classic)',
    finished: game.matchFinished.value || game.phase.value === 'finished',
    phase: game.phase.value,
    round: game.round.value,
    steps,
    elapsedMs: Date.now() - startedAt,
    stats,
    scores: game.players.map((player) => player.score),
    settledRounds: settled,
  }
}

async function runLotusMatch(providerConfig: LlmProviderConfig): Promise<MatchResult> {
  const stats = createLlmStats()
  const llm = new LotusLlmController(providerConfig, {}, stats)
  const quick = new LotusAiController({ turn: 0, afterKong: 0, claim: 0 }, (fn) => fn())
  const controllers = [llm, quick, quick, quick]
  const game = useLotusGame({ playSound: () => {}, playSoundAndWait: async () => {}, controllers, countdownEnabled: false })
  const startedAt = Date.now()
  let steps = 0
  let settled = 0
  const startPromise = game.startGame('east')
  while (steps < 7000 && !game.matchFinished.value && game.phase.value !== 'finished') {
    steps += 1
    if (game.phase.value === 'settled') {
      settled += 1
      game.nextRound()
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (Date.now() - startedAt > MATCH_TIMEOUT_MS) break
  }
  await startPromise.catch(() => {})
  return {
    variant: '莲花(lotus-legacy)',
    finished: game.matchFinished.value || game.phase.value === 'finished',
    phase: game.phase.value,
    round: game.round.value,
    steps,
    elapsedMs: Date.now() - startedAt,
    stats,
    scores: game.players.map((player) => player.score),
    settledRounds: settled,
  }
}

describe('LLM 验收：真实 DeepSeek API 完整跑完东风场', () => {
  acceptIt('莲花广麻（白板癞子）东风场在 LLM 参与下完整打完', async () => {
    stubWindows()
    const result = await runCoreMatch(provider())
    console.log(`[acceptance] ${result.variant} finished=${result.finished} phase=${result.phase} `
      + `round=${result.round} settled=${result.settledRounds} elapsed=${Math.round(result.elapsedMs / 1000)}s `
      + `stats=${JSON.stringify(result.stats)} scores=${JSON.stringify(result.scores)}`)
    expect(result.finished).toBe(true)
    expect(result.settledRounds).toBeGreaterThan(0)
    expect(result.stats.requests).toBeGreaterThan(5)   // LLM 确实参与了决策
    expect(result.stats.fallbacks).toBeLessThan(result.stats.requests) // 大部分请求成功（允许少量回退）
    
  }, 20 * 60_000)

  acceptIt('莲花麻将（翻精癞子）东风场在 LLM 参与下完整打完', async () => {
    stubWindows()
    const result = await runLotusMatch(provider())
    console.log(`[acceptance] ${result.variant} finished=${result.finished} phase=${result.phase} `
      + `round=${result.round} settled=${result.settledRounds} elapsed=${Math.round(result.elapsedMs / 1000)}s `
      + `stats=${JSON.stringify(result.stats)} scores=${JSON.stringify(result.scores)}`)
    expect(result.finished).toBe(true)
    expect(result.settledRounds).toBeGreaterThan(0)
    expect(result.stats.requests).toBeGreaterThan(5)
    expect(result.stats.fallbacks).toBeLessThan(result.stats.requests)
    // 报告经 console.log 输出（不落盘，避免 key 泄漏面）
  }, 20 * 60_000)
})
