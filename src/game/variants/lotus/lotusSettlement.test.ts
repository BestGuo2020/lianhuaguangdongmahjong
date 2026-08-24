import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../../core/contracts/types'
import { registerLocalLlmVoiceSeat, resetLocalLlmVoiceRegistryForTests } from '../../core/presentation/localLlmVoiceRegistry'
import { createLotusGameState } from './lotusState'
import { createLotusSettlement } from './lotusSettlement'
import { WIN_EFFECT_SOUND_DELAY } from '../../core/presentation/winEffect'

function player(seat: number, hand: GamePlayer['hand'] = []): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: hand.length - 1,
  }
}

afterEach(() => resetLocalLlmVoiceRegistryForTests())

describe('lotusSettlement LLM voice isolation', () => {
  it('LLM 赢家用策略台词替代胡牌人声，但保留胡牌特效音', () => {
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

    expect(announce).toHaveBeenCalledTimes(1)
    expect(playSound).not.toHaveBeenCalledWith('zimo.mp3')
    scheduled.find((item) => item.delay === WIN_EFFECT_SOUND_DELAY)!.callback()
    expect(playSound).toHaveBeenCalledWith('hu_effect_sound.mp3', 0.72)
  })

  it('does not let the single-player registry announce a human win in a headless online game', () => {
    const state = createLotusGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0),
      player(1, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east']),
      player(2), player(3),
    )
    const leakedSinglePlayerAnnouncement = vi.fn()
    registerLocalLlmVoiceSeat(1, '高冷', leakedSinglePlayerAnnouncement)
    const onlineAnnouncement = vi.fn(() => false)
    const settlement = createLotusSettlement({
      state,
      clearTimers: vi.fn(),
      later: vi.fn(() => 1),
      playSound: vi.fn(),
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东一局',
      isLlmVoiceSeat: () => false,
      announceLlmWin: onlineAnnouncement,
    })

    settlement.endGame(1, { selfDraw: true })

    expect(onlineAnnouncement).toHaveBeenCalledWith(1, 'self-draw')
    expect(leakedSinglePlayerAnnouncement).not.toHaveBeenCalled()
  })
})
