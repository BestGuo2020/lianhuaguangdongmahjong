import { describe, expect, it, vi } from 'vitest'
import type { TurnContext } from '../../core/controllers/playerController'
import type { LlmSettings } from '../../llm/config'
import {
  createVibeLlmSpeechBarrier,
  createVibeCoreLlmRuntime,
  createVibeLotusLlmRuntime,
  isVibeLlmSpeechAck,
  listHostLlmOptions,
  resolveHostLlmSelections,
  vibeLlmSpeechAckOf,
} from './vibeLlm'

const mocks = vi.hoisted(() => ({
  requestLlmDecision: vi.fn(async () => ({ choice: 'A1', message: '这张我先走。' })),
}))

vi.mock('../../llm/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../llm/client')>(),
  requestLlmDecision: mocks.requestLlmDecision,
}))

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

  it('最多接受两个硬预留大模型座位，为第二名真人保留一席', () => {
    const resolved = resolveHostLlmSelections([
      { seat: 1, presetId: 'deepseek', style: '激进' },
      { seat: 2, presetId: 'deepseek', style: '稳健' },
      { seat: 3, presetId: 'gpt', style: '高冷' },
    ], new Set([0]), settings())

    expect(resolved.privateSeats.map((item) => item.seat)).toEqual([1, 2])
    expect(resolved.publicSeats).toHaveLength(2)
  })

  it('多人 LLM 不再按性格冷却丢台词，并等待语音屏障后才返回动作', async () => {
    let release!: () => void
    const onMessage = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
      .mockResolvedValue(undefined)
    const runtime = createVibeCoreLlmRuntime(
      [{ seat: 2, presetId: 'deepseek', style: '话痨' }],
      { onMessage },
      settings(),
    )
    const controller = runtime.controllers[1]
    const context: TurnContext = {
      hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p3', 'p5', 's2', 's4', 'east', 'white'],
      melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false,
      playerIndex: 2, scores: [1000, 1000, 1000, 1000], peers: [], wallCount: 50,
    }
    let resolved = false
    const first = controller.requestTurn(context).then((action) => { resolved = true; return action })

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce())
    expect(resolved).toBe(false)
    release()
    await expect(first).resolves.toEqual(expect.objectContaining({ kind: 'discard' }))
    await controller.requestTurn(context)
    expect(onMessage).toHaveBeenCalledTimes(2)
  })
})

describe('vibehub LLM 语音中点屏障', () => {
  const identity = { roomId: 'ROOM01', authorityEpoch: 'epoch-1', round: 1, id: 7 }

  it('只接受当前台词期待中的 peer，全部到达中点后放行', async () => {
    const barrier = createVibeLlmSpeechBarrier(1_000)
    let released = false
    const waiting = barrier.wait(identity, ['peer-1', 'peer-2']).then(() => { released = true })

    expect(barrier.acknowledge(vibeLlmSpeechAckOf(identity), 'unknown')).toBe(false)
    expect(barrier.acknowledge(vibeLlmSpeechAckOf(identity), 'peer-1')).toBe(true)
    expect(released).toBe(false)
    expect(barrier.acknowledge(vibeLlmSpeechAckOf(identity), 'peer-2')).toBe(true)
    await waiting
    expect(released).toBe(true)
  })

  it('校验 ACK 身份字段，并在超时或取消时兜底放行', async () => {
    expect(isVibeLlmSpeechAck(vibeLlmSpeechAckOf(identity))).toBe(true)
    expect(isVibeLlmSpeechAck({ ...vibeLlmSpeechAckOf(identity), id: 0 })).toBe(false)
    const barrier = createVibeLlmSpeechBarrier(5)
    await expect(barrier.wait(identity, ['silent-peer'])).resolves.toBeUndefined()
    const cancelled = barrier.wait({ ...identity, id: 8 }, ['peer'])
    barrier.cancel({ ...identity, id: 8 })
    await expect(cancelled).resolves.toBeUndefined()
  })
})
