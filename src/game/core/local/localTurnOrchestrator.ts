import type { EndGameOptions, TileType } from '../contracts/types'
import type {
  ClaimContext,
  PlayerController,
  RobKongContext,
  TurnAction,
  TurnContext,
} from '../controllers/playerController'
import { performDiscardGang, performPeng, type ActionContext } from '../rules/actions'
import { matchingCount } from '../rules/rules'
import { PACE_MS } from './localGameConfig'
import type { LocalGameState } from './localGameState'
import { createTurnRunner, type TurnOptions } from '../../shared/runtime/turnRunner'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'
import type { FollowDealerTracker } from '../../shared/runtime/followDealer'

interface ClaimCandidate {
  playerIndex: number
  canPeng?: boolean
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
  ruleset?: RuleSet
  /** 跟庄跟踪器：吃/碰/杠/胡等打断第一圈的动作发生时使其失效。 */
  followDealer?: FollowDealerTracker
}

export function createLocalTurnOrchestrator(options: LocalTurnOrchestratorOptions) {
  const { state } = options
  const ruleset = options.ruleset ?? DEFAULT_RULESET
  let runner!: ReturnType<typeof createTurnRunner<LocalGameState, PlayerController, TurnAction>>

  function hasSettled() {
    return runner.hasSettled()
  }

  function interruptFollow() {
    options.followDealer?.interrupt()
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
      // 全局优先级：杠(1) > 碰(2)，同级再按座位距离（对齐后端 find_claims）。
      .sort((a, b) => {
        const pa = a.count >= 3 ? 1 : 2
        const pb = b.count >= 3 ? 1 : 2
        return pa !== pb ? pa - pb : a.distance - b.distance
      })
      .map(({ playerIndex, count }) => ({ playerIndex, canPeng: count >= 2, canGang: count >= 3 }))
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
    const ctx: ClaimContext = {
      hand: player.hand,
      canPeng: claimant.canPeng ?? matchingCount(player.hand, tile) >= 2,
      canGang: claimant.canGang,
      tile,
      from,
      exposedMelds: options.structuralMeldCount(claimant.playerIndex),
      ruleset,
    }
    const action = await options.controllers[claimant.playerIndex].requestClaim(ctx)
    if (hasSettled()) return

    switch (action.kind) {
      case 'pass':
        return offerNextClaim(remainingClaims, tile, from)
      case 'gang':
        // 控制器（尤其是远端客户端）返回的动作仍需由房主按当前状态复核。
        if (!claimant.canGang) return offerNextClaim(remainingClaims, tile, from)
        interruptFollow()
        performDiscardGang(options.tableContext, claimant.playerIndex, tile, from)
        options.later(
          () => { void beginTurn(claimant.playerIndex, { fromTail: true }) },
          PACE_MS.afterClaimGang,
        )
        return
      case 'peng':
        if (!claimant.canPeng) return offerNextClaim(remainingClaims, tile, from)
        interruptFollow()
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
          && ruleset.win.canRobKong(player.hand, tile, options.structuralMeldCount(playerIndex)),
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
      ruleset,
    } satisfies TurnContext),
    requestTurn: (controller, context) => controller.requestTurn(context as TurnContext),
      handleAction: async (action, playerIndex, player, _turnOptions, api) => {
        switch (action.kind) {
          case 'win':
            if (!ruleset.win.isWinningHand(player.hand, options.structuralMeldCount(playerIndex))) {
              return options.discardTile(playerIndex, player.hand.length - 1)
            }
            interruptFollow()
            return options.endGame(playerIndex, { kongBloom: api.isKongDraw(playerIndex) })
          case 'added-kong': {
            const meld = player.melds[action.meldIndex]
            if (!Number.isInteger(action.meldIndex)
              || !meld
              || meld.type !== 'peng'
              || !player.hand.includes(meld.tile)) {
              return options.discardTile(playerIndex, player.hand.length - 1)
            }
            interruptFollow()
            return requestAddedKong(playerIndex, action.meldIndex, player.melds[action.meldIndex].tile)
          }
          case 'concealed-kong': {
            if (!ruleset.win.concealedKongs(player.hand).includes(action.tile)) {
              return options.discardTile(playerIndex, player.hand.length - 1)
            }
            interruptFollow()
          await options.performConcealedKong(playerIndex, action.tile, { noContinue: true })
          if (api.hasSettled()) return
          return beginTurn(playerIndex, { fromTail: true })
        }
          case 'discard': {
            const handIndex = Number.isInteger(action.handIndex)
              && action.handIndex >= 0
              && action.handIndex < player.hand.length
              ? action.handIndex
              : player.hand.length - 1
            return options.discardTile(playerIndex, handIndex)
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
