import type { LlmProviderConfig } from './config'
import type { ReasoningPolicy } from './reasoningPolicy'

const MAX_REASONING_TOKENS = 65_536
const FINAL_RESPONSE_RESERVE = 96
const MAX_SAMPLES = 32
const MAX_LENGTH_FAILURES = 2
const SUPPRESSION_MS = 30 * 60_000

interface BudgetState {
  samples: number[]
  nextFloor: number
  maxLengthFailures: number
  suppressedUntil: number
}

const states = new Map<string, BudgetState>()

function keyOf(config: Pick<LlmProviderConfig, 'baseUrl' | 'model'>, policy: ReasoningPolicy): string {
  let endpoint = config.baseUrl.trim().toLowerCase().replace(/\/+$/, '')
  try { endpoint = new URL(config.baseUrl).hostname.toLowerCase() } catch { /* 保留规范化原值 */ }
  return JSON.stringify([endpoint, config.model.trim().toLowerCase(), policy.requestBody.reasoning_effort ?? policy.requestBody.thinking ?? 'thinking'])
}

function stateOf(key: string): BudgetState {
  let state = states.get(key)
  if (!state) {
    state = { samples: [], nextFloor: 0, maxLengthFailures: 0, suppressedUntil: 0 }
    states.set(key, state)
  }
  return state
}

function roundUpBudget(value: number): number {
  let result = 128
  while (result < value && result < MAX_REASONING_TOKENS) result *= 2
  return Math.min(MAX_REASONING_TOKENS, result)
}

/** 无样本时沿用初始预算；有样本后按近期 P99 reasoning + 最终 JSON 预留动态调整。 */
export function adaptiveReasoningBudget(
  config: Pick<LlmProviderConfig, 'baseUrl' | 'model'>,
  policy: ReasoningPolicy,
  initialBudget: number,
  minimumBudget = 512,
): number {
  const state = stateOf(keyOf(config, policy))
  if (!state.samples.length) return Math.min(MAX_REASONING_TOKENS, Math.max(minimumBudget, initialBudget))
  const sorted = [...state.samples].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * 0.99) - 1)
  const observed = sorted[index] + FINAL_RESPONSE_RESERVE
  return roundUpBudget(Math.max(minimumBudget, observed, state.nextFloor))
}

export function recordReasoningSuccess(
  config: Pick<LlmProviderConfig, 'baseUrl' | 'model'>,
  policy: ReasoningPolicy,
  reasoningTokens: number,
): void {
  const state = stateOf(keyOf(config, policy))
  if (Number.isFinite(reasoningTokens) && reasoningTokens > 0) {
    state.samples.push(Math.floor(reasoningTokens))
    if (state.samples.length > MAX_SAMPLES) state.samples.shift()
  }
  state.nextFloor = 0
  state.maxLengthFailures = 0
  state.suppressedUntil = 0
}

export function recordReasoningLength(
  config: Pick<LlmProviderConfig, 'baseUrl' | 'model'>,
  policy: ReasoningPolicy,
  attemptedBudget: number,
  reasoningTokens = 0,
): void {
  const state = stateOf(keyOf(config, policy))
  const observed = reasoningTokens > 0 ? reasoningTokens : attemptedBudget
  state.samples.push(Math.min(MAX_REASONING_TOKENS, Math.floor(observed)))
  if (state.samples.length > MAX_SAMPLES) state.samples.shift()
  state.nextFloor = Math.min(MAX_REASONING_TOKENS, Math.max(state.nextFloor, attemptedBudget * 2))
  if (attemptedBudget >= MAX_REASONING_TOKENS) {
    state.maxLengthFailures += 1
    if (state.maxLengthFailures >= MAX_LENGTH_FAILURES) {
      state.suppressedUntil = Date.now() + SUPPRESSION_MS
    }
  }
}

export function isReasoningTemporarilySuppressed(
  config: Pick<LlmProviderConfig, 'baseUrl' | 'model'>,
  policy: ReasoningPolicy,
): boolean {
  const state = states.get(keyOf(config, policy))
  if (!state?.suppressedUntil) return false
  if (state.suppressedUntil <= Date.now()) {
    state.suppressedUntil = 0
    state.maxLengthFailures = 0
    return false
  }
  return true
}

export function resetReasoningBudgetForTests(): void {
  states.clear()
}

export const REASONING_BUDGET_LIMITS = {
  maxTokens: MAX_REASONING_TOKENS,
  finalReserveTokens: FINAL_RESPONSE_RESERVE,
  maxSamples: MAX_SAMPLES,
  maxLengthFailures: MAX_LENGTH_FAILURES,
  suppressionMs: SUPPRESSION_MS,
} as const
