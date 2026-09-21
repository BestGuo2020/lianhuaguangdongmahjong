import { shallowRef } from 'vue'
import { normalizeBaseUrl, type LlmProviderConfig } from './config'

// Session-local and shared across seats/rounds. Never serialize keys: they contain credentials.
const pauses = new Map<string, { noticed: boolean; generation: number }>()
const probes = new Map<string, Promise<{ ok: boolean; message: string }>>()
const revision = shallowRef(0)
let generation = 0
const keyOf = (config: LlmProviderConfig) => JSON.stringify([
  normalizeBaseUrl(config.baseUrl), config.apiKey.trim(), config.model.trim(),
])

export function quotaStatus(config: LlmProviderConfig): 'available' | 'paused' | 'probing' {
  void revision.value
  const key = keyOf(config)
  return probes.has(key) ? 'probing' : pauses.has(key) ? 'paused' : 'available'
}

/** Deliberately excludes generic 403, rate-limit 429 and ambiguous quota-exceeded messages. */
export function isQuotaExhaustedResponse(status: number, body: string): boolean {
  if (![402, 403, 429].includes(status)) return false
  let message = body, code = ''
  try {
    const parsed = JSON.parse(body), error = parsed?.error ?? parsed
    message = typeof error?.message === 'string' ? error.message : ''
    code = [error?.code, error?.type].filter(v => typeof v === 'string').join(' ')
  } catch { /* Some providers return plain text. */ }
  return /\b(insufficient_quota|billing_hard_limit_reached|insufficient_balance)\b/i.test(code)
    || (!/rate.?limit|per (?:minute|second)|tokens? per|requests? per|\b(?:TPM|RPM|RPS)\b|速率|每分钟|每秒/i.test(message)
      && (/\b(?:free\s+)?quota\s+(?:is\s+)?exhausted\b|\binsufficient (?:account )?(?:balance|credits)\b|\bcredit balance is too low\b/i.test(message)
        || /(?:免费)?额度(?:已)?(?:耗尽|用完)|余额不足/.test(message)))
}

export function pauseQuota(config: LlmProviderConfig): void {
  const key = keyOf(config), previous = pauses.get(key)
  pauses.set(key, { noticed: previous?.noticed ?? false, generation: ++generation })
  revision.value++
}

export function takeQuotaNotice(config: LlmProviderConfig): boolean {
  const pause = pauses.get(keyOf(config))
  if (!pause || pause.noticed) return false
  pause.noticed = true
  return true
}

/** Only explicit connection tests probe. Game requests remain blocked until a successful probe. */
export function probeQuotaConnection(config: LlmProviderConfig, work: () => Promise<{ ok: boolean; message: string }>) {
  const key = keyOf(config), existing = probes.get(key)
  if (existing) return existing
  const startGeneration = pauses.get(key)?.generation
  const promise = Promise.resolve().then(work).then(result => {
    // A later quota failure from an already in-flight request must not be erased by this probe.
    if (result.ok) {
      if (pauses.get(key)?.generation !== startGeneration) return { ok: false, message: '仍收到额度耗尽响应，连接保持暂停，请稍后重新连接' }
      pauses.delete(key)
    }
    return result
  }).finally(() => { probes.delete(key); revision.value++ })
  probes.set(key, promise); revision.value++
  return promise
}
