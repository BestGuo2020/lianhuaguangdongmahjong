import type { EndGameOptions, TileType } from '../contracts/types'
import { createWall, shuffle, sortTiles } from '../rules/tiles'
import type { LocalGameState } from './localGameState'

interface LocalDebugScenariosOptions {
  state: LocalGameState
  clearTimers(): void
  resetPlayers(): void
  announce(text: string, tone?: string): void
  endGame(winnerIndex: number, options?: EndGameOptions): unknown
  beginTurn(playerIndex: number): unknown
}

export function createLocalDebugScenarios(options: LocalDebugScenariosOptions) {
  const { state } = options

  function ensurePlayers() {
    options.clearTimers()
    if (state.players.length !== 4) options.resetPlayers()
  }

  function resetPresentation() {
    state.lastDiscard.value = null
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.matchFinished.value = false
    state.actionPrompt.value = null
  }

  function seedOpponents() {
    for (let index = 1; index < 4; index += 1) {
      const opponent = state.players[index]
      opponent.hand.splice(0, opponent.hand.length,
        'm4', 'm5', 'm6', 'p1', 'p2', 'p3', 's1', 's2', 's3', 's4', 's5', 's6', 's7')
      opponent.melds.splice(0)
      opponent.discards.splice(0)
      opponent.drawnTileIndex = -1
    }
  }

  function debugPreviewWin(winnerIndex = 0, { robbedKong = false } = {}) {
    if (!import.meta.env.DEV) return
    ensurePlayers()
    const baseHand: TileType[] = [
      'm1', 'm1', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6',
      's7', 's7', 's7', 'east', 'east',
    ]
    state.players.forEach((player, index) => {
      const hand = [...baseHand]
      if (index === winnerIndex && !robbedKong) hand.push('east')
      player.hand.splice(0, player.hand.length, ...hand)
      player.discards.splice(0)
      player.melds.splice(0)
      player.score = 1000
      player.drawnTileIndex = index === winnerIndex && !robbedKong ? hand.length - 1 : -1
    })
    const robbedKongPlayerIndex = robbedKong ? (winnerIndex + 3) % 4 : -1
    if (robbedKong) {
      state.players[robbedKongPlayerIndex].melds.push({
        type: 'gang', added: true, pending: true, tile: 'east',
        from: (robbedKongPlayerIndex + 1) % 4,
        tiles: ['east', 'east', 'east', 'east'],
      })
    }
    state.wall.value = shuffle(createWall())
    resetPresentation()
    state.phase.value = 'discard'
    options.endGame(winnerIndex, { robbedKong, robbedKongPlayerIndex, winTile: 'east' })
  }

  function debugPreviewKong(mode: 'concealed' | 'added' | 'both' = 'both') {
    if (!import.meta.env.DEV) return
    ensurePlayers()
    const player = state.players[0]
    player.score = 1000
    player.discards.splice(0)
    player.melds.splice(0)
    player.drawnTileIndex = -1
    player.redCount = 0
    const hands: Record<typeof mode, TileType[]> = {
      concealed: ['m1', 'm1', 'm1', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'west'],
      added: ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east', 'west', 'west', 'north'],
      both: ['m2', 'm2', 'm2', 'm2', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east', 'west', 'm1'],
    }
    player.hand.splice(0, player.hand.length, ...hands[mode])
    player.hand = sortTiles(player.hand)
    if (mode !== 'concealed') {
      player.melds.push({ type: 'peng', tile: 'm1', from: 1, tiles: ['m1', 'm1', 'm1'] })
    }
    seedOpponents()
    state.wall.value = shuffle(createWall())
    state.wallHeadDrawn.value = 0
    resetPresentation()
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: state.dealAnimation.value.serial + 1 }
    state.openingStage.value = null
    state.currentPlayer.value = 0
    state.phase.value = 'discard'
    state.userDrewThisTurn.value = true
    state.selectedIndex.value = -1
    options.announce(
      mode === 'concealed' ? '测试：可暗杠' : mode === 'added' ? '测试：可补杠' : '测试：暗杠/补杠并存',
      'red',
    )
  }

  function debugPreviewFourRed() {
    if (!import.meta.env.DEV) return
    ensurePlayers()
    const player = state.players[0]
    player.score = 1000
    player.discards.splice(0)
    player.melds.splice(0)
    player.redCount = 3
    player.drawnTileIndex = -1
    for (let index = 0; index < 3; index += 1) {
      player.melds.push({ type: 'flower', tile: 'red', tiles: ['red'] })
    }
    player.hand.splice(0, player.hand.length,
      'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east', 'west', 'west')
    seedOpponents()
    state.wall.value = shuffle(createWall())
    const redIndex = state.wall.value.indexOf('red')
    if (redIndex > 0) {
      const head = state.wall.value[0]
      state.wall.value[0] = 'red'
      state.wall.value[redIndex] = head
    }
    state.wallHeadDrawn.value = 0
    resetPresentation()
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: state.dealAnimation.value.serial + 1 }
    state.openingStage.value = null
    state.currentPlayer.value = 0
    state.phase.value = 'drawing'
    options.announce('测试：摸第 4 张红中 → 四红中胡牌', 'red')
    void options.beginTurn(0)
  }

  return { debugPreviewWin, debugPreviewKong, debugPreviewFourRed }
}
