import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createActiveGamePort, type GameMode } from './activeGamePort'
import { useGame } from '../local/useGame'

describe('ActiveGamePort', () => {
  it('switches every state read to the selected adapter without rebuilding consumers', () => {
    const mode = ref<GameMode>('local')
    const local = useGame()
    const remote = useGame()
    local.phase.value = 'drawing'
    remote.phase.value = 'thinking'
    local.currentPlayer.value = 1
    remote.currentPlayer.value = 3
    local.players.push({
      name: 'local', avatar: '', score: 1000, seat: 0,
      hand: [], discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
    })
    remote.players.push({
      name: 'remote', avatar: '', score: 1000, seat: 2,
      hand: [], discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
    })

    const active = createActiveGamePort(mode, () => local, remote)

    expect(active.phase.value).toBe('drawing')
    expect(active.currentPlayer.value).toBe(1)
    expect(active.players.value[0].name).toBe('local')

    mode.value = 'remote'
    expect(active.phase.value).toBe('thinking')
    expect(active.currentPlayer.value).toBe(3)
    expect(active.players.value[0].name).toBe('remote')
  })

  it('delegates actions at call time and preserves their arguments', () => {
    const mode = ref<GameMode>('local')
    const local = useGame()
    const remote = useGame()
    const localDiscard = vi.spyOn(local, 'userDiscard').mockImplementation(() => {})
    const remoteDiscard = vi.spyOn(remote, 'userDiscard').mockImplementation(() => {})
    const active = createActiveGamePort(mode, () => local, remote)

    active.userDiscard(4)
    expect(localDiscard).toHaveBeenCalledWith(4)
    expect(remoteDiscard).not.toHaveBeenCalled()

    mode.value = 'remote'
    active.userDiscard(7)
    expect(remoteDiscard).toHaveBeenCalledWith(7)
    expect(localDiscard).toHaveBeenCalledTimes(1)
  })

  it('only exposes the shared production contract', () => {
    const active = createActiveGamePort(ref<GameMode>('local'), () => useGame(), useGame())

    expect(active).not.toHaveProperty('debugPreviewKong')
    expect(active).not.toHaveProperty('humanController')
    expect(active).toHaveProperty('startGame')
    expect(active).toHaveProperty('players')
  })
})
