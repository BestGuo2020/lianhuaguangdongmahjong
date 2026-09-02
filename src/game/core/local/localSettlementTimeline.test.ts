import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EndGameOptions, GamePlayer } from '../contracts/types'
import { WIN_CUE_EXIT_DURATION, WIN_CUE_LEAD_DURATION, WIN_EFFECT_DURATION, WIN_EFFECT_SOUND_DELAY, WIN_REVEAL_DURATION } from '../presentation/winEffect'
import { DISCARD_WIN_EFFECT_DELAY } from '../../shared/settlement/settlementTimeline'
import { createLocalGameState } from './localGameState'
import { createLocalSettlementTimeline } from './localSettlementTimeline'
import {
  announceLocalLlmRoundReactions,
  registerLocalLlmVoiceSeat,
  resetLocalLlmVoiceRegistryForTests,
} from '../presentation/localLlmVoiceRegistry'
import { AnimeFixedTtsExecutor } from '../../llm/animeFixedTtsExecutor'

function player(seat: number, hand: GamePlayer['hand'] = []): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: hand.length - 1,
  }
}

afterEach(() => resetLocalLlmVoiceRegistryForTests())

async function flushPromises() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function startWinEffect(scheduled: Array<{ callback: () => void; delay: number }>) {
  scheduled.find((item) => item.delay === WIN_CUE_LEAD_DURATION + WIN_CUE_EXIT_DURATION)!.callback()
}

describe('localSettlementTimeline', () => {
  it('rejects a non-winning settlement request even when a caller bypasses the turn orchestrator', () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(player(0, ['m1']), player(1), player(2), player(3))
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: vi.fn(),
      later: vi.fn(),
      playSound: vi.fn(),
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '��һ��',
    })

    timeline.endGame(0)

    expect(state.phase.value).toBe('thinking')
    expect(state.result.value).toBeNull()
  })

  it('keeps win cue, Three.js effect, reveal, and final scoring as ordered phases', () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east']),
      player(1), player(2), player(3),
    )
    state.wall.value = ['m1', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 'p4']
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const showTableAction = vi.fn()
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: vi.fn(),
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound: vi.fn(),
      showTableAction,
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东1局',
    })

    timeline.endGame(0)
    expect(state.phase.value).toBe('win-effect')
    expect(state.winPresentation.value).toMatchObject({ winnerIndex: 0, tile: 'east' })
    expect(state.winEffect.value).toBeNull()
    expect(showTableAction).toHaveBeenCalledWith('self-draw', 0, null, 'east', -1)

    startWinEffect(scheduled)
    expect(state.winEffect.value).toMatchObject({ winnerIndex: 0, tile: 'east' })
    scheduled.find((item) => item.delay === WIN_EFFECT_DURATION)!.callback()
    expect(state.phase.value).toBe('revealing')

    scheduled.find((item) => item.delay === WIN_REVEAL_DURATION)!.callback()
    expect(state.phase.value).toBe('settled')
    expect(state.result.value).toMatchObject({ winnerIndex: 0, roundLabel: '东1局' })
    expect(state.result.value?.scoreChanges).toHaveLength(4)
  })

  it('llmAnime 等四家固定发言结束后才打开结算', async () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      { ...player(0, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east']), characterId: 'deepseek', playerKind: 'human' },
      { ...player(1), characterId: 'qwen', playerKind: 'bot' },
      { ...player(2), characterId: 'gpt', playerKind: 'llm' },
      { ...player(3), characterId: 'claude', playerKind: 'bot' },
    )
    state.wall.value = ['m1', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 'p4']
    let finishRound!: (value: any) => void
    const pending = new Promise<any>((resolve) => { finishRound = resolve })
    const executor = new AnimeFixedTtsExecutor({ speak: vi.fn(async () => true), cancel: vi.fn() })
    const executeRound = vi.spyOn(executor, 'executeRound').mockReturnValue(pending)
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: vi.fn(),
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound: vi.fn(),
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东1局',
      getThemeName: () => 'llmAnime',
      animeFixedTts: executor,
    })

    timeline.endGame(0)
    startWinEffect(scheduled)
    scheduled.find((item) => item.delay === WIN_EFFECT_DURATION)!.callback()
    scheduled.find((item) => item.delay === WIN_REVEAL_DURATION)!.callback()
    expect(state.phase.value).toBe('revealing')
    expect(state.result.value).toBeNull()
    expect(executeRound).toHaveBeenCalledWith(expect.objectContaining({
      characterIds: ['deepseek', 'qwen', 'gpt', 'claude'],
      winnerIndex: 0,
      winType: 'self-draw',
    }))
    finishRound({ status: 'completed', order: [0, 1, 2, 3], items: [] })
    await flushPromises()
    expect(state.phase.value).toBe('settled')
    expect(state.result.value?.winnerIndex).toBe(0)
  })

  it('waits for the discarded tile voice, then starts point-ron audio and win effect together', async () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 'east', 'east', 'm7', 'm8']),
      { ...player(1), discards: ['m9'] }, player(2), player(3),
    )
    state.lastDiscard.value = { tile: 'm9', from: 1, id: 7 }
    let finishDiscardSound!: () => void
    state.lastDiscardSound.value = new Promise<void>((resolve) => { finishDiscardSound = resolve })
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const playSound = vi.fn()
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: vi.fn(),
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound,
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东一局',
    })

    timeline.endGame(0, { winTile: 'm9', sourceFrom: 1 })

    expect(state.players[1].discards).toEqual(['m9'])
    expect(state.players[0].hand).not.toContain('m9')
    expect(state.lastDiscard.value).toMatchObject({ tile: 'm9', from: 1 })
    expect(state.winEffect.value).toBeNull()
    expect(scheduled).toHaveLength(0)
    expect(state.winEffect.value).toBeNull()

    finishDiscardSound()
    await Promise.resolve()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].delay).toBe(DISCARD_WIN_EFFECT_DELAY)
    scheduled[0].callback()
    startWinEffect(scheduled)
    expect(state.players[1].discards).toEqual([])
    expect(state.lastDiscard.value).toBeNull()
    expect(state.winEffect.value).toMatchObject({ winnerIndex: 0, tile: 'm9' })
    expect(state.winPresentation.value).toMatchObject({ discardWin: true, tile: 'm9' })
    expect(playSound).toHaveBeenCalledWith('hu.mp3')
  })

  it('LLM 赢家在胡牌成立后立即启动策略感言，并保留胡牌特效音', async () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0),
      player(1, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east']),
      player(2), player(3),
    )
    const announce = vi.fn()
    registerLocalLlmVoiceSeat(1, '高冷', announce)
    const playSound = vi.fn()
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: vi.fn(),
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound,
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东一局',
    })

    timeline.endGame(1)

    await flushPromises()
    expect(announce).toHaveBeenCalledWith('自摸，意料之中。')
    expect(playSound).not.toHaveBeenCalledWith('zimo.mp3')
    startWinEffect(scheduled)
    scheduled.find((item) => item.delay === WIN_EFFECT_SOUND_DELAY)!.callback()
    expect(playSound).toHaveBeenCalledWith('hu_effect_sound.mp3', 0.72)
    scheduled.find((item) => item.delay === WIN_EFFECT_DURATION)!.callback()
    scheduled.find((item) => item.delay === WIN_REVEAL_DURATION)!.callback()
    await flushPromises()
    expect(state.phase.value).toBe('settled')
  })

  it.each([
    ['self-draw', {} as EndGameOptions, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east'] as GamePlayer['hand']],
    ['discard-win', { sourceFrom: 2, winTile: 'east' } as EndGameOptions, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east'] as GamePlayer['hand']],
    ['robbed-kong-win', { robbedKong: true, robbedKongPlayerIndex: 2, winTile: 'east' } as EndGameOptions, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east'] as GamePlayer['hand']],
  ] as const)('胡牌成立后立即启动 %s 赛后感言，完成后放行结算', async (expectedType, endOptions, hand) => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0), player(1, [...hand]),
      { ...player(2), discards: ['east'] }, player(3),
    )
    const order: string[] = []
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: () => { order.push('clear') },
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound: vi.fn(),
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东一局',
      isLlmVoiceSeat: () => true,
      announceLlmRoundReactions: ({ winnerIndex, winType }) => {
        order.push(`announce:${winnerIndex}:${winType}`)
      },
    })

    timeline.endGame(1, endOptions)

    expect(order).toEqual(['clear', `announce:1:${expectedType}`])
    await flushPromises()
    scheduled.find((item) => item.delay === DISCARD_WIN_EFFECT_DELAY)?.callback()
    startWinEffect(scheduled)
    scheduled.find((item) => item.delay === WIN_EFFECT_DURATION)!.callback()
    scheduled.find((item) => item.delay === WIN_REVEAL_DURATION)!.callback()
    await flushPromises()
    expect(order).toEqual(['clear', `announce:1:${expectedType}`])
    expect(state.phase.value).toBe('settled')
  })

  it('赢家先说、其余 AI 顺时针轮流说，真人不说且全部结束前不弹结算', async () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0), player(1),
      player(2, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east']),
      player(3),
    )
    const spoken: number[] = []
    const releases = new Map<number, () => void>()
    for (const seat of [1, 2, 3]) {
      registerLocalLlmVoiceSeat(seat, '高冷', async () => {
        spoken.push(seat)
        await new Promise<void>((resolve) => releases.set(seat, resolve))
      })
    }
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: vi.fn(),
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound: vi.fn(),
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东一局',
    })

    timeline.endGame(2)
    await flushPromises()
    expect(spoken).toEqual([2])
    expect(state.phase.value).toBe('win-effect')
    startWinEffect(scheduled)
    scheduled.find((item) => item.delay === WIN_EFFECT_DURATION)!.callback()
    scheduled.find((item) => item.delay === WIN_REVEAL_DURATION)!.callback()

    expect(state.phase.value).toBe('revealing')
    expect(state.result.value).toBeNull()
    releases.get(2)!()
    await flushPromises()
    expect(spoken).toEqual([2, 3])
    releases.get(3)!()
    await flushPromises()
    expect(spoken).toEqual([2, 3, 1])
    releases.get(1)!()
    await flushPromises()
    expect(state.phase.value).toBe('settled')
    expect(state.result.value?.winnerIndex).toBe(2)
  })

  it('真人获胜时真人不发言，只有三个 AI 依次发表失败感言', async () => {
    const spoken: Array<{ seat: number; text: string }> = []
    for (const seat of [1, 2, 3]) {
      registerLocalLlmVoiceSeat(seat, '高冷', (text) => { spoken.push({ seat, text }) })
    }

    await announceLocalLlmRoundReactions({ winnerIndex: 0, winType: 'self-draw' })

    expect(spoken.map((item) => item.seat)).toEqual([1, 2, 3])
    expect(spoken.every((item) => !item.text.includes('自摸'))).toBe(true)
    expect(new Set(spoken.map((item) => item.text)).size).toBe(3)

    spoken.splice(0)
    await announceLocalLlmRoundReactions({ winnerIndex: 0, winType: 'self-draw' })
    expect(new Set(spoken.map((item) => item.text)).size).toBe(3)
    expect(spoken.map((item) => item.text)).toEqual([
      '结果已定，下一局。',
      '一局而已，继续。',
      '这局输了，仅此而已。',
    ])
  })

  it('allows a headless online engine to bypass the single-player LLM voice registry', async () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0),
      player(1, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east']),
      player(2), player(3),
    )
    const leakedSinglePlayerAnnouncement = vi.fn()
    registerLocalLlmVoiceSeat(1, '高冷', leakedSinglePlayerAnnouncement)
    const onlineAnnouncement = vi.fn()
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: vi.fn(),
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound: vi.fn(),
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东一局',
      isLlmVoiceSeat: () => false,
      announceLlmRoundReactions: onlineAnnouncement,
    })

    timeline.endGame(1)

    expect(onlineAnnouncement).toHaveBeenCalledWith({ winnerIndex: 1, winType: 'self-draw' })
    startWinEffect(scheduled)
    scheduled.find((item) => item.delay === WIN_EFFECT_DURATION)!.callback()
    scheduled.find((item) => item.delay === WIN_REVEAL_DURATION)!.callback()
    await flushPromises()
    expect(onlineAnnouncement).toHaveBeenCalledTimes(1)
    expect(leakedSinglePlayerAnnouncement).not.toHaveBeenCalled()
  })
})
