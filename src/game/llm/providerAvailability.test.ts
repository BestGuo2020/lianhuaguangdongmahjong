import { afterEach, expect, it, vi } from 'vitest'
import { isQuotaExhaustedResponse, pauseQuota, probeQuotaConnection, quotaStatus } from './providerAvailability'
import { requestLlmDecision, testLlmConnection } from './client'
import type { LlmProviderConfig } from './config'

let serial = 0
const config = (): LlmProviderConfig => ({ baseUrl: 'https://quota.example.test/v1', apiKey: 'private-test-key', model: `quota-test-${++serial}`, style: '稳健', timeoutMs: 40000 })
const response = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"choice":"A0","message":""}' } }] }), { headers: { 'content-type': 'application/json' } })
const decide = (c: LlmProviderConfig) => requestLlmDecision({ config: c, messages: { system: '', user: '' }, candidateIds: ['A0'] })
afterEach(() => vi.unstubAllGlobals())

it('distinguishes exhausted funds/quota from auth, rate limits and generic errors', () => {
  expect(isQuotaExhaustedResponse(403, '{"error":{"message":"Free quota exhausted. To continue"}}')).toBe(true)
  expect(isQuotaExhaustedResponse(429, '{"error":{"code":"insufficient_quota"}}')).toBe(true)
  expect(isQuotaExhaustedResponse(402, '额度已耗尽')).toBe(true)
  for (const [status, body] of [[403,'Access denied'],[401,'invalid key'],[429,'rate limit exceeded'],[429,'requests per minute quota exhausted'],[429,'quota exceeded'],[500,'Free quota exhausted']]) {
    expect(isQuotaExhaustedResponse(Number(status), String(body))).toBe(false)
  }
})

it('one quota response blocks later seats/rounds while different credentials or models work', async () => {
  const c = config(), fetcher = vi.fn().mockResolvedValueOnce(new Response('{"error":{"message":"Free quota exhausted"}}', { status: 403 })).mockImplementation(async () => response())
  vi.stubGlobal('fetch', fetcher)
  await expect(decide(c)).rejects.toMatchObject({ kind: 'quota' })
  for (let i = 0; i < 5; i++) await expect(decide({ ...c, style: '激进' })).rejects.toMatchObject({ kind: 'quota-paused' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(decide({ ...c, apiKey: 'another-key' })).resolves.toMatchObject({ choice: 'A0' })
  await expect(decide({ ...c, model: 'another-model' })).resolves.toMatchObject({ choice: 'A0' })
  expect(quotaStatus(c)).toBe('paused')
})

it('coalesces manual reconnect probes, blocks game traffic during probing and resumes only on success', async () => {
  const c = config(); pauseQuota(c)
  let resolve!: (r: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>(r => { resolve = r }))
  vi.stubGlobal('fetch', fetcher)
  const a = testLlmConnection(c), b = testLlmConnection({ ...c, style: '话痨' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  expect(quotaStatus(c)).toBe('probing')
  await expect(decide(c)).rejects.toMatchObject({ kind: 'quota-paused' })
  resolve(response())
  expect((await a).ok).toBe(true); expect((await b).ok).toBe(true)
  expect(quotaStatus(c)).toBe('available')
  fetcher.mockImplementation(async () => response())
  await expect(decide(c)).resolves.toMatchObject({ choice: 'A0' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('keeps a failed probe paused and does not erase a later in-flight quota failure', async () => {
  const c = config(); pauseQuota(c)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not authorized', { status: 403 })))
  expect((await testLlmConnection(c)).ok).toBe(false)
  expect(quotaStatus(c)).toBe('paused')
  let done!: (r: {ok:boolean;message:string}) => void
  const probe = probeQuotaConnection(c, () => new Promise(r => { done = r }))
  await Promise.resolve(); pauseQuota(c); done({ok:true,message:'ok'})
  expect((await probe).ok).toBe(false)
  expect(quotaStatus(c)).toBe('paused')
})

it('does not pause an ordinary HTTP403 or a truncated model response', async () => {
  const c = config()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'partial'}}]}), {headers:{'content-type':'application/json'}})))
  await expect(decide(c)).rejects.toMatchObject({kind:'http'})
  expect(quotaStatus(c)).toBe('available')
  await expect(decide(c)).rejects.toMatchObject({kind:'length'})
  expect(quotaStatus(c)).toBe('available')
})

it('lets an already in-flight success finish without reopening an exhausted connection', async () => {
  const c = config()
  let complete!: (r: Response) => void
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('Free quota exhausted', { status: 403 }))
    .mockImplementationOnce(() => new Promise<Response>(r => { complete = r })))
  const first = decide(c), second = decide(c)
  await expect(first).rejects.toMatchObject({kind:'quota'})
  complete(response())
  await expect(second).resolves.toMatchObject({choice:'A0'})
  expect(quotaStatus(c)).toBe('paused')
})
