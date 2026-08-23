import { describe, expect, it } from 'vitest'
import type { GamePlayer } from '../../core/contracts/types'
import { resetLocalPlayers } from './localOpening'

describe('resetLocalPlayers', () => {
  it('copies the LLM identity flag from an AI seat seed and resets other seats', () => {
    const state = { players: [] as GamePlayer[] }
    resetLocalPlayers(state, undefined, [
      { name: '大肥鱼（稳健）', avatar: '/deepseek.png', isLlm: true },
      undefined,
      { name: '普通资料', avatar: '/normal.png' },
    ])

    expect(state.players[1]).toMatchObject({ name: '大肥鱼（稳健）', isLlm: true })
    expect(state.players[2].isLlm).toBe(false)
    expect(state.players[3].isLlm).toBe(false)
  })
})
