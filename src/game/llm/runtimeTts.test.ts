import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  speak: vi.fn(async () => true),
  requestLlmDecision: vi.fn(async () => ({ choice: 'A1', message: '这手先稳住。' })),
}))

vi.mock('./localTtsClient', () => ({
  getLocalTtsClient: () => ({ speak: mocks.speak }),
  resolveLocalTtsVoiceKey: () => 'deepseek',
}))
vi.mock('./client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./client')>(),
  requestLlmDecision: mocks.requestLlmDecision,
}))

import { resetLocalLlmVoiceRegistryForTests } from '../core/presentation/localLlmVoiceRegistry'
import { saveLlmSettings } from './config'
import { createLocalLlmControllers } from './runtime'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size }, clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key) },
    setItem: (key, value) => { data.set(key, value) },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  resetLocalLlmVoiceRegistryForTests()
})

describe('单机 LLM runtime TTS', () => {
  it('同一条模型吐槽同时进入气泡回调和独立 TTS 客户端', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk', model: 'deepseek-v4-flash', style: '稳健', timeoutMs: 8000,
        ttsVoiceKey: 'deepseek',
      }],
      activeId: 'deepseek', seatIds: [null, null, null, null],
      seatStyles: [null, null, null, null],
    }, storage)
    const bubble = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmMessage: bubble })

    await runtime.controllers![0].requestTurn({
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1,
      scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    })
    await Promise.resolve()

    expect(bubble).toHaveBeenCalledWith(1, '这手先稳住。')
    expect(mocks.speak).toHaveBeenCalledWith(1, '这手先稳住。', 'deepseek', '稳健')
  })
})
