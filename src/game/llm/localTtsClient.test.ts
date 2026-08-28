import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerLlmAudioPlayer, resetLlmAudioBusForTests } from '../core/presentation/llmAudioBus'
import type { LlmProviderPreset } from './config'
import { LocalTtsClient, resolveLocalTtsBaseUrl, resolveLocalTtsVoiceKey } from './localTtsClient'

function preset(overrides: Partial<LlmProviderPreset> = {}): LlmProviderPreset {
  return {
    id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk', model: 'deepseek-v4-flash', style: '稳健', timeoutMs: 8000,
    ...overrides,
  }
}

afterEach(() => {
  resetLlmAudioBusForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('LocalTtsClient', () => {
  it('按模型自动映射网关白名单音色，也允许预置显式覆盖', () => {
    expect(resolveLocalTtsVoiceKey(preset())).toBe('deepseek')
    const mappings = [
      ['qwen', 'qwen3.7-plus'], ['kimi', 'kimi-k2.6'], ['doubao', 'doubao-1.5-pro'],
      ['minimax', 'MiniMax-Text-01'], ['openai', 'gpt-5.6-luna'],
      ['glm', 'z-ai/glm-5.3-flash'], ['claude', 'claude-sonnet-4-20250514'],
    ] as const
    mappings.forEach(([providerType, model]) => {
      expect(resolveLocalTtsVoiceKey(preset({
        providerType, baseUrl: 'https://proxy.example/v1', model,
      }))).toBe(providerType === 'openai' ? 'gpt' : providerType)
    })
    expect(resolveLocalTtsVoiceKey(preset({
      providerType: 'custom', baseUrl: 'https://proxy.example/v1', model: 'z-ai/glm-5.3-flash',
    }))).toBe('glm')
    expect(resolveLocalTtsVoiceKey(preset({
      providerType: 'custom', baseUrl: 'https://proxy.example/v1', model: 'anthropic/claude-sonnet-4',
    }))).toBe('claude')
    expect(resolveLocalTtsVoiceKey(preset({
      providerType: 'custom', baseUrl: 'https://proxy.example/v1', model: 'mystery', avatarFolder: 'claude',
    }))).toBe('claude')
    expect(resolveLocalTtsVoiceKey(preset({ ttsVoiceKey: 'relay_gpt' }))).toBe('relay_gpt')
    expect(resolveLocalTtsVoiceKey(preset({ ttsVoiceKey: 'default' }))).toBe('default')
  })

  it('本机两分支统一走同源代理，lumigrav 使用生产回退', () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' })
    expect(resolveLocalTtsBaseUrl()).toBe('')
    vi.stubGlobal('location', { hostname: 'room.lumigrav.space' })
    expect(resolveLocalTtsBaseUrl()).toBe('https://www.bestguo.top:58000')
  })

  it('合并相同合成请求，并把每个座位的音频交给共享播放总线', async () => {
    const key = 'a'.repeat(64)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      cacheKey: key,
      audioUrl: `/api/local-tts/audio/${key}.mp3`,
      cached: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const played: Array<{ url: string; seat: number; messageId: number }> = []
    registerLlmAudioPlayer((url, seat, messageId) => { played.push({ url, seat, messageId }) })
    const client = new LocalTtsClient('https://tts.example.com', fetchMock as typeof fetch)

    const result = await Promise.all([
      client.speak(1, '  稳住，先打这张。 ', 'deepseek', '稳健'),
      client.speak(2, '稳住，先打这张。', 'deepseek', '稳健'),
    ])

    expect(result).toEqual([true, true])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requestInit = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      text: '稳住,先打这张。', voiceKey: 'deepseek', style: '稳健',
    })
    expect(played).toEqual([
      { url: `https://tts.example.com/api/local-tts/audio/${key}.mp3`, seat: 1, messageId: 1 },
      { url: `https://tts.example.com/api/local-tts/audio/${key}.mp3`, seat: 2, messageId: 2 },
    ])
  })

  it('以 Window/globalThis 作为 this 调用原生风格 fetch', async () => {
    const key = 'b'.repeat(64)
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify({
        cacheKey: key,
        audioUrl: `/api/local-tts/audio/${key}.mp3`,
        cached: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })
    registerLlmAudioPlayer(() => {})
    const client = new LocalTtsClient('', fetchMock as typeof fetch)

    await expect(client.speak(1, '绑定测试', 'deepseek', '稳健')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('播放器未注册或静音时不请求 TTS 网关', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ audioUrl: '/api/local-tts/audio/invalid.mp3' })))
    const client = new LocalTtsClient('', fetchMock as typeof fetch)

    expect(await client.speak(1, '测试', 'deepseek', '稳健')).toBe(false)
    registerLlmAudioPlayer(() => {}, () => false)
    expect(await client.speak(1, '测试', 'deepseek', '稳健')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('播放器可用但网关响应非法时静默失败', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ audioUrl: 'https://evil/a.mp3' })))
    const client = new LocalTtsClient('', fetchMock as typeof fetch)

    registerLlmAudioPlayer(() => {})
    expect(await client.speak(1, '测试', 'deepseek', '稳健')).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
