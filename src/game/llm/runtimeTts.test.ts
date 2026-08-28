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
  it('模型把下家的碰误说成杠时，经公开副露事实校验回退', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'deepseek', name: 'DeepSeek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk', model: 'deepseek-v4-flash', style: '稳健', timeoutMs: 8000,
      }],
      activeId: 'deepseek', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
    }, storage)
    mocks.requestLlmDecision.mockResolvedValueOnce({ choice: 'A1', message: '下家杠了，我稳一手。' })
    const bubble = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmMessage: bubble })
    await runtime.controllers![0].requestTurn({
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 1000, 1000, 1000], wallCount: 50,
      peers: [
        { discards: [], melds: [] }, { discards: [], melds: [] },
        { discards: [], melds: [{ type: 'peng', tile: 'm7', tiles: ['m7', 'm7', 'm7'] }] },
        { discards: [], melds: [] },
      ],
    })
    expect(bubble).toHaveBeenCalledWith(1, '这张先走。', expect.any(Object))
  })

  it('深思时只发送状态气泡，并把推理内容留在供应商响应内', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'deepseek', name: 'DeepSeek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk', model: 'deepseek-v4-flash', style: '稳健', timeoutMs: 8000,
      }],
      activeId: 'deepseek', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
    }, storage)
    const status = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmStatus: status })
    await runtime.controllers![0].requestTurn({
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 2000, 3000, 4000], peers: [], wallCount: 12,
    })

    expect(status.mock.calls).toEqual([[1, true], [1, false]])
    expect(mocks.requestLlmDecision).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: true, deadlineMs: 4000,
    }))
    expect(runtime.stats.reasoningRequests).toBe(1)
  })

  it('模型自由台词进入气泡/TTS，真实动作仍由 choice 决定', async () => {
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

    expect(bubble).toHaveBeenCalledWith(1, '这手先稳住。', expect.objectContaining({
      priority: 'normal', decision: 'turn', actionKind: 'discard',
    }))
    expect(mocks.speak).toHaveBeenCalledWith(
      1, '这手先稳住。', 'deepseek', '稳健', 'normal',
      expect.objectContaining({ onStarted: expect.any(Function) }),
    )
  })

  it('连续普通弃牌只展示首条，后续动作照常执行', async () => {
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
    const controller = createLocalLlmControllers({ onLlmMessage: bubble }).controllers![0]
    const context = {
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'] as const,
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    }

    await expect(controller.requestTurn(context as never)).resolves.toEqual(expect.objectContaining({ kind: 'discard' }))
    await expect(controller.requestTurn(context as never)).resolves.toEqual(expect.objectContaining({ kind: 'discard' }))

    expect(mocks.requestLlmDecision).toHaveBeenCalledTimes(2)
    expect(mocks.speak).toHaveBeenCalledTimes(1)
    expect(bubble).toHaveBeenCalledTimes(1)
  })

  it('允许与真实动作不一致的牌桌烟雾弹', async () => {
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
    mocks.requestLlmDecision.mockResolvedValueOnce({ choice: 'A1', message: '这张留着。' })
    const bubble = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmMessage: bubble })

    await runtime.controllers![0].requestTurn({
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    })
    await Promise.resolve()

    expect(bubble).toHaveBeenCalledWith(1, '这张留着。', expect.objectContaining({ priority: 'normal' }))
    expect(mocks.speak).toHaveBeenCalledWith(
      1, '这张留着。', 'deepseek', '稳健', 'normal',
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
