import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../contracts/types'
import { WIN_EFFECT_DURATION, WIN_REVEAL_DURATION } from '../presentation/winEffect'
import { createLocalGameState } from './localGameState'
import { createLocalSettlementTimeline } from './localSettlementTimeline'

function player(seat: number, hand: GamePlayer['hand'] = []): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: hand.length - 1,
  }
}

describe('localSettlementTimeline', () => {
  it('keeps win effect, reveal, and final scoring as ordered phases', () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east']),
      player(1), player(2), player(3),
    )
    state.wall.value = ['m1', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 'p4']
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    const timeline = createLocalSettlementTimeline({
      state,
      clearTimers: vi.fn(),
      later: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      playSound: vi.fn(),
      showTableAction: vi.fn(),
      structuralMeldCount: () => 0,
      getRoundLabel: () => '东1局',
    })

    timeline.endGame(0)
    expect(state.phase.value).toBe('win-effect')
    expect(state.winPresentation.value).toMatchObject({ winnerIndex: 0, tile: 'east' })

    scheduled.find((item) => item.delay === WIN_EFFECT_DURATION)!.callback()
    expect(state.phase.value).toBe('revealing')

    scheduled.find((item) => item.delay === WIN_REVEAL_DURATION)!.callback()
    expect(state.phase.value).toBe('settled')
    expect(state.result.value).toMatchObject({ winnerIndex: 0, roundLabel: '东1局' })
    expect(state.result.value?.scoreChanges).toHaveLength(4)
  })
})
