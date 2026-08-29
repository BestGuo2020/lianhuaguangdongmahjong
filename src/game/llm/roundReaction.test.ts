import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}))

vi.mock('./client', () => ({ requestLlmDecision: mocks.request }))

import type { LlmProviderConfig } from './config'
import { buildRoundReactionPrompt, generateRoundReaction, ROUND_REACTION_TIMEOUT_MS } from './roundReaction'

const config: LlmProviderConfig = {
  providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk',
  model: 'deepseek-v4-flash', style: '高冷', timeoutMs: 40_000, timeoutEnabled: false,
}

describe('LLM round reaction generation', () => {
  it('只提供公开结果与性格，使用短超时快速非思考生成', async () => {
    mocks.request.mockResolvedValueOnce({ choice: 'R', message: '下局，拿回来。' })

    await expect(generateRoundReaction(
      config, { outcome: 'loss' }, '这局输了，仅此而已。', 1,
    )).resolves.toBe('下局,拿回来。')

    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      candidateIds: ['R'], reasoning: false,
      config: expect.objectContaining({
        timeoutMs: ROUND_REACTION_TIMEOUT_MS,
        timeoutEnabled: true,
      }),
    }))
    const prompt = buildRoundReactionPrompt('高冷', { outcome: 'loss' }, '保底句', 1)
    expect(prompt.user).toContain('你输了本局')
    expect(prompt.user).not.toMatch(/手牌|听口|牌河|副露/)
  })

  it('网络失败、空句或幕后术语返回 null，让调用方使用保底台词', async () => {
    mocks.request.mockRejectedValueOnce(new Error('timeout'))
    await expect(generateRoundReaction(
      config, { outcome: 'draw' }, '荒庄，下一局。', 0,
    )).resolves.toBeNull()

    mocks.request.mockResolvedValueOnce({ choice: 'R', message: '模型建议下一局继续' })
    await expect(generateRoundReaction(
      config, { outcome: 'draw' }, '荒庄，下一局。', 0,
    )).resolves.toBeNull()
  })
})
