import type { EndGameOptions, TileType } from '../contracts/types'
import type {
  ClaimContext,
  PlayerController,
  RobKongContext,
  TurnAction,
  TurnContext,
} from '../controllers/playerController'
import { performDiscardGang, performPeng, type ActionContext } from '../rules/actions'
import { canRobKong, matchingCount } from '../rules/rules'
import { PACE_MS } from './localGameConfig'
import type { LocalGameState } from './localGameState'
import { createTurnRunner, type TurnOptions } from '../../shared/runtime/turnRunner'

interface ClaimCandidate {
  playerIndex: number
  canGang: boolean
}

interface LocalTurnOrchestratorOptions {
  state: LocalGameState
  controllers: PlayerController[]
  tableContext: ActionContext
  structuralMeldCount(playerIndex: number): number
  drawFor(playerIndex: number, fromTail?: boolean): Promise<boolean>
  performConcealedKong(playerIndex: number, tile: TileType, options?: { noContinue?: boolean }): Promise<void>
  declareAddedKong(playerIndex: number, meldIndex: number, tile: TileType): void
  settleAddedKong(playerIndex: number): unknown
  discardTile(playerIndex: number, handIndex: number): unknown
  endDraw(): unknown
  endGame(winnerIndex: number, options?: EndGameOptions): unknown
  announce(text: string, tone?: string): void
  later(callback: () => void, delay: number): number
}

export function createLocalTurnOrchestrator(options: LocalTurnOrchestratorOptions) {
  const { state } = options
  let runner!: ReturnType<typeof createTurnRunner<LocalGameState, PlayerController, TurnAction>>

  function hasSettled() {
    return runner.hasSettled()
  }

  function beginTurn(playerIndex: number, turnOptions: TurnOptions = {}) {
    return runner.beginTurn(playerIndex, turnOptions)
  }

  function seatDistance(from: number, to: number) {
    return (to - from + state.players.length) % state.players.length
  }

  function findClaims(from: number, tile: TileType): ClaimCandidate[] {
    if (tile === 'white' || tile === 'red') return []
    return state.players
      .map((player, playerIndex) => ({
        playerIndex,
        count: matchingCount(player.hand, tile),
        distance: seatDistance(from, playerIndex),
      }))
      .filter(({ playerIndex, count }) => playerIndex !== from && count >= 2)
      .sort((a, b) => a.distance - b.distance)
      .map(({ playerIndex, count }) => ({ playerIndex, canGang: count >= 3 }))
  }

  function routeDiscard(from: number, tile: TileType) {
    const claimants = findClaims(from, tile)
    if (claimants.length) {
      void offerNextClaim(claimants, tile, from)
      return
    }
    options.later(() => { void beginTurn((from + 1) % state.players.length) }, PACE_MS.afterDiscardToNextTurn)
  }

  async function offerNextClaim(claimants: ClaimCandidate[], tile: TileType, from: number) {
    const [claimant, ...remainingClaims] = claimants
    if (!claimant) {
      options.later(() => { void beginTurn((from + 1) % state.players.length) }, PACE_MS.afterDiscardToNextTurn)
      return
    }
    const player = state.players[claimant.playerIndex]
    const ctx: ClaimContext = { hand: player.hand, canGang: claimant.canGang, tile, from }
    const action = await options.controllers[claimant.playerIndex].requestClaim(ctx)
    if (hasSettled()) return

    switch (action.kind) {
      case 'pass':
        return offerNextClaim(remainingClaims, tile, from)
      case 'gang':
        performDiscardGang(options.tableContext, claimant.playerIndex, tile, from)
        options.later(
          () => { void beginTurn(claimant.playerIndex, { fromTail: true }) },
          PACE_MS.afterClaimGang,
        )
        return
      case 'peng':
        performPeng(options.tableContext, claimant.playerIndex, tile, from)
        if (action.discardIndex !== undefined) {
          options.later(
            () => { options.discardTile(claimant.playerIndex, action.discardIndex!) },
            PACE_MS.afterClaimPeng,
          )
        } else {
          options.later(
            () => { void beginTurn(claimant.playerIndex, { skipDraw: true }) },
            PACE_MS.skipDrawPengDelay,
          )
        }
    }
  }

  function findRobbers(kongPlayerIndex: number, tile: TileType) {
    return state.players
      .map((player, playerIndex) => ({
        playerIndex,
        distance: seatDistance(kongPlayerIndex, playerIndex),
        canRob: playerIndex !== kongPlayerIndex
          && canRobKong(player.hand, tile, options.structuralMeldCount(playerIndex)),
      }))
      .filter(({ canRob }) => canRob)
      .sort((a, b) => a.distance - b.distance)
      .map(({ playerIndex }) => playerIndex)
  }

  function requestAddedKong(playerIndex: number, meldIndex: number, tile: TileType) {
    const [robberIndex, ...remainingRobbers] = findRobbers(playerIndex, tile)
    options.declareAddedKong(playerIndex, meldIndex, tile)
    if (robberIndex === undefined) {
      options.later(() => { options.settleAddedKong(playerIndex) }, PACE_MS.beforeRobKong)
      return
    }
    state.pendingKong.value = { playerIndex, meldIndex, tile, remainingRobbers }
    options.later(() => { void offerRobKong(robberIndex) }, PACE_MS.beforeRobKong)
  }

  async function offerRobKong(robberIndex: number) {
    const kong = state.pendingKong.value
    if (!kong || hasSettled()) return
    const robber = state.players[robberIndex]
    const ctx: RobKongContext = {
      hand: robber.hand,
      exposedMelds: options.structuralMeldCount(robberIndex),
      tile: kong.tile,
      from: kong.playerIndex,
    }
    const action = await options.controllers[robberIndex].requestRobKong(ctx)
    if (hasSettled() || state.pendingKong.value !== kong) return
    if (action === 'pass') {
      const [nextRobber, ...remainingRobbers] = kong.remainingRobbers
      if (nextRobber === undefined) return options.settleAddedKong(kong.playerIndex)
      state.pendingKong.value = { ...kong, remainingRobbers }
      options.later(() => { void offerRobKong(nextRobber) }, PACE_MS.betweenRobKongs)
      return
    }
    options.announce(`${state.players[robberIndex].name} 抢杠胡!`, 'red')
    state.pendingKong.value = null
    options.later(() => {
      options.endGame(robberIndex, {
        robbedKong: true,
        robbedKongPlayerIndex: kong.playerIndex,
        winTile: kong.tile,
      })
    }, PACE_MS.betweenRobKongs)
  }

  function isKongDraw(playerIndex: number) {
    return runner.isKongDraw(playerIndex)
  }

  runner = createTurnRunner<LocalGameState, PlayerController, TurnAction>({
    state,
    controllers: options.controllers,
    drawFor: options.drawFor,
    endDraw: options.endDraw,
    buildContext: (player, playerIndex, turnOptions, kongBloom) => ({
      hand: player.hand,
      melds: player.melds,
      exposedMelds: options.structuralMeldCount(playerIndex),
      kongBloom,
      skipDraw: Boolean(turnOptions.skipDraw),
      afterKong: Boolean(turnOptions.fromTail),
    } satisfies TurnContext),
    requestTurn: (controller, context) => controller.requestTurn(context as TurnContext),
    handleAction: async (action, playerIndex, player, _turnOptions, api) => {
      switch (action.kind) {
        case 'win':
          return options.endGame(playerIndex, { kongBloom: api.isKongDraw(playerIndex) })
        case 'added-kong': {
          return requestAddedKong(playerIndex, action.meldIndex, player.melds[action.meldIndex].tile)
        }
        case 'concealed-kong': {
          await options.performConcealedKong(playerIndex, action.tile, { noContinue: true })
          if (api.hasSettled()) return
          return beginTurn(playerIndex, { fromTail: true })
        }
        case 'discard': {
          return options.discardTile(playerIndex, action.handIndex)
        }
      }
    },
  })

  return {
    beginTurn,
    routeDiscard,
    offerNextClaim,
    requestAddedKong,
    markDrawSource: runner.markDrawSource,
    clearDrawSource: runner.clearDrawSource,
    isKongDraw,
  }
}
