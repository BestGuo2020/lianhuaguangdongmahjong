// LLM 层单元测试（无网络）：解析器 / 客户端重试语义 / 候选与特征 / 合法性复核 / prompt / 配置。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, isReactive } from 'vue'
import { extractJsonObject, parseLlmOutput, cleanMessage, requestLlmDecision, testLlmConnection } from './client'
import { buildDecisionRequest } from './candidates'
import { isActionLegal } from './llmController'
import { buildPrompt } from './prompt'
import { normalizeBaseUrl, readLlmSettings, saveLlmSettings, presetForSeat, styleForSeat, type LlmSettings } from './config'
import { avatarFor, avatarFolderFor, defaultNicknameFor, displayNameOf, effectiveNickname } from './persona'
import { createLocalLlmControllers, createLotusLlmControllers } from './runtime'
import type { DecisionInput } from './candidates'
import type { LlmProviderConfig } from './config'

const config: LlmProviderConfig = {
  baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-chat', style: '稳健', timeoutMs: 8000,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('extractJsonObject：平衡括号扫描', () => {
  it('提取 JSON 对象并跳过字符串字面量内的大括号', () => {
    const text = '好的，先给你结果 {"choice":"A1","message":"大{括}号{测试}"} 完毕'
    expect(extractJsonObject(text)).toBe('{"choice":"A1","message":"大{括}号{测试}"}')
  })

  it('跳过转义引号与转义反斜杠', () => {
    const text = '{"message":"他说：\\"{囧}\\""} 尾注'
    const extracted = extractJsonObject(text)
    expect(extracted).not.toBeNull()
    expect(JSON.parse(extracted as string).message).toBe('他说："{囧}"')
  })

  it('文本中无 { 返回 null', () => {
    expect(extractJsonObject('没有对象')).toBeNull()
  })
})

describe('parseLlmOutput', () => {
  it('接受合法 choice 与 message；message 缺失视为空', () => {
    expect(parseLlmOutput('{"choice":"A1","message":"哈哈哈"}', ['A1', 'A2'])).toEqual({ choice: 'A1', message: '哈哈哈' })
    expect(parseLlmOutput('{"choice":"A2"}', ['A1', 'A2'])).toEqual({ choice: 'A2', message: '' })
  })

  it('剥离代码块围栏后解析', () => {
    expect(parseLlmOutput('```json\n{"choice":"A1","message":""}\n```', ['A1']).choice).toBe('A1')
  })

  it('choice 不在白名单抛 parse 错误（触发语义重试的判定依据）', () => {
    expect(() => parseLlmOutput('{"choice":"A9"}', ['A1', 'A2'])).toThrow(/不在合法候选列表/)
  })

  it('message 按 Unicode code point 截断 30 字并移除控制字符', () => {
    const long = 'あ'.repeat(40)
    expect(cleanMessage(`x\u0007${long}`)).toBe('x' + 'あ'.repeat(29))
  })
})

describe('requestLlmDecision：重试语义', () => {
  it('解析失败 → 一次语义重试 → 成功；fetch 调用 2 次', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '不是JSON' }, finish_reason: 'stop' }] }) }
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"choice":"A2","message":"好了"}' }, finish_reason: 'stop' }] }) }
    }) as never)
    const output = await requestLlmDecision({ config, messages: { system: 's', user: 'u' }, candidateIds: ['A1', 'A2'] })
    expect(output.choice).toBe('A2')
    expect(calls).toBe(2)
  })

  it('HTTP 非 2xx 直接抛 http 错误，不触发语义重试', async () => {
    const spy = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }))
    vi.stubGlobal('fetch', spy as never)
    await expect(requestLlmDecision({ config, messages: { system: 's', user: 'u' }, candidateIds: ['A1'] }))
      .rejects.toMatchObject({ kind: 'http' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('finish_reason=length 视为解析失败并重试一次', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"choice":"A1"' }, finish_reason: 'length' }] }) }
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"choice":"A1","message":""}' }, finish_reason: 'stop' }] }) }
    }) as never)
    const output = await requestLlmDecision({ config, messages: { system: 's', user: 'u' }, candidateIds: ['A1'] })
    expect(output.choice).toBe('A1')
    expect(calls).toBe(2)
  })
})

function baseInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    ruleCode: 'lotus-classic',
    decision: 'turn',
    playerIndex: 0,
    hand: ['m3', 'm3', 'm5'],
    melds: [],
    exposedMelds: 0,
    skipDraw: false,
    scores: [1000, 1000, 1000, 1000],
    peers: [
      { discards: ['p1'], melds: [] },
      { discards: ['m9'], melds: [] },
      { discards: [], melds: [] },
      { discards: ['east'], melds: [] },
    ],
    visibleTiles: ['m3', 'm3', 'm5', 'p1', 'm9', 'east'],
    publicTiles: ['p1', 'm9', 'east'],
    upperLastDiscard: 'm9',
    wallCount: 40,
    requestId: 'turn-0-1',
    stateVersion: '1:thinking:40:13:0:6',
    jokerTiles: ['white'],
    wildcardTiles: [],
    seatWind: '东', roundWind: '东', dealerIndex: 0, roundIndex: 1,
    ...overrides,
  }
}

describe('buildDecisionRequest：候选枚举与特征', () => {
  it('出牌按牌面去重：3万 3万 5万 → 2 个候选', () => {
    const built = buildDecisionRequest(baseInput())
    expect(built.request?.candidates.filter((c) => c.action.kind === 'discard').map((c) => c.label))
      .toEqual(['出3万', '出5万'])
  })

  it('有碰副露且手牌含同牌时出补杠候选；杠候选含收益档位', () => {
    const input = baseInput({
      hand: ['s5', 's5', 's5'],
      melds: [{ type: 'peng', tile: 's5', tiles: ['s5', 's5', 's5'] }],
    })
    const built = buildDecisionRequest(input)
    const added = built.request?.candidates.find((c) => c.action.kind === 'added-kong')
    expect(added?.label).toBe('补杠5条')
    expect(added?.features.scoreDeltaBand).toBeDefined()
  })

  it('claim：只有 canPeng/canGang 时生成 过/杠/碰 候选', () => {
    const input = baseInput({
      decision: 'claim', hand: ['m3', 'm3', 'm5'], tile: 'm3', from: 1, canPeng: true, canGang: true,
    })
    const built = buildDecisionRequest(input)
    expect(built.request?.candidates.map((c) => c.id)).toEqual(['Z', 'G', 'P'])
    expect(built.request?.candidates.find((c) => c.id === 'G')?.features.scoreDeltaBand).toBeDefined()
  })

  it('skipDraw=true：只允许出牌（无杠候选）', () => {
    const input = baseInput({ skipDraw: true, hand: ['m3', 'm3', 'm3', 'm3'], melds: [] })
    const built = buildDecisionRequest(input)
    expect(built.request?.candidates.every((c) => c.action.kind === 'discard')).toBe(true)
  })

  it('莲花：有东南西北时出乱风杠候选；suggestion 存在', () => {
    const input = baseInput({
      ruleCode: 'lotus-legacy', hand: ['east', 'south', 'west', 'north', 'm3', 'm3', 'm5'],
      jokerTiles: ['m5', 'm6'], wildcardTiles: ['white'],
    })
    const built = buildDecisionRequest(input)
    expect(built.request?.candidates.some((c) => c.action.kind === 'wind-kong')).toBe(true)
    expect(built.request?.engineSuggestion).toBeTruthy()
  })

  it('候选特征回填：听口明细 + 剩余张数（含自己手牌的可见计数）', () => {
    // 14 张手牌，打出 s2 后单骑听 2条（自己手牌仍有 2 张 s2 → 剩余 2）
    const hand = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 's1', 's1', 's1', 's2', 's2'] as never
    const built = buildDecisionRequest(baseInput({ hand, visibleTiles: hand }))
    const discard = built.request?.candidates.find((c) => c.action.kind === 'discard' && c.label === '出2条')
    expect(discard?.features.ready).toBe(true)
    expect(discard?.features.waits).toEqual(expect.arrayContaining([{ tile: '2条', remaining: 2 }]))
  })
})

describe('isActionLegal：动作合法性复核（§8.2 表）', () => {
  it('discard 越界拒绝、界内通过', () => {
    const input = baseInput()
    expect(isActionLegal(input, { kind: 'discard', handIndex: 0 })).toBe(true)
    expect(isActionLegal(input, { kind: 'discard', handIndex: 3 })).toBe(false)
  })

  it('win 永远拒绝（只能引擎短路产生）', () => {
    expect(isActionLegal(baseInput(), { kind: 'win' })).toBe(false)
  })

  it('chi optionIndex 越界拒绝', () => {
    const input = baseInput({
      ruleCode: 'lotus-legacy', decision: 'claim', tile: 'm3', from: 1,
      chiOptions: [{ kind: 'sequence', tiles: ['m1', 'm2', 'm3'] }],
      exposedMelds: 0,
    })
    expect(isActionLegal(input, { kind: 'chi', optionIndex: 0 })).toBe(true)
    expect(isActionLegal(input, { kind: 'chi', optionIndex: 1 })).toBe(false)
  })
})

describe('prompt 构建', () => {
  it('包含候选编号、引擎建议与输出 JSON 约束', () => {
    const built = buildDecisionRequest(baseInput())
    const prompt = buildPrompt('稳健', built.request!)
    expect(prompt.system).toContain('牌友')
    expect(prompt.user).toContain('【候选动作】')
    expect(prompt.user).toContain('A1')
    expect(prompt.user).toContain('{"choice": "A1"')
    expect(prompt.user).toContain('引擎建议')
    expect(prompt.user).toContain('【你的牌】')
  })

  it('莲花规则摘要与广麻不同', () => {
    const built = buildDecisionRequest(baseInput({
      ruleCode: 'lotus-legacy', hand: ['m3', 'm4', 'm5'], jokerTiles: ['m5'], wildcardTiles: ['white'],
    }))
    const prompt = buildPrompt('稳健', built.request!)
    expect(prompt.user).toContain('翻精')
    expect(prompt.user).toContain('白板为精替代')
  })
})

describe('normalizeBaseUrl', () => {
  it('规范化末尾斜杠并追加 /chat/completions；拒绝 userinfo 与不安全协议', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(normalizeBaseUrl('https://user:pass@api.example.com/v1')).toBeNull()
    expect(normalizeBaseUrl('http://api.example.com/v1')).toBeNull()
    expect(normalizeBaseUrl('http://localhost:11434/v1')).toBeTruthy()
  })
})

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get length() { return data.size },
    clear() { data.clear() },
    getItem(key: string) { return data.get(key) ?? null },
    key(index: number) { return [...data.keys()][index] ?? null },
    removeItem(key: string) { data.delete(key) },
    setItem(key: string, value: string) { data.set(key, value) },
  }
}

describe('llm 配置 v2（多预置 + 座位分配）', () => {
  const presetA = { id: 'pa', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-a', model: 'deepseek-v4-flash', style: '稳健' as const, timeoutMs: 8000 }
  const presetB = { id: 'pb', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-b', model: 'kimi-k2', style: '话痨' as const, timeoutMs: 8000 }
  const presetC = { id: 'pc', name: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-c', model: 'qwen-plus', style: '稳健' as const, timeoutMs: 8000 }

  it('空存储回退空配置（关闭状态）', () => {
    const result = readLlmSettings(memoryStorage())
    expect(result.enabled).toBe(false)
    expect(result.presets).toEqual([])
  })

  it('保存/读取回环：多预置 + 默认预置 + 座位分配 + 座位风格', () => {
    const storage = memoryStorage()
    saveLlmSettings({
      enabled: true,
      presets: [presetA, presetB, presetC],
      activeId: presetA.id,
      seatIds: [null, presetB.id, presetC.id, null],
      seatStyles: [null, '话痨', null, null],
    }, storage)
    const result = readLlmSettings(storage)
    expect(result.enabled).toBe(true)
    expect(result.presets).toHaveLength(3)
    expect(result.activeId).toBe('pa')
    expect(result.seatIds[1]).toBe('pb')
    expect(result.seatIds[2]).toBe('pc')
    expect(result.seatIds[3]).toBeNull()
    expect(result.seatStyles[1]).toBe('话痨')
    expect(result.seatStyles[2]).toBeNull()
  })

  it('v1 单预置自动迁移到 v2 默认预置', () => {
    const storage = memoryStorage()
    storage.setItem('llm.provider', JSON.stringify({ configVersion: 1, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-legacy', model: 'deepseek-chat', style: '稳健', timeoutMs: 8000 }))
    storage.setItem('llm.enabled', '1')
    const migrated = readLlmSettings(storage)
    expect(migrated.enabled).toBe(true)
    expect(migrated.presets).toHaveLength(1)
    expect(migrated.presets[0]).toMatchObject({ apiKey: 'sk-legacy', model: 'deepseek-chat', name: '默认' })
    expect(migrated.activeId).toBe(migrated.presets[0].id)
    // 迁移后 v2 已写回、v1 清理
    expect(storage.getItem('llm.provider')).toBeNull()
    expect(storage.getItem('llm.providers')).not.toBeNull()
  })

  it('损坏配置回退空配置', () => {
    const storage = memoryStorage()
    storage.setItem('llm.providers', '{broken')
    expect(readLlmSettings(storage).presets).toEqual([])
  })

  it('presetForSeat：座位指定优先，否则默认预置', () => {
    const settings: LlmSettings = { enabled: true, presets: [presetA, presetB], activeId: 'pa', seatIds: [null, 'pb', null, null], seatStyles: [null, null, null, null] }
    expect(presetForSeat(settings, 1)?.id).toBe('pb')
    expect(presetForSeat(settings, 2)?.id).toBe('pa')
    expect(presetForSeat(settings, 3)?.id).toBe('pa')
  })

  it('styleForSeat：座位风格覆盖优先，否则预置风格', () => {
    const settings: LlmSettings = { enabled: true, presets: [presetA, presetB], activeId: 'pa', seatIds: [null, 'pb', null, null], seatStyles: [null, '高冷', null, null] }
    // 座位 1 用预置 B（风格 话痨）但被座位风格覆盖为 高冷
    expect(styleForSeat(settings, 1)).toBe('高冷')
    // 座位 2 用预置 A（默认 风格 稳健），无覆盖 → 稳健
    expect(styleForSeat(settings, 2)).toBe('稳健')
  })
})

describe('testLlmConnection', () => {
  it('2xx → ok；401/429 等非 2xx → 错误信息（只调用一次，不重试）', async () => {
    const okSpy = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }] }),
    }))
    vi.stubGlobal('fetch', okSpy as never)
    await expect(testLlmConnection(config)).resolves.toMatchObject({ ok: true })
    expect(okSpy).toHaveBeenCalledTimes(1)

    const badSpy = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' }))
    vi.stubGlobal('fetch', badSpy as never)
    await expect(testLlmConnection(config)).resolves.toMatchObject({ ok: false })
    expect(badSpy).toHaveBeenCalledTimes(1)
  })

  it('finish_reason=length（模型回复被截断）对连接测试而言是成功', async () => {
    const spy = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'ping 回了一大段话…' }, finish_reason: 'length' }] }),
    }))
    vi.stubGlobal('fetch', spy as never)
    await expect(testLlmConnection(config)).resolves.toMatchObject({ ok: true, message: '连接成功' })
  })

  it('DeepSeek 端点自动关闭思考模式（thinking.disabled）；其他厂商不追加该字段', async () => {
    let capturedBody: Record<string, unknown> = {}
    const spy = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"choice":"A1","message":""}' }, finish_reason: 'stop' }] }),
      }
    })
    vi.stubGlobal('fetch', spy as never)
    await requestLlmDecision({ config, messages: { system: 's', user: 'u' }, candidateIds: ['A1'] })
    expect((capturedBody.thinking as { type: string }).type).toBe('disabled')

    const otherConfig = { ...config, baseUrl: 'https://api.example.com/v1' }
    let otherBody: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      otherBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"choice":"A1","message":""}' }, finish_reason: 'stop' }] }),
      }
    }) as never)
    await requestLlmDecision({ config: otherConfig, messages: { system: 's', user: 'u' }, candidateIds: ['A1'] })
    expect(otherBody.thinking).toBeUndefined()
  })

  it('Anthropic 端点自动携带浏览器直连头；其他厂商不携带', async () => {
    let captured = {} as Record<string, string>
    const spy = vi.fn(async (_url: string, init: RequestInit) => {
      captured = init.headers as Record<string, string>
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"choice":"A1","message":""}' }, finish_reason: 'stop' }] }),
      }
    })
    vi.stubGlobal('fetch', spy as never)
    await requestLlmDecision({
      config: { ...config, baseUrl: 'https://api.anthropic.com/v1' },
      messages: { system: 's', user: 'u' }, candidateIds: ['A1'],
    })
    expect(captured['anthropic-dangerous-direct-browser-access']).toBe('true')

    await requestLlmDecision({ config, messages: { system: 's', user: 'u' }, candidateIds: ['A1'] })
    expect(captured['anthropic-dangerous-direct-browser-access']).toBeUndefined()
  })
})

describe('createLocalLlmControllers（§9.1/运行时工厂）', () => {
  const presetA = { id: 'pa', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-a', model: 'deepseek-v4-flash', style: '稳健' as const, timeoutMs: 8000 }
  const presetB = { id: 'pb', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-b', model: 'kimi-k2', style: '话痨' as const, timeoutMs: 8000 }

  it('未配置/未启用 → null 控制器；启用且有 Key → 3 个 LLM 控制器', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const off = createLocalLlmControllers()
    expect(off.controllers).toBeNull()
    expect(off.enabled).toBe(false)

    saveLlmSettings({ enabled: true, presets: [presetA], activeId: 'pa', seatIds: [null, null, null, null], seatStyles: [null, null, null, null] }, storage)
    const on = createLocalLlmControllers()
    expect(on.enabled).toBe(true)
    expect(on.controllers).toHaveLength(3)
    const lotusOn = createLotusLlmControllers()
    expect(lotusOn.controllers).toHaveLength(3)
  })

  it('stats 为响应式对象：computed 随计数变化刷新（回归：设置面板统计恒 0）', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({ enabled: true, presets: [presetA], activeId: 'pa', seatIds: [null, null, null, null], seatStyles: [null, null, null, null] }, storage)
    const runtime = createLocalLlmControllers()
    expect(isReactive(runtime.stats)).toBe(true)
    const counts = computed(() => runtime.stats.requests)
    expect(counts.value).toBe(0)
    runtime.stats.requests = 7
    expect(counts.value).toBe(7)
  })

  it('启用但 Key 为空 → 关闭（不向无 Key 供应商发请求）', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({ enabled: true, presets: [{ ...presetA, apiKey: '' }], activeId: 'pa', seatIds: [null, null, null, null], seatStyles: [null, null, null, null] }, storage)
    const runtime = createLocalLlmControllers()
    expect(runtime.enabled).toBe(true)   // 允许空 Key（设置页可先填 Key）
    expect(runtime.controllers).toHaveLength(3) // 控制器装配（请求时无 Key 会回退启发式）
  })

  it('多预置 + 座位分配：三个座位按各自预置装配', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    saveLlmSettings({
      enabled: true, presets: [presetA, presetB], activeId: 'pa', seatIds: [null, 'pb', 'pa', 'pa'],
      seatStyles: [null, null, null, null],
    }, storage)
    const runtime = createLocalLlmControllers()
    expect(runtime.controllers).toHaveLength(3)
    expect(runtime.enabled).toBe(true)
  })

  it('人设种子：昵称（策略）+ 策略头像；未启用为空', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const off = createLocalLlmControllers()
    expect(off.seeds).toEqual([])

    saveLlmSettings({
      enabled: true, presets: [presetA, presetB], activeId: 'pa', seatIds: [null, 'pb', 'pa', 'pa'],
      seatStyles: [null, '高冷', null, null],
    }, storage)
    const runtime = createLocalLlmControllers()
    expect(runtime.seeds).toHaveLength(3)
    // 座位1（预置B=Kimi，风格覆盖=高冷）→ Kimi（高冷）；头像=高冷裁切
    expect(runtime.seeds[0].name).toBe('Kimi（高冷）')
    expect(runtime.seeds[0].avatar).toContain('llm-avatar-gaoleng')
    // 座位2（预置A=DeepSeek，无覆盖）→ 大肥鱼（稳健）；头像=稳健裁切
    expect(runtime.seeds[1].name).toBe('大肥鱼（稳健）')
    expect(runtime.seeds[1].avatar).toContain('llm-avatar-wenjian')
  })
})

describe('LLM 人设（persona）', () => {
  it('供应商默认昵称：DeepSeek=大肥鱼；其余用对应中文名', () => {
    expect(defaultNicknameFor('https://api.deepseek.com/v1', 'DeepSeek')).toBe('大肥鱼')
    expect(defaultNicknameFor('https://api.moonshot.cn/v1', 'Kimi')).toBe('Kimi')
    expect(defaultNicknameFor('https://dashscope.aliyuncs.com/compatible-mode/v1', '通义千问')).toBe('千问')
    expect(defaultNicknameFor('https://open.bigmodel.cn/api/paas/v4', '智谱')).toBe('智谱')
    expect(defaultNicknameFor('https://my.proxy.com/v1', '我的代理')).toBe('我的代理')
  })

  it('自定义昵称优先；对局显示为 昵称（策略）；头像按 供应商文件夹+策略 映射', () => {
    const preset = { id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk', model: 'm', style: '稳健' as const, timeoutMs: 8000, nickname: '大肥鱼二号' }
    expect(effectiveNickname(preset)).toBe('大肥鱼二号')
    expect(displayNameOf('大肥鱼', '激进')).toBe('大肥鱼（激进）')
    expect(avatarFor('https://api.deepseek.com/v1', '激进')).toContain('img/llm/deepseek/llm-avatar-jijin.png')
    expect(avatarFor('https://api.moonshot.cn/v1', '话痨')).toContain('img/llm/kimi/llm-avatar-huayao.png')
    expect(avatarFor('https://dashscope.aliyuncs.com/compatible-mode/v1', '高冷')).toContain('img/llm/qwen/llm-avatar-gaoleng.png')
    expect(avatarFor('https://my.proxy.com/v1', '稳健')).toContain('img/llm/custom/llm-avatar-wenjian.png')
    expect(avatarFolderFor('https://open.bigmodel.cn/api/paas/v4')).toBe('glm')
    expect(avatarFor('https://open.bigmodel.cn/api/paas/v4', '稳健')).toContain('img/llm/glm/llm-avatar-wenjian.png')
    expect(avatarFor('https://api.anthropic.com/v1', '话痨')).toContain('img/llm/claude/llm-avatar-huayao.png')
    expect(defaultNicknameFor('https://api.anthropic.com/v1', 'Claude')).toBe('Claude')
  })
})
