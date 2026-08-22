import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TileType } from '../../core/contracts/types'
import { createTileFlowExecutor, takeStackTailTile } from './tileFlowExecutor'
import { registerLocalLlmVoiceSeat, resetLocalLlmVoiceRegistryForTests } from '../../core/presentation/localLlmVoiceRegistry'

afterEach(() => resetLocalLlmVoiceRegistryForTests())

describe('杠后尾墙补摸', () => {
  it('广麻连续补摸按尾墩上层、下层、前一墩上层、下层', () => {
    const wall = Array.from({ length: 136 }, (_, index) => `m${index}` as TileType)
    expect(takeStackTailTile(wall, 0, 136)).toBe('m134')
    expect(takeStackTailTile(wall, 0, 136)).toBe('m135')
    expect(takeStackTailTile(wall, 0, 136)).toBe('m132')
    expect(takeStackTailTile(wall, 0, 136)).toBe('m133')
  })

  it('牌头牌尾交汇时不保留牌，最后一张仍可补摸', () => {
    const wall = ['m1'] as TileType[]
    expect(takeStackTailTile(wall, 135, 136)).toBe('m1')
    expect(wall).toEqual([])
  })

  it('单机 LLM 出牌保留落牌声，但不播放牌名人声', () => {
    const playSound = vi.fn()
    const routeDiscard = vi.fn()
    const state = {
      players: [{
        name: 'P0', avatar: '', score: 1000, seat: 0,
        hand: ['m1'] as TileType[], discards: [], melds: [], redCount: 0, drawnTileIndex: 0,
      }],
      wall: { value: [] as TileType[] }, wallHeadDrawn: { value: 0 },
      phase: { value: 'thinking' as const }, lastDiscard: { value: null },
      lastDiscardSound: { value: null },
    }
    registerLocalLlmVoiceSeat(0, '稳健', () => {})
    const executor = createTileFlowExecutor({
      state,
      controllers: [{}],
      getTurnFlow: () => ({ markDrawSource: vi.fn(), clearDrawSource: vi.fn(), routeDiscard }),
      endDraw: vi.fn(), playSound, playSoundAndWait: vi.fn(async () => {}),
      later: vi.fn(() => 1), stopCountdown: vi.fn(),
    })

    executor.discardTile(0, 0)

    expect(playSound).toHaveBeenCalledTimes(1)
    expect(playSound).toHaveBeenCalledWith('dapai.mp3', 0.8)
    expect(state.lastDiscardSound.value).toBeInstanceOf(Promise)
    expect(routeDiscard).toHaveBeenCalledWith(0, 'm1')
  })
})
