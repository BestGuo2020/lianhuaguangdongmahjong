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
    expect(resolveLocalTtsVoiceKey(preset({
      baseUrl: 'https://proxy.example/v1', avatarFolder: 'gpt',
    }))).toBe('relay_gpt')
    expect(resolveLocalTtsVoiceKey(preset({ ttsVoiceKey: 'default' }))).toBe('default')
  })

  it('本机两分支统一直连 8000 网关，lumigrav 使用生产回退', () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' })
    expect(resolveLocalTtsBaseUrl()).toBe('http://127.0.0.1:8000')
    vi.stubGlobal('location', { hostname: 'room.lumigrav.space' })
    expect(resolveLocalTtsBaseUrl()).toBe('https://lianhuaguangdongmahjong.guoguo-labs.online')
  })

  it('合并相同合成请求，并把每个座位的音频交给共享播放总线', async () => {
    const key = 'a'.repeat(64)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      cacheKey: key,
      audioUrl: `/api/local-tts/audio/${key}.mp3`,
      cached: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const played: Array<{ url: string; seat: number; messageId: number }> = []
    registerLlmAudioPlayer((url, seat, messageId) => played.push({ url, seat, messageId }))
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

  it('无播放器或网关响应非法时静默失败，不阻塞游戏', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ audioUrl: 'https://evil/a.mp3' })))
    const client = new LocalTtsClient('', fetchMock as typeof fetch)
    expect(await client.speak(1, '测试', 'deepseek', '稳健')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    registerLlmAudioPlayer(() => {})
    expect(await client.speak(1, '测试', 'deepseek', '稳健')).toBe(false)
  })
})
