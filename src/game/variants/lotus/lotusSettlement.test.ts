import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../../core/contracts/types'
import { registerLocalLlmVoiceSeat, resetLocalLlmVoiceRegistryForTests } from '../../core/presentation/localLlmVoiceRegistry'
import { createLotusGameState } from './lotusState'
import { createLotusSettlement } from './lotusSettlement'

function player(seat: number, hand: GamePlayer['hand'] = []): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: hand.length - 1,
  }
}

afterEach(() => resetLocalLlmVoiceRegistryForTests())

describe('lotusSettlement LLM voice isolation', () => {
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
