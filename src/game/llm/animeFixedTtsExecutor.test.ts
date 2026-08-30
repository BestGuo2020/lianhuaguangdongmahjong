import { describe, expect, it, vi } from 'vitest'
import type { TableActionType } from '../core/contracts/types'
import type { LlmAudioPlaybackHooks } from '../core/presentation/llmAudioBus'
import {
  ANIME_ACTION_FALLBACK_AUDIO,
  AnimeFixedTtsExecutor,
  animeFallbackAudioForAction,
  animeResultVoiceKeyForSeat,
  animeRoundSpeechOrder,
  animeVoiceKeyForTableAction,
  type AnimeFixedTtsSpeaker,
} from './animeFixedTtsExecutor'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function speaker(
  speak: AnimeFixedTtsSpeaker['speak'] = vi.fn(async () => true),
) {
  return {
    speak: vi.fn(speak),
    cancel: vi.fn(() => {}),
  }
}

describe('AnimeFixedTtsExecutor', () => {
  it.each([
    ['chi', 'chi', 'chi.mp3'],
    ['peng', 'peng', 'peng.mp3'],
    ['discard-gang', 'gang', 'gang.mp3'],
    ['concealed-gang', 'gang', 'gang.mp3'],
    ['added-gang', 'gang', 'gang.mp3'],
    ['flower-gang', 'gang', 'gang.mp3'],
    ['wind-kong', 'gang', 'gang.mp3'],
    ['discard-win', 'hu', 'hu.mp3'],
    ['self-draw', 'zimo', 'zimo.mp3'],
    ['robbed-kong-win', 'qiangganghu', 'hu.mp3'],
  ] satisfies Array<[TableActionType, string, string]>)('映射 %s 的固定文案和失败回退', (action, key, fallback) => {
    expect(animeVoiceKeyForTableAction(action)).toBe(key)
    expect(animeFallbackAudioForAction(action)).toBe(fallback)
    expect(ANIME_ACTION_FALLBACK_AUDIO[key as keyof typeof ANIME_ACTION_FALLBACK_AUDIO]).toBe(fallback)
  })

  it('按角色调用固定稳健文案，并等待动作播放中点而非整句', async () => {
    const client = speaker()
    const executor = new AnimeFixedTtsExecutor(client)

    const result = await executor.executeAction({
      eventId: 10,
      seat: 2,
      characterId: 'qwen',
      action: 'robbed-kong-win',
    })

    expect(result.status).toBe('played')
    expect(result.fallbackAudioFile).toBeNull()
    expect(result.request).toMatchObject({
      characterId: 'qwen',
      animeVoiceKey: 'qiangganghu',
      voiceKey: 'qwen',
      style: '稳健',
    })
    expect(client.speak).toHaveBeenCalledWith(
      2,
      '抢杠胡,失礼了。',
      'qwen',
      '稳健',
      'important',
      expect.objectContaining({
        cacheIdentity: result.request.cacheIdentity,
        waitForCompletion: undefined,
      }),
    )
  })

  it('TTS 返回 false 或抛错时给动作调用方明确的通用人声回退', async () => {
    const falseClient = speaker(async () => false)
    const falseResult = await new AnimeFixedTtsExecutor(falseClient).executeAction({
      eventId: 'false', seat: 0, characterId: 'deepseek', action: 'self-draw',
    })
    expect(falseResult).toMatchObject({ status: 'failed', fallbackAudioFile: 'zimo.mp3' })

    const throwClient = speaker(async () => { throw new Error('offline') })
    const throwResult = await new AnimeFixedTtsExecutor(throwClient).executeAction({
      eventId: 'throw', seat: 1, characterId: 'grok', action: 'robbed-kong-win',
    })
    expect(throwResult).toMatchObject({ status: 'failed', fallbackAudioFile: 'hu.mp3' })
  })

  it('主音色失败后尝试角色合同中的替代音色', async () => {
    const client = speaker(async (...args) => args[2] === 'default')
    const result = await new AnimeFixedTtsExecutor(client).executeAction({
      eventId: 'voice-fallback', seat: 0, characterId: 'qwen', action: 'peng',
    })

    expect(result).toMatchObject({ status: 'played', fallbackAudioFile: null })
    expect(client.speak).toHaveBeenCalledTimes(2)
    expect(client.speak.mock.calls.map((args) => args[2])).toEqual(['qwen', 'default'])
  })

  it('主音色已经 audible 后即使媒体尾部失败也不再补播替代或通用人声', async () => {
    const client = speaker(async (...args) => {
      args[5]?.onStarted?.()
      return false
    })
    const result = await new AnimeFixedTtsExecutor(client).executeAction({
      eventId: 'audible-primary', seat: 0, characterId: 'qwen', action: 'peng',
    })

    expect(result).toMatchObject({ status: 'played', fallbackAudioFile: null })
    expect(client.speak).toHaveBeenCalledTimes(1)
  })

  it('动作合成超过等待上限会门控过期播放并回退通用人声', async () => {
    vi.useFakeTimers()
    try {
      const pending = deferred<boolean>()
      const client = speaker(() => pending.promise)
      const execution = new AnimeFixedTtsExecutor(client).executeAction({
        eventId: 'action-timeout', seat: 0, characterId: 'deepseek', action: 'chi',
      })
      await vi.advanceTimersByTimeAsync(901)

      await expect(execution).resolves.toMatchObject({
        status: 'failed', fallbackAudioFile: 'chi.mp3',
      })
      expect(client.cancel).not.toHaveBeenCalled()
      pending.resolve(false)
      await Promise.resolve()
      await Promise.resolve()
      expect(client.speak).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('媒体开始播放后停止合成等待计时，不截断中点或整句播放', async () => {
    vi.useFakeTimers()
    try {
      const pending = deferred<boolean>()
      const client = speaker((...args) => {
        args[5]?.onStarted?.()
        return pending.promise
      })
      const execution = new AnimeFixedTtsExecutor(client).executeAction({
        eventId: 'playing-before-deadline', seat: 0, characterId: 'deepseek', action: 'peng',
      })
      let settled = false
      void execution.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(settled).toBe(false)

      pending.resolve(true)
      await expect(execution).resolves.toMatchObject({ status: 'played' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('固定文字钩子先于播放触发且失败不影响语音', async () => {
    const onLine = vi.fn(() => { throw new Error('bubble unavailable') })
    const client = speaker()
    const result = await new AnimeFixedTtsExecutor(client, { onLine }).executeAction({
      eventId: 'line-hook', seat: 2, characterId: 'gpt', action: 'discard-gang',
    })

    expect(result.status).toBe('played')
    expect(onLine).toHaveBeenCalledOnce()
    expect(onLine.mock.invocationCallOrder[0]).toBeLessThan(client.speak.mock.invocationCallOrder[0])
  })

  it('相同事件并发单飞，完成后重复事件不重播', async () => {
    const pending = deferred<boolean>()
    const client = speaker(() => pending.promise)
    const executor = new AnimeFixedTtsExecutor(client)
    const event = { eventId: 'evt-1', seat: 3 as const, characterId: 'muse', action: 'peng' as const }

    const first = executor.executeAction(event)
    const concurrent = executor.executeAction(event)
    expect(concurrent).toBe(first)
    expect(client.speak).toHaveBeenCalledTimes(1)
    pending.resolve(true)
    await expect(first).resolves.toMatchObject({ status: 'played' })

    await expect(executor.executeAction(event)).resolves.toMatchObject({
      status: 'duplicate',
      fallbackAudioFile: null,
    })
    expect(client.speak).toHaveBeenCalledTimes(1)
  })

  it('cancel 立即放行悬挂播放且不要求通用声音回退', async () => {
    const pending = deferred<boolean>()
    const client = speaker(() => pending.promise)
    const executor = new AnimeFixedTtsExecutor(client)
    const execution = executor.executeAction({
      eventId: 'cancel-me', seat: 0, characterId: 'deepseek', action: 'chi',
    })

    executor.cancel()

    await expect(execution).resolves.toMatchObject({
      status: 'cancelled',
      fallbackAudioFile: null,
    })
    expect(client.cancel).not.toHaveBeenCalled()
  })

  it('赛后顺序为赢家起顺时针，流局按固定座位顺序', () => {
    expect(animeRoundSpeechOrder(2)).toEqual([2, 3, 0, 1])
    expect(animeRoundSpeechOrder(0)).toEqual([0, 1, 2, 3])
    expect(animeRoundSpeechOrder(null, true)).toEqual([0, 1, 2, 3])
    expect(animeRoundSpeechOrder(8)).toEqual([0, 1, 2, 3])

    expect(animeResultVoiceKeyForSeat(2, 2, 'self-draw')).toBe('win-self-draw')
    expect(animeResultVoiceKeyForSeat(2, 2, 'discard')).toBe('win-discard')
    expect(animeResultVoiceKeyForSeat(2, 2, 'robbed-kong-win')).toBe('win-robbed-kong')
    expect(animeResultVoiceKeyForSeat(3, 2, 'self-draw')).toBe('loss')
    expect(animeResultVoiceKeyForSeat(2, null, 'self-draw', true)).toBe('draw')
  })

  it('赛后四家严格串行、赢家先说，且每句等待播放完成', async () => {
    let active = 0
    let maxActive = 0
    const calls: Array<{ seat: number; text: string; hooks: LlmAudioPlaybackHooks | undefined }> = []
    const client = speaker(async (seat, text, _voice, _style, _priority, hooks) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      calls.push({ seat, text, hooks })
      await Promise.resolve()
      active -= 1
      return true
    })
    const executor = new AnimeFixedTtsExecutor(client)

    const result = await executor.executeRound({
      eventId: 'round-1',
      characterIds: ['deepseek', 'qwen', 'grok', 'muse'],
      winnerIndex: 2,
      winType: 'discard',
    })

    expect(result.status).toBe('completed')
    expect(result.order).toEqual([2, 3, 0, 1])
    expect(result.items.map(({ status }) => status)).toEqual(['played', 'played', 'played', 'played'])
    expect(calls.map(({ seat }) => seat)).toEqual([2, 3, 0, 1])
    expect(calls[0]?.text).toBe('送牌这么客气,那我收下啦!')
    expect(calls.slice(1).map(({ text }) => text)).toEqual([
      '这一曲有遗憾,下局再写。',
      '这局没吃饱,下局再来!',
      '胜负寻常,我会再算一局。',
    ])
    expect(calls.every(({ hooks }) => (
      hooks?.waitForCompletion === true
      && typeof hooks.cacheIdentity === 'string'
      && typeof hooks.isCurrent === 'function'
      && typeof hooks.onStarted === 'function'
    ))).toBe(true)
    expect(maxActive).toBe(1)
  })

  it('赛后单句失败不抛错也不中断其余三家', async () => {
    let calls = 0
    const client = speaker(async () => {
      calls += 1
      if (calls === 1) throw new Error('gateway offline')
      return calls > 4
    })
    const executor = new AnimeFixedTtsExecutor(client)

    await expect(executor.executeRound({
      eventId: 'round-errors',
      characterIds: [],
      winnerIndex: null,
      draw: true,
    })).resolves.toMatchObject({
      status: 'completed',
      order: [0, 1, 2, 3],
      items: [
        { status: 'failed', fallbackAudioFile: null },
        { status: 'failed', fallbackAudioFile: null },
        { status: 'played' },
        { status: 'played' },
      ],
    })
    expect(client.speak).toHaveBeenCalledTimes(6)
  })

  it('赛后队列可立即取消，并对相同结算事件单飞和去重', async () => {
    const pending = deferred<boolean>()
    const client = speaker(() => pending.promise)
    const executor = new AnimeFixedTtsExecutor(client)
    const options = {
      eventId: 'round-cancel',
      characterIds: ['deepseek', 'qwen', 'gpt', 'claude'],
      winnerIndex: 1,
      winType: 'self-draw' as const,
    }

    const first = executor.executeRound(options)
    const concurrent = executor.executeRound(options)
    expect(concurrent).toBe(first)
    executor.cancel()

    await expect(first).resolves.toMatchObject({
      status: 'cancelled',
      order: [1, 2, 3, 0],
      items: [{ status: 'cancelled' }],
    })
    expect(client.speak).toHaveBeenCalledTimes(1)
    await expect(executor.executeRound(options)).resolves.toMatchObject({
      status: 'duplicate',
      items: [],
    })
  })

  it('reset 取消旧表现并允许新会话复用相同事件 ID', async () => {
    const client = speaker()
    const executor = new AnimeFixedTtsExecutor(client)
    const event = { eventId: 1, seat: 0 as const, characterId: 'deepseek', action: 'discard-win' as const }

    await executor.executeAction(event)
    await expect(executor.executeAction(event)).resolves.toMatchObject({ status: 'duplicate' })
    executor.reset()
    await expect(executor.executeAction(event)).resolves.toMatchObject({ status: 'played' })
    expect(client.speak).toHaveBeenCalledTimes(2)
  })
})
