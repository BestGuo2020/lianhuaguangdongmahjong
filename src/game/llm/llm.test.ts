// LLM 层单元测试（无网络）：解析器 / 客户端重试语义 / 候选与特征 / 合法性复核 / prompt / 配置。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractJsonObject, parseLlmOutput, cleanMessage, requestLlmDecision, testLlmConnection } from './client'
import { buildDecisionRequest } from './candidates'
import { isActionLegal } from './llmController'
import { buildPrompt } from './prompt'
import { normalizeBaseUrl, readLlmConfig, writeLlmConfig } from './config'
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

describe('llm 配置存取（§9.1）', () => {
  it('空存储返回默认值与关闭状态', () => {
    const storage = memoryStorage()
    const result = readLlmConfig(storage)
    expect(result.enabled).toBe(false)
    expect(result.config.apiKey).toBe('')
    expect(result.config.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(result.config.model).toBe('deepseek-chat')
  })

  it('写入/读取回环；enabled 独立存储', () => {
    const storage = memoryStorage()
    writeLlmConfig({ enabled: true, baseUrl: 'https://example.com/v1', apiKey: 'sk-x', model: 'm1', style: '话痨' }, storage)
    const result = readLlmConfig(storage)
    expect(result.enabled).toBe(true)
    expect(result.config).toMatchObject({ baseUrl: 'https://example.com/v1', apiKey: 'sk-x', model: 'm1', style: '话痨' })
  })

  it('configVersion 不匹配或 JSON 损坏时回退默认（不丢 Key 语义由设置页迁移处理）', () => {
    const storage = memoryStorage()
    storage.setItem('llm.provider', JSON.stringify({ configVersion: 99, apiKey: 'sk-old' }))
    expect(readLlmConfig(storage).config.apiKey).toBe('')
    storage.setItem('llm.provider', '{broken')
    expect(readLlmConfig(storage).config.baseUrl).toBe('https://api.deepseek.com/v1')
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
})

describe('createLocalLlmControllers（§9.1/运行时工厂）', () => {
  it('未配置/未启用 → null 控制器；启用且有 Key → 3 个 LLM 控制器', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const off = createLocalLlmControllers()
    expect(off.controllers).toBeNull()
    expect(off.enabled).toBe(false)

    writeLlmConfig({ enabled: true, apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com/v1' }, storage)
    const on = createLocalLlmControllers()
    expect(on.enabled).toBe(true)
    expect(on.controllers).toHaveLength(3)
    const lotusOn = createLotusLlmControllers()
    expect(lotusOn.controllers).toHaveLength(3)
  })
})
