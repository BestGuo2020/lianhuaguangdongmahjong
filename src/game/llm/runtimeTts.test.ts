import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  speak: vi.fn(async (...args: any[]) => {
    args[5]?.onStarted?.()
    return true
  }),
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
  it('忽略模型自由台词，按最终动作生成一致台词并进入气泡/TTS', async () => {
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

    expect(bubble).toHaveBeenCalledWith(1, '这张先走。', expect.objectContaining({
      priority: 'normal', decision: 'turn', actionKind: 'discard',
    }))
    expect(mocks.speak).toHaveBeenCalledWith(
      1, '这张先走。', 'deepseek', '稳健', 'normal',
      expect.objectContaining({ onStarted: expect.any(Function) }),
    )
  })

  it('矛盾或幕后模型台词不会进入展示链路', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'deepseek', name: 'DeepSeek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk', model: 'deepseek-v4-flash', style: '稳健', timeoutMs: 8000,
        ttsVoiceKey: 'deepseek',
      }],
      activeId: 'deepseek', seatIds: [null, null, null, null],
      seatStyles: [null, null, null, null],
    }, storage)
    mocks.requestLlmDecision.mockResolvedValueOnce({ choice: 'A1', message: '这张留着，听引擎的？' })
    const bubble = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmMessage: bubble })

    await runtime.controllers![0].requestTurn({
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    })
    await Promise.resolve()

    expect(bubble).toHaveBeenCalledWith(1, '这张先走。', expect.objectContaining({ priority: 'normal' }))
    expect(mocks.speak).toHaveBeenCalledWith(
      1, '这张先走。', 'deepseek', '稳健', 'normal',
      expect.objectContaining({ onStarted: expect.any(Function) }),
    )
  })

  it('静音或 TTS 失败时仍显示气泡并放行动作', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk', model: 'deepseek-v4-flash', style: '稳健', timeoutMs: 8000,
      }],
      activeId: 'deepseek', seatIds: [null, null, null, null],
      seatStyles: [null, null, null, null],
    }, storage)
    mocks.speak.mockResolvedValueOnce(false)
    const bubble = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmMessage: bubble })

    await expect(runtime.controllers![0].requestTurn({
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    })).resolves.toEqual(expect.objectContaining({ kind: 'discard' }))
    expect(bubble).toHaveBeenCalledOnce()
  })

  it('有声时等 playing 才显示气泡，并等播放中点才返回动作', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk', model: 'deepseek-v4-flash', style: '稳健', timeoutMs: 8000,
      }],
      activeId: 'deepseek', seatIds: [null, null, null, null],
      seatStyles: [null, null, null, null],
    }, storage)
    let startPlayback!: () => void
    let reachMidpoint!: () => void
    mocks.speak.mockImplementationOnce((...args: any[]) => {
      startPlayback = () => args[5]?.onStarted?.()
      return new Promise<boolean>((resolve) => { reachMidpoint = () => resolve(true) })
    })
    const bubble = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmMessage: bubble })
    let actionResolved = false
    const action = runtime.controllers![0].requestTurn({
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    }).then((value) => { actionResolved = true; return value })

    await vi.waitFor(() => expect(mocks.speak).toHaveBeenCalled())
    expect(bubble).not.toHaveBeenCalled()
    expect(actionResolved).toBe(false)
    startPlayback()
    expect(bubble).toHaveBeenCalledOnce()
    expect(actionResolved).toBe(false)
    reachMidpoint()
    await expect(action).resolves.toEqual(expect.objectContaining({ kind: 'discard' }))
  })
})
