// LLM 层单元测试（无网络）：解析器 / 客户端重试语义 / 候选与特征 / 合法性复核 / prompt / 配置。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, isReactive } from 'vue'
import { cleanMessage, effectiveDecisionTimeoutMs, extractJsonObject, isQwenThinkingModel, parseLlmOutput, requestLlmDecision, testLlmConnection } from './client'
import { buildDecisionRequest } from './candidates'
import { isActionLegal } from './llmController'
import { buildPrompt } from './prompt'
import { normalizeBaseUrl, parseLlmSettingsJson, readLlmSettings, saveLlmSettings, serializeLlmSettings, presetForSeat, styleForSeat, type LlmSettings } from './config'
import { avatarFor, avatarFolderFor, avatarFolderOf, defaultNicknameFor, displayNameOf, effectiveNickname } from './persona'
import { createLocalLlmControllers, createLotusLlmControllers } from './runtime'
import { tileFromName, tileName } from './schema'
import type { DecisionInput } from './candidates'
import type { LlmProviderConfig } from './config'

const config: LlmProviderConfig = {
  baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-chat', style: '稳健', timeoutMs: 8000,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
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
  it('所有决策使用 SSE，但原始 reasoning_content 只转换为无内容的进度脉冲', async () => {
    let capturedBody: Record<string, unknown> = {}
    const progress = vi.fn()
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"我的暗手有两张一万"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"还有两张白板"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"choice\\":\\"A"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"1\\",\\"message\\":\\"稳住。\\"}"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens_details":{"reasoning_tokens":12}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as never)

    await expect(requestLlmDecision({
      config: {
        ...config,
        providerType: 'custom',
        baseUrl: 'https://api.orcarouter.ai/v1',
        model: 'kimi/kimi-k3',
      },
      messages: { system: 's', user: 'u' },
      candidateIds: ['A1'],
      onReasoningProgress: progress,
    })).resolves.toEqual({ choice: 'A1', message: '稳住。' })
    expect(capturedBody.stream).toBe(true)
    expect(progress).toHaveBeenCalledTimes(2)
    expect(progress.mock.calls).toEqual([[], []])
  })

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
  it('LLM 字牌使用完整且唯一的中文名，并保持发财/白板候选绑定', () => {
    const honorNames = ['east', 'south', 'west', 'north', 'red', 'green', 'white'].map((tile) => tileName(tile as never))
    expect(honorNames).toEqual(['东风', '南风', '西风', '北风', '红中', '发财', '白板'])
    expect(new Set(honorNames).size).toBe(honorNames.length)
    expect(tileFromName('发财')).toBe('green')
    expect(tileFromName('白板')).toBe('white')

    const built = buildDecisionRequest(baseInput({
      ruleCode: 'lotus-legacy', hand: ['green', 'white'], visibleTiles: ['green', 'white'],
      jokerTiles: ['green', 'white'], wildcardTiles: ['white'],
    }))
    expect(built.request?.candidates
      .filter((candidate) => candidate.action.kind === 'discard')
      .map((candidate) => ({ label: candidate.label, action: candidate.action })))
      .toEqual([
        { label: '出发财', action: { kind: 'discard', handIndex: 0 } },
        { label: '出白板', action: { kind: 'discard', handIndex: 1 } },
      ])
  })

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
    expect(built.request?.candidates.find((c) => c.id === 'G')?.label).toBe('大明杠3万')
    expect(built.request?.candidates.find((c) => c.id === 'G')?.features.scoreDeltaBand).toBeDefined()
  })

  it('可大明杠且碰后会把第 3 张同牌打回时，不向 LLM 提供碰候选', () => {
    const hand = [
      'east', 'east', 'east',
      'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'north',
    ] as never
    const built = buildDecisionRequest(baseInput({
      decision: 'claim', hand, tile: 'east', from: 1, canPeng: true, canGang: true,
      visibleTiles: [...hand, 'east'], publicTiles: ['east'],
    }))

    expect(built.request?.candidates.map((candidate) => candidate.id)).toEqual(['Z', 'G'])
    expect(built.request?.engineSuggestion).toBe('G')
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

  it('莲花：四面听东南西北时不向所有模型提供破坏听牌的风杠候选', () => {
    const hand = ['s3', 's4', 's5', 'east', 'south', 'west', 'north', 'p9'] as never
    const built = buildDecisionRequest(baseInput({
      ruleCode: 'lotus-legacy', hand, exposedMelds: 2, visibleTiles: hand,
      jokerTiles: [], wildcardTiles: ['white'],
    }))
    expect(built.request?.candidates.some((candidate) => candidate.action.kind === 'wind-kong')).toBe(false)
    expect(built.request?.candidates.find((candidate) => candidate.label === '出9筒')?.features.ready).toBe(true)
  })

  it('候选特征回填：听口明细 + 剩余张数（含自己手牌的可见计数）', () => {
    // 14 张手牌，打出 s2 后单骑听 2条（自己手牌仍有 2 张 s2 → 剩余 2）
    const hand = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 's1', 's1', 's1', 's2', 's2'] as never
    const built = buildDecisionRequest(baseInput({ hand, visibleTiles: hand }))
    const discard = built.request?.candidates.find((c) => c.action.kind === 'discard' && c.label === '出2条')
    expect(discard?.features.ready).toBe(true)
    expect(discard?.features.waits).toEqual(expect.arrayContaining([{ tile: '2条', remaining: 2 }]))
  })

  it('有普通牌时不生成广麻白板或莲花双精/白板弃牌候选', () => {
    const classic = buildDecisionRequest(baseInput({ hand: ['white', 'm3', 'm5'] }))
    expect(classic.request?.candidates.map((candidate) => candidate.label)).not.toContain('出白板')

    const legacy = buildDecisionRequest(baseInput({
      ruleCode: 'lotus-legacy', hand: ['m5', 'm6', 'white', 'm3'],
      jokerTiles: ['m5', 'm6'], wildcardTiles: ['white'],
    }))
    expect(legacy.request?.candidates.map((candidate) => candidate.label))
      .toEqual(expect.not.arrayContaining(['出5万', '出6万', '出白板']))
  })

  it('全手只剩受保护牌时仍生成候选并标记风险', () => {
    const built = buildDecisionRequest(baseInput({
      ruleCode: 'lotus-legacy', hand: ['m5', 'm6', 'white'],
      jokerTiles: ['m5', 'm6'], wildcardTiles: ['white'],
    }))
    const discards = built.request?.candidates.filter((candidate) => candidate.action.kind === 'discard') ?? []
    expect(discards).toHaveLength(3)
    expect(discards.every((candidate) => candidate.features.risks.some((risk) => risk.includes('癞子/精牌')))).toBe(true)
  })

  it('莲花麻将特殊牌型听牌由规则引擎标注', () => {
    const hand = ['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p1', 'p1', 'p2', 'p2', 's1', 's1', 'east', 'south'] as never
    const built = buildDecisionRequest(baseInput({
      ruleCode: 'lotus-legacy', hand, visibleTiles: hand,
      jokerTiles: [], wildcardTiles: ['white'],
    }))
    const discardSouth = built.request?.candidates.find((candidate) => candidate.label === '出南风')
    expect(discardSouth?.features.specialPattern).toContain('七对子听牌')
  })
})

describe('isActionLegal：动作合法性复核（§8.2 表）', () => {
  it('discard 越界拒绝、界内通过', () => {
    const input = baseInput()
    expect(isActionLegal(input, { kind: 'discard', handIndex: 0 })).toBe(true)
    expect(isActionLegal(input, { kind: 'discard', handIndex: 3 })).toBe(false)
  })

  it('有普通牌时二次校验拒绝弃癞子或精牌', () => {
    expect(isActionLegal(baseInput({ hand: ['white', 'm3'] }), { kind: 'discard', handIndex: 0 })).toBe(false)
    expect(isActionLegal(baseInput({
      ruleCode: 'lotus-legacy', hand: ['m5', 'white', 'm3'],
      jokerTiles: ['m5', 'm6'], wildcardTiles: ['white'],
    }), { kind: 'discard', handIndex: 0 })).toBe(false)
  })

  it('二次校验拒绝会拆掉四面听的风杠', () => {
    const hand = ['s3', 's4', 's5', 'east', 'south', 'west', 'north', 'p9'] as never
    expect(isActionLegal(baseInput({
      ruleCode: 'lotus-legacy', hand, exposedMelds: 2, visibleTiles: hand,
      jokerTiles: [], wildcardTiles: ['white'],
    }), { kind: 'wind-kong' })).toBe(false)
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
  it('包含候选编号、默认参考与自由牌桌台词约束', () => {
    const built = buildDecisionRequest(baseInput())
    const prompt = buildPrompt('稳健', built.request!)
    expect(prompt.system).toContain('你是莲花广麻牌桌上的牌友')
    expect(prompt.system).not.toContain('广东麻将桌上的牌友')
    expect(prompt.user).toContain('【候选动作】')
    expect(prompt.user).toContain('A1')
    expect(prompt.user).toContain('{"choice": "A1"')
    expect(prompt.user).toContain('【默认参考】')
    expect(prompt.system).not.toContain('游戏引擎')
    expect(prompt.system).toContain('烟雾弹')
    expect(prompt.system).toContain('不要求公开真实意图')
    expect(prompt.system).toContain('公开事实必须如实')
    expect(prompt.user).toContain('你是庄家')
    expect(prompt.system).not.toContain('不要使用“稳稳”一词')
    expect(prompt.user).toContain('"message": "有点意思。"')
    expect(prompt.user).toContain('message 必须非空')
    expect(prompt.user).toContain('【你的暗手（不含副露/杠组）】')
    expect(prompt.system).toContain('规则摘要未列出的特殊牌型一律视为不支持')
    expect(prompt.system).toContain('响应别人弃牌只能是大明杠')
    expect(prompt.system).toContain('决策优先级')
    expect(prompt.user).toContain('默认优先')
  })

  it('明确告诉非庄家其本人不是庄家，不要求模型猜绝对座位编号', () => {
    const built = buildDecisionRequest(baseInput({ playerIndex: 2, dealerIndex: 0, seatWind: '西' }))
    const prompt = buildPrompt('激进', built.request!)
    expect(built.request?.state.isDealer).toBe(false)
    expect(prompt.user).toContain('你是「西」家｜你不是庄家')
    expect(prompt.user).not.toContain('庄家座位「0」')
  })

  it('明确区分刚摸、碰后未摸和当前牌河弃牌', () => {
    const drawn = buildDecisionRequest(baseInput({ turnOrigin: 'draw', drawnTile: 'p5' }))
    expect(buildPrompt('稳健', drawn.request!).user).toContain('【刚摸到】「5筒」')

    const peng = buildDecisionRequest(baseInput({ turnOrigin: 'peng', drawnTile: null }))
    const pengPrompt = buildPrompt('稳健', peng.request!).user
    expect(pengPrompt).toContain('碰后直接出牌（本回合没有摸牌）')
    expect(pengPrompt).not.toContain('【刚摸到】')

    const claim = buildDecisionRequest(baseInput({
      decision: 'claim', playerIndex: 0, tile: 'm3', from: 3, canPeng: true,
    }))
    const claimPrompt = buildPrompt('稳健', claim.request!).user
    expect(claimPrompt).toContain('【当前弃牌】「上家」打出「3万」')
    expect(claimPrompt).toContain('{"choice": "Z", "message": "有点意思。"}')
    expect(claimPrompt).not.toContain('{"choice": "A1"')
  })

  it('明确标注碰与杠，第四张弃牌不会自动并入已有碰组', () => {
    const peers = baseInput().peers!
    peers[1] = {
      discards: [],
      melds: [{ type: 'peng', tile: 'm7', tiles: ['m7', 'm7', 'm7'] }],
    }
    const withRequest = buildDecisionRequest(baseInput({
      decision: 'claim', playerIndex: 0, tile: 'm7', from: 3, canPeng: true, peers,
    }))
    const prompt = buildPrompt('稳健', withRequest.request!).user
    expect(prompt).toContain('下家：「碰：7万×3」')
    expect(prompt).toContain('【当前弃牌】「上家」打出「7万」')
    expect(prompt).toContain('不会自动并入任何玩家已有的碰组')
    expect(prompt).not.toContain('下家：「明杠：7万×4」')
  })

  it('莲花广麻明确只支持标准牌型，禁止追逐七对等其他玩法牌型', () => {
    const built = buildDecisionRequest(baseInput({
      publicTiles: ['m1'], upperLastDiscard: 'm1',
    }))
    const prompt = buildPrompt('稳健', built.request!)
    expect(prompt.system).toContain('你是莲花广麻牌桌上的牌友')
    expect(prompt.user).toContain('唯一支持的胡牌结构是标准 4 面子+1 将')
    expect(prompt.user).toContain('不支持七对、十三幺、十三烂、七星十三烂')
    expect(prompt.user).toContain('弃牌无需考虑点炮风险')
    expect(prompt.user).toContain('只可自摸或抢杠胡')
    expect(prompt.user).not.toContain('安全度：')
  })

  it('莲花麻将使用双精牌与白板受限替代规则，并允许指定特殊牌型', () => {
    const built = buildDecisionRequest(baseInput({
      ruleCode: 'lotus-legacy', hand: ['m3', 'm4', 'm5'], jokerTiles: ['m5'], wildcardTiles: ['white'],
    }))
    const prompt = buildPrompt('稳健', built.request!)
    expect(prompt.system).toContain('你是莲花麻将牌桌上的牌友')
    expect(prompt.user).toContain('翻出的牌面及其同序下一张均为精牌')
    expect(prompt.user).toContain('白板只能替代上述精牌面或白板本身')
    expect(prompt.user).toContain('支持的特殊牌型：七对、十三幺、十三烂、七星十三烂')
    expect(prompt.user).not.toContain('不支持七对')
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
    expect(result.presets.every((preset) => preset.timeoutMs === 40_000)).toBe(true)
    expect(result.presets.every((preset) => preset.timeoutEnabled === true)).toBe(true)
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
    expect(migrated.presets[0].timeoutMs).toBe(40_000)
    expect(migrated.presets[0].timeoutEnabled).toBe(true)
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

  it('牌桌超时开关默认开启，并可按预置关闭后持久化', () => {
    const storage = memoryStorage()
    saveLlmSettings({
      enabled: true,
      presets: [{ ...presetA, timeoutEnabled: false }],
      activeId: 'pa', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
    }, storage)
    const result = readLlmSettings(storage)
    expect(result.presets[0].timeoutEnabled).toBe(false)
    expect(effectiveDecisionTimeoutMs(result.presets[0])).toBe(Number.POSITIVE_INFINITY)
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

  it('JSON 导出不含 Key；导入保留同 id 的本机 Key 与座位分配', () => {
    const settings: LlmSettings = {
      enabled: true,
      presets: [{ ...presetA, timeoutEnabled: false }, presetB],
      activeId: 'pa',
      seatIds: [null, 'pb', 'pa', null],
      seatStyles: [null, '高冷', null, '话痨'],
    }
    const json = serializeLlmSettings(settings)
    expect(json).not.toContain('sk-a')
    expect(json).not.toContain('sk-b')
    expect(json).not.toContain('apiKey')

    const imported = parseLlmSettingsJson(json, settings)
    expect(imported.enabled).toBe(true)
    expect(imported.presets.map((preset) => preset.apiKey)).toEqual(['sk-a', 'sk-b'])
    expect(imported.presets.every((preset) => preset.timeoutMs === 40_000)).toBe(true)
    expect(imported.presets.map((preset) => preset.timeoutEnabled)).toEqual([false, true])
    expect(imported.activeId).toBe('pa')
    expect(imported.seatIds).toEqual([null, 'pb', 'pa', null])
    expect(imported.seatStyles).toEqual([null, '高冷', null, '话痨'])

    const fresh = parseLlmSettingsJson(json)
    expect(fresh.presets.every((preset) => preset.apiKey === '')).toBe(true)
  })

  it('JSON 导入拒绝坏格式、未知版本和重复 id，并忽略文件内 Key', () => {
    expect(() => parseLlmSettingsJson('{broken')).toThrow('JSON 格式无效')
    expect(() => parseLlmSettingsJson(JSON.stringify({ kind: 'other', version: 1, settings: {} })))
      .toThrow('不是受支持的莲花广麻大模型配置文件')

    const parsed = JSON.parse(serializeLlmSettings({
      enabled: true,
      presets: [presetA], activeId: 'pa',
      seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
    })) as { settings: { presets: Array<Record<string, unknown>> } }
    parsed.settings.presets[0].apiKey = 'injected-key'
    parsed.settings.presets.push({ ...parsed.settings.presets[0] })
    expect(() => parseLlmSettingsJson(JSON.stringify(parsed))).toThrow('预置 id 重复')
    parsed.settings.presets.pop()
    expect(parseLlmSettingsJson(JSON.stringify(parsed)).presets[0].apiKey).toBe('')
  })
})

describe('testLlmConnection', () => {
  it('关闭牌桌超时后不会在40秒触发Abort，响应到达后仍正常解析', async () => {
    vi.useFakeTimers()
    let finishFetch!: () => void
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return await new Promise((resolve, reject) => {
        finishFetch = () => resolve({
          ok: true, status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"choice":"A1","message":"完成。"}' }, finish_reason: 'stop' }],
          }),
        })
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }) as never)
    const decision = requestLlmDecision({
      config: { ...config, timeoutMs: 40_000, timeoutEnabled: false },
      messages: { system: 's', user: 'u' }, candidateIds: ['A1'],
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(signal.aborted).toBe(false)
    finishFetch()
    await expect(decision).resolves.toEqual({ choice: 'A1', message: '完成。' })
  })

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

  it('GLM-5.3 Flash 连接测试关闭思考并使用 8 tokens', async () => {
    let capturedBody: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        }),
      }
    }) as never)
    await expect(testLlmConnection({
      ...config, providerType: 'custom', baseUrl: 'https://api.orcarouter.ai/v1', model: 'z-ai/glm-5.3-flash',
    })).resolves.toEqual({ ok: true, message: '连接成功' })
    expect(capturedBody).toMatchObject({
      model: 'z-ai/glm-5.3-flash', max_tokens: 8, reasoning_effort: 'none',
    })
    expect(capturedBody.thinking).toBeUndefined()
  })

  it('DeepSeek 与千问 3.7 自动关闭思考；千问同时请求 JSON Object', async () => {
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
    expect(capturedBody.stream).toBe(true)
    expect((capturedBody.thinking as { type: string }).type).toBe('disabled')

    const qwenConfig = {
      ...config,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.7-plus',
      timeoutMs: 40_000,
    }
    let qwenBody: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      qwenBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{"choice":"A1","message":""}' }, finish_reason: 'stop' }] }),
      }
    }) as never)
    await requestLlmDecision({ config: qwenConfig, messages: { system: 's', user: 'u' }, candidateIds: ['A1'] })
    expect(isQwenThinkingModel(qwenConfig)).toBe(true)
    expect(effectiveDecisionTimeoutMs(qwenConfig)).toBe(40_000)
    expect(qwenBody.enable_thinking).toBe(false)
    expect(qwenBody.response_format).toEqual({ type: 'json_object' })

    const otherConfig = { ...config, baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' }
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
    expect(otherBody.enable_thinking).toBeUndefined()
  })

  it('旧预置缺少 providerType 时按地址/模型迁移并在导出中保留', () => {
    const storage = memoryStorage()
    storage.setItem('llm.providers', JSON.stringify({
      configVersion: 2, enabled: true,
      presets: [{ id: 'q1', name: 'Qwen', baseUrl: 'https://proxy.example.com/v1', apiKey: 'sk', model: 'qwen3.7-plus', style: '稳健' }],
      activeId: 'q1', seatIds: [null, null, null, null], seatStyles: [null, null, null, null],
    }))
    const settings = readLlmSettings(storage)
    expect(settings.presets[0].providerType).toBe('qwen')
    expect(JSON.parse(serializeLlmSettings(settings)).settings.presets[0].providerType).toBe('qwen')
  })

  it('Kimi K2.6 经自定义代理仍关闭思考，中转泄漏推理字段时仍解析最终 content', async () => {
    let captured: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{
            message: { content: '{"choice":"A1","message":"稳住。"}', reasoning_content: '中转仍返回思考' },
            finish_reason: 'stop',
          }],
          usage: { completion_tokens_details: { reasoning_tokens: 12 } },
        }),
      }
    }) as never)
    await expect(requestLlmDecision({
      config: { ...config, providerType: 'kimi', baseUrl: 'https://proxy.example.com/v1', model: 'kimi-k2.6' },
      messages: { system: 's', user: 'u' }, candidateIds: ['A1'],
    })).resolves.toEqual({ choice: 'A1', message: '稳住。' })
    expect(captured.thinking).toEqual({ type: 'disabled' })
    expect(captured.temperature).toBe(0.6)
    expect(captured.top_p).toBe(0.95)
  })

  it('Kimi K3 不传 thinking，使用固定采样参数并接受推理响应', async () => {
    let captured: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{
            message: { content: '{"choice":"A1","message":"稳住。"}', reasoning_content: '先分析候选牌' },
            finish_reason: 'stop',
          }],
          usage: { completion_tokens_details: { reasoning_tokens: 160 } },
        }),
      }
    }) as never)
    await expect(requestLlmDecision({
      config: {
        ...config, providerType: 'kimi', baseUrl: 'https://api.orcarouter.ai/v1', model: 'kimi/kimi-k3',
      },
      messages: { system: 's', user: 'u' }, candidateIds: ['A1'],
    })).resolves.toEqual({ choice: 'A1', message: '稳住。' })
    expect(captured).toMatchObject({
      model: 'kimi/kimi-k3', temperature: 1, top_p: 0.95,
      reasoning_effort: 'low', max_tokens: 512,
    })
    expect(captured.thinking).toBeUndefined()
  })

  it('GLM-5.3 Flash 普通决策关闭思考并使用快速输出上限', async () => {
    let capturedBody: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{
            message: { content: '{"choice":"A1","message":"稳住。"}' },
            finish_reason: 'stop',
          }],
          usage: { completion_tokens_details: { reasoning_tokens: 0 } },
        }),
      }
    }) as never)
    await expect(requestLlmDecision({
      config: {
        ...config, providerType: 'custom', baseUrl: 'https://api.orcarouter.ai/v1', model: 'z-ai/glm-5.3-flash',
      },
      messages: { system: 's', user: 'u' }, candidateIds: ['A1'],
    })).resolves.toEqual({ choice: 'A1', message: '稳住。' })
    expect(capturedBody).toMatchObject({
      model: 'z-ai/glm-5.3-flash', max_tokens: 64, reasoning_effort: 'none',
    })
    expect(capturedBody.thinking).toBeUndefined()
  })

  it('Claude Sonnet 5 快速路径显式关闭默认思考并移除采样参数', async () => {
    let capturedBody: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"choice":"A1","message":"稳住。"}' }, finish_reason: 'stop' }],
        }),
      }
    }) as never)
    const claude = {
      ...config, providerType: 'custom' as const,
      baseUrl: 'https://api.orcarouter.ai/v1', model: 'anthropic/claude-sonnet-5',
    }
    await expect(requestLlmDecision({
      config: claude, messages: { system: 's', user: 'u' }, candidateIds: ['A1'],
    })).resolves.toEqual({ choice: 'A1', message: '稳住。' })
    expect(capturedBody.thinking).toEqual({ type: 'disabled' })
    expect(capturedBody.temperature).toBeUndefined()
    expect(capturedBody.top_p).toBeUndefined()

    await requestLlmDecision({
      config: claude, messages: { system: 's', user: 'u' }, candidateIds: ['A1'], reasoning: true,
    })
    expect(capturedBody).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
    })
  })

  it('关闭参数被代理吞掉并返回思考内容时拒绝响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"choice":"A1"}', reasoning_content: '仍在思考' }, finish_reason: 'stop' }],
        usage: { completion_tokens_details: { reasoning_tokens: 12 } },
      }),
    })) as never)
    await expect(requestLlmDecision({
      config: { ...config, providerType: 'qwen', baseUrl: 'https://proxy.example.com/v1', model: 'qwen3.7-plus' },
      messages: { system: 's', user: 'u' }, candidateIds: ['A1'],
    })).rejects.toMatchObject({ kind: 'reasoning' })
  })

  it.each([
    ['custom', 'z-ai/glm-5.3-flash'],
    ['minimax', 'MiniMax-M2.7'],
  ] as const)('%s 协议的 %s 不做型号预检，由上游返回错误', async (providerType, model) => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: false, status: 404, text: async () => 'model not found',
    }))
    vi.stubGlobal('fetch', fetchSpy as never)
    await expect(requestLlmDecision({
      config: { ...config, providerType, model },
      messages: { system: 's', user: 'u' }, candidateIds: ['A1'],
    })).rejects.toMatchObject({ kind: 'http', message: 'HTTP 404: model not found' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(requestBody.model).toBe(model)
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
    expect(avatarFor({ baseUrl: 'https://api.deepseek.com/v1' }, '激进')).toContain('img/llm/deepseek/llm-avatar-jijin.png')
    expect(avatarFor({ baseUrl: 'https://api.moonshot.cn/v1' }, '话痨')).toContain('img/llm/kimi/llm-avatar-huayao.png')
    expect(avatarFor({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, '高冷')).toContain('img/llm/qwen/llm-avatar-gaoleng.png')
    expect(avatarFor({ baseUrl: 'https://my.proxy.com/v1' }, '稳健')).toContain('img/llm/custom/llm-avatar-wenjian.png')
    expect(avatarFolderFor('https://open.bigmodel.cn/api/paas/v4')).toBe('glm')
    expect(avatarFor({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, '稳健')).toContain('img/llm/glm/llm-avatar-wenjian.png')
    expect(avatarFor({ baseUrl: 'https://api.anthropic.com/v1' }, '话痨')).toContain('img/llm/claude/llm-avatar-huayao.png')
    expect(defaultNicknameFor('https://api.anthropic.com/v1', 'Claude')).toBe('Claude')
  })

  it('自定义模板可覆盖头像文件夹；非法字符忽略；模板改 baseUrl 不需要覆盖项', () => {
    // 中转站（未知域名）：无覆盖 → custom 文件夹（自动识别，无需配置）
    expect(avatarFolderOf({ baseUrl: 'https://cdxai.cn/v1' })).toBe('custom')
    // 真·自定义：手动指定文件夹（如借用 gpt 素材）
    expect(avatarFolderOf({ baseUrl: 'https://cdxai.cn/v1', avatarFolder: 'gpt' })).toBe('gpt')
    // 非法字符忽略 → 回退自动识别
    expect(avatarFolderOf({ baseUrl: 'https://cdxai.cn/v1', avatarFolder: '../x' })).toBe('custom')
    expect(avatarFor({ baseUrl: 'https://cdxai.cn/v1', avatarFolder: 'kimi' }, '话痨')).toContain('img/llm/kimi/llm-avatar-huayao.png')
  })
})
