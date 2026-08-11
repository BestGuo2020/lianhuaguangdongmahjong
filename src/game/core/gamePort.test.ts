import { isRef } from 'vue'
import { describe, expect, it } from 'vitest'
import { GAME_PORT_ACTION_KEYS, GAME_PORT_STATE_KEYS, type GamePort } from './gamePort'
import { useGame } from './useGame'
import { useRemoteGame } from '../online/useRemoteGame'

function assertCompileTimeContract<T extends GamePort>(port: T): T {
  return port
}

describe.each([
  ['local', () => useGame()],
  ['remote', () => useRemoteGame()],
] as const)('GamePort contract: %s adapter', (_name, createGame) => {
  it('exposes every shared state container', () => {
    const game = assertCompileTimeContract(createGame())

    for (const key of GAME_PORT_STATE_KEYS) {
      expect(game, `missing state: ${key}`).toHaveProperty(key)
      if (key === 'players') expect(Array.isArray(game[key])).toBe(true)
      else expect(isRef(game[key]), `state is not ref-like: ${key}`).toBe(true)
    }
  })

  it('exposes every shared action', () => {
    const game = assertCompileTimeContract(createGame())

    for (const key of GAME_PORT_ACTION_KEYS) {
      expect(typeof game[key], `action is not callable: ${key}`).toBe('function')
    }
  })
})
