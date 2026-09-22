// Jev 客户端单测：wire 请求形状、回答映射、白名单校验、错误分类与额度语义。
// fetch 全部打桩；不访问真实端点（OpenJev/官方 API 的联调属于部署冒烟，见 scripts/jev-selfplay 文档）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmProviderConfig } from './config'
import { LlmClientError } from './client'
import {
  JEV_MAX_CHOICE_OPTIONS, normalizeSystemOneUrl,
  requestJevDecision, requestSystemOne, testJevConnection,
} from './jevClient'

function jevConfig(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    providerType: 'custom', baseUrl: 'http://127.0.0.1:8000', apiKey: 'test-key',
    model: 'jev-latest', style: '稳健', timeoutMs: 1000, timeoutEnabled: true,
    ...overrides,
  }
}

interface StubResponseInit { ok?: boolean; status?: number; body?: unknown }

function stubResponse(init: StubResponseInit = {}) {
  const ok = init.ok ?? true
  const status = init.status ?? 200
  const body = init.body ?? {}
  return {
    ok, status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

type FetchCall = { url: string; init: RequestInit & { headers: Record<string, string> } }

function stubFetch(produce: (call: FetchCall) => unknown | Promise<unknown>) {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (url: unknown, init: unknown) => {
    const call = { url: String(url), init: init as FetchCall['init'] }
    calls.push(call)
    return produce(call)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

async function captureError(promise: Promise<unknown>): Promise<LlmClientError> {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(LlmClientError)
  return error as LlmClientError
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeSystemOneUrl', () => {
  it('追加 /v1/systemone 并容忍尾斜杠', () => {
    expect(normalizeSystemOneUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/v1/systemone')
    expect(normalizeSystemOneUrl('http://localhost:8000/')).toBe('http://localhost:8000/v1/systemone')
    expect(normalizeSystemOneUrl('https://api.typesafe.ai')).toBe('https://api.typesafe.ai/v1/systemone')
  })
  it('已含 /v1/systemone 时不重复追加', () => {
    expect(normalizeSystemOneUrl('https://api.typesafe.ai/v1/systemone')).toBe('https://api.typesafe.ai/v1/systemone')
    expect(normalizeSystemOneUrl('http://127.0.0.1:8000/v1/systemone/')).toBe('http://127.0.0.1:8000/v1/systemone')
  })
  it('拒绝 userinfo、非本机 http 与非法 URL', () => {
    expect(normalizeSystemOneUrl('http://user:pass@127.0.0.1:8000')).toBeNull()
    expect(normalizeSystemOneUrl('http://example.com')).toBeNull()
    expect(normalizeSystemOneUrl('not a url')).toBeNull()
    expect(normalizeSystemOneUrl('')).toBeNull()
  })
})

describe('requestJevDecision', () => {
  it('构造 /v1/systemone 请求并映射 choice 回答（含附加问题与非法概率过滤）', async () => {
    const { calls } = stubFetch(() => stubResponse({
      body: {
        answers: {
          action: {
            choice: 'c2',
            probabilities: { c1: 0.1, c2: 0.8, c3: 0.1, cX: 'oops' },
            confidence: 0.7,
          },
          push: { noul: 0.93 },
        },
      },
    }))
    const state = { hand: ['m1', 'm2'], wallCount: 50 }
    const result = await requestJevDecision({
      config: jevConfig(),
      state,
      instructions: '打出哪张牌？',
      candidates: [
        { id: 'c1', description: '打 1万' },
        { id: 'c2' },
        { id: 'c3', description: '打 9万' },
      ],
      extras: { push: { type: 'noul', instructions: '这手值得进攻吗？' } },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:8000/v1/systemone')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['Content-Type']).toBe('application/json')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      state,
      model: 'jev-latest',
      questions: {
        action: { type: 'choice', instructions: '打出哪张牌？', criteria: { c1: '打 1万', c2: null, c3: '打 9万' } },
        push: { type: 'noul', instructions: '这手值得进攻吗？' },
      },
    })
    expect(result).toEqual({
      choice: 'c2',
      message: '',
      probabilities: { c1: 0.1, c2: 0.8, c3: 0.1 },
      confidence: 0.7,
      extras: { push: { noul: 0.93 } },
    })
  })

  it('confidence 非法时归为 null；空 apiKey 不发 Authorization 头', async () => {
    const { calls } = stubFetch(() => stubResponse({
      body: { answers: { action: { choice: 'c1', probabilities: { c1: 1 }, confidence: 'high' } } },
    }))
    const result = await requestJevDecision({
      config: jevConfig({ apiKey: '' }),
      state: 'ping',
      instructions: 'q',
      candidates: [{ id: 'c1' }],
    })
    expect(result.confidence).toBeNull()
    expect(calls[0].init.headers.Authorization).toBeUndefined()
  })

  it('choice 不在白名单时抛 parse（不做语义重试）', async () => {
    stubFetch(() => stubResponse({ body: { answers: { action: { choice: 'c9' } } } }))
    const error = await captureError(requestJevDecision({
      config: jevConfig(), state: 's', instructions: 'q',
      candidates: [{ id: 'c1' }, { id: 'c2' }],
    }))
    expect(error.kind).toBe('parse')
    expect(error.message).toContain('不在合法候选列表')
  })

  it('候选构造错误在请求前拦截：空列表 / 超上限 / 重复 ID / 附加问题重名 / score 层级越界', async () => {
    stubFetch(() => stubResponse({ body: { answers: {} } }))
    const base = { config: jevConfig(), state: 's', instructions: 'q' }
    expect((await captureError(requestJevDecision({ ...base, candidates: [] }))).kind).toBe('parse')
    const tooMany = Array.from({ length: JEV_MAX_CHOICE_OPTIONS + 1 }, (_, i) => ({ id: `c${i}` }))
    const overflow = await captureError(requestJevDecision({ ...base, candidates: tooMany }))
    expect(overflow.message).toContain(String(JEV_MAX_CHOICE_OPTIONS))
    expect((await captureError(requestJevDecision({ ...base, candidates: [{ id: 'c1' }, { id: 'c1' }] }))).message).toContain('重复')
    expect((await captureError(requestJevDecision({
      ...base, candidates: [{ id: 'c1' }], extras: { action: { type: 'noul', instructions: 'x' } },
    }))).message).toContain('重名')
    expect((await captureError(requestJevDecision({
      ...base, candidates: [{ id: 'c1' }],
      extras: { danger: { type: 'score', instructions: 'x', criteria: ['a'] } },
    }))).message).toContain('2–10')
  })

  it('缺失主问题回答 / answers 非对象时抛 parse', async () => {
    stubFetch(() => stubResponse({ body: { answers: { other: { noul: 0.5 } } } }))
    const error = await captureError(requestJevDecision({
      config: jevConfig(), state: 's', instructions: 'q', candidates: [{ id: 'c1' }],
    }))
    expect(error.kind).toBe('parse')
    expect(error.message).toContain('action')
  })

  it('HTTP 500 归为 http；网络异常归为 network', async () => {
    stubFetch(() => stubResponse({ ok: false, status: 500, body: 'boom' }))
    const http = await captureError(requestSystemOne({
      config: jevConfig(), request: { state: 's', model: 'm', questions: {} },
    }))
    expect(http.kind).toBe('http')
    expect(http.message).toContain('HTTP 500')

    stubFetch(() => { throw new TypeError('fetch failed') })
    const network = await captureError(requestSystemOne({
      config: jevConfig({ baseUrl: 'http://127.0.0.1:8002' }),
      request: { state: 's', model: 'm', questions: {} },
    }))
    expect(network.kind).toBe('network')
  })

  it('超时归为 timeout（外部 signal 同样生效）', async () => {
    stubFetch((_call) => new Promise((_, reject) => {
      // init.signal 由客户端管理；这里从最近一次调用取
      const signal = (vi.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit).signal!
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const timeout = await captureError(requestSystemOne({
      config: jevConfig({ baseUrl: 'http://127.0.0.1:8003', timeoutMs: 20 }),
      request: { state: 's', model: 'm', questions: {} },
    }))
    expect(timeout.kind).toBe('timeout')

    stubFetch((_call) => new Promise((_, reject) => {
      const signal = (vi.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit).signal!
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const controller = new AbortController()
    const pending = requestSystemOne({
      config: jevConfig({ baseUrl: 'http://127.0.0.1:8004', timeoutEnabled: false }),
      request: { state: 's', model: 'm', questions: {} },
      signal: controller.signal,
    })
    controller.abort()
    const aborted = await captureError(pending)
    expect(aborted.kind).toBe('timeout')
  })

  it('402 明确额度耗尽：归为 quota 并暂停连接，后续请求直接被 quota-paused 拦截', async () => {
    const config = jevConfig({ baseUrl: 'http://127.0.0.1:8101' })
    stubFetch(() => stubResponse({
      ok: false, status: 402,
      body: { error: { code: 'insufficient_quota', message: 'Quota exhausted' } },
    }))
    const quota = await captureError(requestSystemOne({
      config, request: { state: 's', model: 'm', questions: {} },
    }))
    expect(quota.kind).toBe('quota')
    // 暂停后不再发出请求（fetch 桩不会再被调用）
    const callsBefore = vi.mocked(fetch).mock.calls.length
    const paused = await captureError(requestSystemOne({
      config, request: { state: 's', model: 'm', questions: {} },
    }))
    expect(paused.kind).toBe('quota-paused')
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore)
  })

  it('429 限速文案不误判为额度耗尽（保持 http）', async () => {
    stubFetch(() => stubResponse({
      ok: false, status: 429,
      body: { error: { message: 'Rate limit exceeded: requests per minute' } },
    }))
    const error = await captureError(requestSystemOne({
      config: jevConfig({ baseUrl: 'http://127.0.0.1:8102' }),
      request: { state: 's', model: 'm', questions: {} },
    }))
    expect(error.kind).toBe('http')
  })
})

describe('testJevConnection', () => {
  it('端点可用时返回成功', async () => {
    stubFetch(() => stubResponse({ body: { answers: { ping: { noul: 0.5 } } } }))
    const result = await testJevConnection(jevConfig({ baseUrl: 'http://127.0.0.1:8103' }))
    expect(result).toEqual({ ok: true, message: '连接成功' })
  })

  it('端点报错时返回失败原因', async () => {
    stubFetch(() => stubResponse({ ok: false, status: 500, body: 'down' }))
    const result = await testJevConnection(jevConfig({ baseUrl: 'http://127.0.0.1:8104' }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('HTTP 500')
  })

  it('额度暂停期间探测仍会发出请求（quotaProbe 绕过预检），成功后解除暂停', async () => {
    const config = jevConfig({ baseUrl: 'http://127.0.0.1:8105' })
    stubFetch(() => stubResponse({
      ok: false, status: 402,
      body: { error: { code: 'insufficient_quota', message: 'Quota exhausted' } },
    }))
    expect((await captureError(requestSystemOne({
      config, request: { state: 's', model: 'm', questions: {} },
    }))).kind).toBe('quota')
    // 换成可用端点：探测必须真实发出（否则会被 'probing'/'paused' 预检拦住），成功即恢复
    stubFetch(() => stubResponse({ body: { answers: { ping: { noul: 0.5 } } } }))
    const result = await testJevConnection(config)
    expect(result).toEqual({ ok: true, message: '连接成功' })
  })
})
