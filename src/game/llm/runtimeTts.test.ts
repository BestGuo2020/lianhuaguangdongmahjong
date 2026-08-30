import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  speak: vi.fn(async (...args: any[]) => {
    args[5]?.onStarted?.()
    return true
  }),
  requestLlmDecision: vi.fn(async (_options?: any) => ({ choice: 'A1', message: '这手先稳住。' })),
}))

vi.mock('./localTtsClient', () => ({
  getLocalTtsClient: () => ({ speak: mocks.speak }),
  resolveLocalTtsVoiceKey: () => 'deepseek',
}))
vi.mock('./client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./client')>(),
  requestLlmDecision: mocks.requestLlmDecision,
}))

import { announceLocalLlmRoundReactions, resetLocalLlmVoiceRegistryForTests } from '../core/presentation/localLlmVoiceRegistry'
import { saveLlmSettings } from './config'
import {
  createLocalLlmControllers,
  createLotusLlmControllers,
  shouldSuppressLlmAnimeDynamicSpeech,
} from './runtime'

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

function configureDeepseekRuntime(storage: Storage, style: '稳健' | '话痨' = '稳健') {
  vi.stubGlobal('localStorage', storage)
  saveLlmSettings({
    enabled: true,
    presets: [{
      id: 'deepseek', name: 'DeepSeek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk', model: 'deepseek-v4-flash', style, timeoutMs: 8000, ttsVoiceKey: 'deepseek',
    }],
    activeId: 'deepseek', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
  }, storage)
}

const DISCARD_CONTEXT = {
  hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'] as const,
  melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
  playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
}

const PENG_CONTEXT = {
  hand: ['m1', 'm1', 'm2', 'm3', 'p4', 'p5', 's2', 's4', 'east', 'south', 'west', 'green', 'white'] as const,
  canPeng: true, canGang: false, tile: 'm1' as const, from: 0, exposedMelds: 0,
  playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  resetLocalLlmVoiceRegistryForTests()
})

describe('单机 LLM runtime TTS', () => {
  it.each([
    'gang', 'peng', 'chi', 'added-kong', 'concealed-kong', 'wind-kong', 'win',
  ] as const)('llmAnime 按 actionKind=%s 屏蔽模型动作台词', (actionKind) => {
    expect(shouldSuppressLlmAnimeDynamicSpeech('llmAnime', {
      priority: 'important', source: 'decision', actionKind,
    })).toBe(true)
  })

  it('llmAnime 精确保留普通 commentary 与思考之外的非固定动作', () => {
    expect(shouldSuppressLlmAnimeDynamicSpeech('llmAnime', {
      priority: 'normal', source: 'decision', actionKind: 'discard',
    })).toBe(false)
    expect(shouldSuppressLlmAnimeDynamicSpeech('llmAnime', {
      priority: 'normal', source: 'decision', actionKind: 'pass',
    })).toBe(false)
    expect(shouldSuppressLlmAnimeDynamicSpeech('llmAnime', undefined)).toBe(false)
  })

  it('llmAnime 对 source=win 的赛后语音一律拦截，其他主题保持原行为', () => {
    const meta = { priority: 'important', source: 'win' } as const
    expect(shouldSuppressLlmAnimeDynamicSpeech('llmAnime', meta)).toBe(true)
    expect(shouldSuppressLlmAnimeDynamicSpeech('llm', meta)).toBe(false)
    expect(shouldSuppressLlmAnimeDynamicSpeech('jade', meta)).toBe(false)
    expect(shouldSuppressLlmAnimeDynamicSpeech(undefined, meta)).toBe(false)
  })

  it('动态主题 getter 在同一控制器生命周期内即时切换动作台词路由', async () => {
    configureDeepseekRuntime(memoryStorage())
    mocks.requestLlmDecision.mockResolvedValue({ choice: 'P', message: '这张我碰了。' })
    let themeName = 'llmAnime'
    const bubble = vi.fn()
    const controller = createLocalLlmControllers(
      { onLlmMessage: bubble },
      { getThemeName: () => themeName },
    ).controllers![0]

    await expect(controller.requestClaim(PENG_CONTEXT as never)).resolves.toEqual({ kind: 'peng' })
    expect(mocks.speak).not.toHaveBeenCalled()
    expect(bubble).not.toHaveBeenCalled()

    themeName = 'jade'
    await expect(controller.requestClaim(PENG_CONTEXT as never)).resolves.toEqual({ kind: 'peng' })
    expect(mocks.speak).toHaveBeenCalledOnce()
    expect(bubble).toHaveBeenCalledWith(1, '这张我碰了。', expect.objectContaining({
      source: 'decision', decision: 'claim', actionKind: 'peng',
    }))
  })

  it('llmAnime 保留普通出牌 commentary', async () => {
    configureDeepseekRuntime(memoryStorage())
    mocks.requestLlmDecision.mockResolvedValue({ choice: 'A1', message: '这手先稳住。' })
    const bubble = vi.fn()
    const controller = createLocalLlmControllers(
      { onLlmMessage: bubble },
      { getThemeName: () => 'llmAnime' },
    ).controllers![0]

    await expect(controller.requestTurn(DISCARD_CONTEXT as never)).resolves.toEqual(expect.objectContaining({ kind: 'discard' }))
    expect(mocks.speak).toHaveBeenCalledWith(
      1, '这手先稳住。', 'deepseek', '稳健', 'normal',
      expect.objectContaining({ onStarted: expect.any(Function) }),
    )
    expect(bubble).toHaveBeenCalledWith(1, '这手先稳住。', expect.objectContaining({ actionKind: 'discard' }))
  })

  it('llmAnime 保留思考安全状态及其开场 TTS', async () => {
    configureDeepseekRuntime(memoryStorage())
    mocks.requestLlmDecision.mockImplementationOnce(async (options: any) => {
      options.onReasoningProgress?.()
      return { choice: 'A1', message: '这手先稳住。' }
    })
    const status = vi.fn()
    const controller = createLocalLlmControllers(
      { onLlmStatus: status },
      { getThemeName: () => 'llmAnime' },
    ).controllers![0]

    await controller.requestTurn({ ...DISCARD_CONTEXT, turnOrigin: 'draw', wallCount: 12 } as never)
    expect(status).toHaveBeenCalledWith(1, true, '让我想想怎么打。')
    expect(status).toHaveBeenCalledWith(1, true, '思考中 · 正在观察公开牌局')
    expect(mocks.speak).toHaveBeenCalledWith(
      1, '让我想想怎么打。', 'deepseek', '稳健', 'normal',
    )
  })

  it.each(['core', 'lotus'] as const)('llmAnime 屏蔽 %s runtime 注册的 source=win 赛后语音', async (variant) => {
    configureDeepseekRuntime(memoryStorage())
    const bubble = vi.fn()
    const create = variant === 'core' ? createLocalLlmControllers : createLotusLlmControllers
    create(
      { onLlmMessage: bubble },
      { getThemeName: () => 'llmAnime' },
    )

    await announceLocalLlmRoundReactions({ winnerIndex: 1, winType: 'self-draw' })
    expect(mocks.speak).not.toHaveBeenCalled()
    expect(bubble).not.toHaveBeenCalled()
  })

  it('始终思考模型普通局面低强度调用，统一触发后升级并分别统计', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'kimi-k3', name: 'Kimi K3', providerType: 'kimi', baseUrl: 'https://api.orcarouter.ai/v1',
        apiKey: 'sk', model: 'kimi/kimi-k3', style: '稳健', timeoutMs: 40_000, timeoutEnabled: true,
      }],
      activeId: 'kimi-k3', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
    }, storage)
    const status = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmStatus: status })
    const controller = runtime.controllers![0]
    const context = {
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'] as const,
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 2000, 3000, 4000], peers: [], wallCount: 50,
    }

    mocks.requestLlmDecision.mockImplementationOnce(async (options: any) => {
      options.onReasoningProgress?.()
      return { choice: 'A1', message: '这手先稳住。' }
    })
    await controller.requestTurn({ ...context, turnOrigin: 'opening' } as never)
    expect(mocks.requestLlmDecision).toHaveBeenNthCalledWith(1, expect.objectContaining({
      reasoning: false, deadlineMs: undefined,
    }))
    expect(runtime.stats.thinkingRequests).toBe(1)
    expect(runtime.stats.reasoningRequests).toBe(0)
    expect(runtime.stats.enhancedReasoningRequests).toBe(0)
    expect(status).not.toHaveBeenCalledWith(1, true, '让我想想怎么打。')
    expect(status).toHaveBeenCalledWith(1, true, '思考中 · 正在观察公开牌局')

    await controller.requestTurn({ ...context, turnOrigin: 'draw', wallCount: 12 } as never)
    expect(mocks.requestLlmDecision).toHaveBeenNthCalledWith(2, expect.objectContaining({
      reasoning: true, deadlineMs: 40_000,
    }))
    expect(runtime.stats.thinkingRequests).toBe(2)
    expect(runtime.stats.reasoningRequests).toBe(1)
    expect(runtime.stats.enhancedReasoningRequests).toBe(1)
    expect(status).toHaveBeenCalledWith(1, true, '让我想想怎么打。')
  })

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

  it('深思时只流式展示安全进度，原始推理不会进入气泡或 TTS', async () => {
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
    mocks.requestLlmDecision.mockImplementationOnce(async (...args: any[]) => {
      const options = args[0] as { onReasoningProgress?: () => void }
      options.onReasoningProgress?.()
      options.onReasoningProgress?.()
      return { choice: 'A1', message: '这手先稳住。' }
    })
    const status = vi.fn()
    const runtime = createLocalLlmControllers({ onLlmStatus: status })
    await runtime.controllers![0].requestTurn({
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 2000, 3000, 4000], peers: [], wallCount: 12,
    })

    expect(status.mock.calls).toEqual([
      [1, true, '让我想想怎么打。'],
      [1, true, '思考中 · 正在观察公开牌局'],
      [1, true, '思考中 · 正在整理规则约束'],
      [1, false],
    ])
    expect(JSON.stringify(status.mock.calls)).not.toMatch(/一万|白板|m1|候选编号/)
    expect(mocks.requestLlmDecision).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: true, deadlineMs: 40_000,
    }))
    expect(mocks.speak).toHaveBeenCalledWith(
      1, '让我想想怎么打。', 'deepseek', '稳健', 'normal',
    )
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

  it('话痨连续摸打每次都展示并播放台词', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk', model: 'deepseek-v4-flash', style: '话痨', timeoutMs: 8000,
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

    await controller.requestTurn(context as never)
    await controller.requestTurn(context as never)
    await controller.requestTurn(context as never)

    expect(mocks.requestLlmDecision).toHaveBeenCalledTimes(3)
    expect(mocks.speak).toHaveBeenCalledTimes(3)
    expect(bubble).toHaveBeenCalledTimes(3)
  })

  it('引擎回退显示问号气泡、服从普通频率且不走 TTS', async () => {
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
    mocks.requestLlmDecision.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom'))
    const bubble = vi.fn()
    const controller = createLocalLlmControllers({ onLlmMessage: bubble }).controllers![0]
    const context = {
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'] as const,
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    }

    await controller.requestTurn(context as never)
    await controller.requestTurn(context as never)

    expect(bubble).toHaveBeenCalledTimes(1)
    expect(bubble).toHaveBeenCalledWith(1, '？', expect.objectContaining({
      source: 'fallback', decision: 'turn', actionKind: 'discard', priority: 'normal',
    }))
    expect(mocks.speak).not.toHaveBeenCalled()
  })

  it('话痨摸打连续回退时每次显示问号，但仍不走 TTS', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true,
      presets: [{
        id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk', model: 'deepseek-v4-flash', style: '话痨', timeoutMs: 8000,
      }],
      activeId: 'deepseek', seatIds: [null, null, null, null],
      seatStyles: [null, null, null, null],
    }, storage)
    mocks.requestLlmDecision.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom'))
    const bubble = vi.fn()
    const controller = createLocalLlmControllers({ onLlmMessage: bubble }).controllers![0]
    const context = {
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'] as const,
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 1, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    }

    await controller.requestTurn(context as never)
    await controller.requestTurn(context as never)

    expect(bubble).toHaveBeenCalledTimes(2)
    expect(bubble.mock.calls.every((call) => call[1] === '？')).toBe(true)
    expect(mocks.speak).not.toHaveBeenCalled()
  })

  it('点名已选弃牌并说留着时回退动作一致台词', async () => {
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
    mocks.requestLlmDecision.mockResolvedValueOnce({ choice: 'A1', message: '1万留着当宝，先走它！' })
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
