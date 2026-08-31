import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../../core/contracts/types'
import { registerLocalLlmVoiceSeat, resetLocalLlmVoiceRegistryForTests } from '../../core/presentation/localLlmVoiceRegistry'
import { createLotusGameState } from './lotusState'
import type { LotusEndGameOptions } from './lotusState'
import { createLotusSettlement } from './lotusSettlement'
import { WIN_CUE_EXIT_DURATION, WIN_CUE_LEAD_DURATION, WIN_EFFECT_DURATION, WIN_EFFECT_SOUND_DELAY, WIN_REVEAL_DURATION } from '../../core/presentation/winEffect'
import { DISCARD_WIN_EFFECT_DELAY } from '../../shared/settlement/settlementTimeline'

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

describe('lotusSettlement LLM voice isolation', () => {
  it('LLM 赢家在胡牌成立后立即启动策略感言，并保留胡牌特效音', async () => {
    const state = createLotusGameState()
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
    const settlement = createLotusSettlement({
      state,
      clearTimers: vi.fn(),
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound,
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东一局',
    })

    settlement.endGame(1, { selfDraw: true })

    await flushPromises()
    expect(announce).toHaveBeenCalledTimes(1)
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
    ['self-draw', { selfDraw: true } as LotusEndGameOptions, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east'] as GamePlayer['hand']],
    ['discard-win', { sourceFrom: 2, winTile: 'east' } as LotusEndGameOptions, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east'] as GamePlayer['hand']],
    ['robbed-kong-win', { robbedKong: true, robbedKongPlayerIndex: 2, winTile: 'east' } as LotusEndGameOptions, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east'] as GamePlayer['hand']],
  ] as const)('胡牌成立后立即启动 %s 赛后感言，完成后放行结算', async (expectedType, endOptions, hand) => {
    const state = createLotusGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0), player(1, [...hand]),
      { ...player(2), discards: ['east'] }, player(3),
    )
    const order: string[] = []
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const settlement = createLotusSettlement({
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

    settlement.endGame(1, endOptions)

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

  it('does not let the single-player registry announce a human win in a headless online game', async () => {
    const state = createLotusGameState()
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
    const settlement = createLotusSettlement({
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

    settlement.endGame(1, { selfDraw: true })

    expect(onlineAnnouncement).toHaveBeenCalledWith({ winnerIndex: 1, winType: 'self-draw' })
    startWinEffect(scheduled)
    scheduled.find((item) => item.delay === WIN_EFFECT_DURATION)!.callback()
    scheduled.find((item) => item.delay === WIN_REVEAL_DURATION)!.callback()
    await flushPromises()
    expect(onlineAnnouncement).toHaveBeenCalledTimes(1)
    expect(leakedSinglePlayerAnnouncement).not.toHaveBeenCalled()
  })
})
