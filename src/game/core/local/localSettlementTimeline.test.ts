import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GamePlayer } from '../contracts/types'
import { WIN_EFFECT_DURATION, WIN_EFFECT_SOUND_DELAY, WIN_REVEAL_DURATION } from '../presentation/winEffect'
import { DISCARD_WIN_EFFECT_DELAY } from '../../shared/settlement/settlementTimeline'
import { createLocalGameState } from './localGameState'
import { createLocalSettlementTimeline } from './localSettlementTimeline'
import { registerLocalLlmVoiceSeat, resetLocalLlmVoiceRegistryForTests } from '../presentation/localLlmVoiceRegistry'

function player(seat: number, hand: GamePlayer['hand'] = []): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: hand.length - 1,
  }
}

afterEach(() => resetLocalLlmVoiceRegistryForTests())

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
    expect(state.players[1].discards).toEqual([])
    expect(state.lastDiscard.value).toBeNull()
    expect(state.winEffect.value).toMatchObject({ winnerIndex: 0, tile: 'm9' })
    expect(state.winPresentation.value).toMatchObject({ discardWin: true, tile: 'm9' })
    expect(playSound).toHaveBeenCalledWith('hu.mp3')
  })

  it('LLM 赢家用策略台词替代胡牌人声，但保留胡牌特效音', () => {
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

    expect(announce).toHaveBeenCalledWith('自摸。')
    expect(playSound).not.toHaveBeenCalledWith('zimo.mp3')
    scheduled.find((item) => item.delay === WIN_EFFECT_SOUND_DELAY)!.callback()
    expect(playSound).toHaveBeenCalledWith('hu_effect_sound.mp3', 0.72)
  })

  it('allows a headless online engine to bypass the single-player LLM voice registry', () => {
    const state = createLocalGameState()
    state.phase.value = 'thinking'
    state.players.push(
      player(0),
      player(1, ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p2', 'p3', 'p4', 's2', 's3', 's4', 'east', 'east']),
      player(2), player(3),
    )
    const leakedSinglePlayerAnnouncement = vi.fn()
    registerLocalLlmVoiceSeat(1, '高冷', leakedSinglePlayerAnnouncement)
    const onlineAnnouncement = vi.fn(() => false)
    const timeline = createLocalSettlementTimeline({
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

    timeline.endGame(1)

    expect(onlineAnnouncement).toHaveBeenCalledWith(1, 'self-draw')
    expect(leakedSinglePlayerAnnouncement).not.toHaveBeenCalled()
  })
})
