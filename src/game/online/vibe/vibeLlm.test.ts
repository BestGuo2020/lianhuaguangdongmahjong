import { describe, expect, it, vi } from 'vitest'
import type { LlmSettings } from '../../llm/config'
import {
  createVibeCoreLlmRuntime,
  createVibeLotusLlmRuntime,
  listHostLlmOptions,
  resolveHostLlmSelections,
} from './vibeLlm'

function settings(): LlmSettings {
  return {
    enabled: true,
    activeId: 'deepseek',
    seatIds: [null, null, null, null],
    seatStyles: [null, null, null, null],
    presets: [
      {
        id: 'deepseek', name: 'DeepSeek', nickname: '大肥鱼', baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'secret-key', model: 'deepseek-chat', style: '稳健', timeoutMs: 8000, ttsVoiceKey: 'deepseek',
      },
      {
        id: 'gpt', name: 'GPT', baseUrl: 'https://api.openai.com/v1',
        apiKey: 'another-secret', model: 'gpt-test', style: '高冷', timeoutMs: 8000, ttsVoiceKey: 'relay_gpt',
      },
    ],
  }
}

describe('vibe host LLM runtime', () => {
  it('把每个可用预置展开为四种策略，且 UI 选项不含凭据', () => {
    const options = listHostLlmOptions(settings())
    expect(options).toHaveLength(8)
    expect(options.map((item) => item.style)).toContain('激进')
    const wire = JSON.stringify(options)
    expect(wire).not.toContain('secret-key')
    expect(wire).not.toContain('api.deepseek.com')
  })

  it('真人座位优先，P2P 公共身份不包含 presetId/key/baseUrl', () => {
    const resolved = resolveHostLlmSelections([
      { seat: 1, presetId: 'deepseek', style: '激进' },
      { seat: 2, presetId: 'gpt', style: '高冷' },
    ], new Set([0, 1]), settings())

    expect(resolved.privateSeats).toEqual([{ seat: 2, presetId: 'gpt', style: '高冷' }])
    expect(resolved.publicSeats[0]).toMatchObject({ seat: 2, displayName: 'GPT（高冷）', model: 'gpt-test' })
    const wire = JSON.stringify(resolved.publicSeats)
    expect(wire).not.toContain('presetId')
    expect(wire).not.toContain('another-secret')
    expect(wire).not.toContain('api.openai.com')
  })

  it('两种规则分别装配控制器并标记 LLM 玩家身份', () => {
    const selection = [{ seat: 2 as const, presetId: 'deepseek', style: '话痨' as const }]
    const onMessage = vi.fn()
    const core = createVibeCoreLlmRuntime(selection, { onMessage }, settings())
    const lotus = createVibeLotusLlmRuntime(selection, { onMessage }, settings())

    expect(core.controllers).toHaveLength(3)
    expect(lotus.controllers).toHaveLength(3)
    expect(core.seeds[1]).toMatchObject({ name: '大肥鱼（话痨）', isLlm: true })
    expect(lotus.profiles.get(2)).toMatchObject({ style: '话痨', voiceKey: 'deepseek' })
  })
})
