import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ActionPrompt } from '../../core/contracts/gamePort'
import type { TileType } from '../../core/contracts/types'
import { LotusHumanController } from './lotusControllers'

function createHumanController() {
  const actionPrompt = ref<ActionPrompt | null>(null)
  const controller = new LotusHumanController({
    isTurn: ref(false),
    canHu: ref(false),
    canKong: ref<TileType[]>([]),
    canWindKong: ref(false),
    actionPrompt,
    selectedIndex: ref(-1),
    drawnThisTurn: ref(false),
    turnSeconds: ref(0),
    activateTurn: vi.fn(),
    activateHu: vi.fn(),
    activateClaim: vi.fn(),
    activateChi: vi.fn(),
    activateRobKong: vi.fn(),
    deactivate: vi.fn(),
  })
  return { controller, actionPrompt }
}

describe('莲花麻将组合响应', () => {
  it('同一张弃牌可胡、碰、杠、吃时一次暴露全部选项', async () => {
    const { controller, actionPrompt } = createHumanController()
    const chiOptions = [
      { kind: 'sequence' as const, tiles: ['m3', 'm4', 'm5'] as TileType[] },
      { kind: 'sequence' as const, tiles: ['m4', 'm5', 'm6'] as TileType[] },
    ]
    const response = controller.requestDiscardHu({
      hand: [], exposedMelds: 0, tile: 'm5', from: 3, dihu: false, jokers: [],
      canPeng: true, canGang: true, chiOptions,
    })

    expect(actionPrompt.value).toEqual({
      type: 'response', tile: 'm5', from: 3,
      canHu: true, canPeng: true, canGang: true, chiOptions,
    })
    controller.resolveHu({ kind: 'chi', meld: chiOptions[1] })
    await expect(response).resolves.toEqual({ kind: 'chi', meld: chiOptions[1] })
  })
})
