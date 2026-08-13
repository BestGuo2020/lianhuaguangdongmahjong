// 「莲花麻将」回合/响应编排。弃牌响应优先级：胡 > 碰/明杠 > 吃（仅下家），单响拦胡。
import { removeLastDiscard } from '../../core/rules/actions'
import { performDiscardGang, performPeng, type ActionContext } from '../../core/rules/actions'
import { sortTilesWithJokers } from '../../core/rules/tiles'
import { PACE_MS } from '../../core/local/localGameConfig'
import type { TileType } from '../../core/contracts/types'
import type { LotusController, LotusHuAction, LotusTurnContext } from './lotusControllers'
import { canChi, canRobKong, isWinningHand, matchingCount, type ChiMeld } from './lotusRules'
import type { LotusEndGameOptions, LotusGameState } from './lotusState'
import type { LotusTurnAction } from './lotusControllers'
import { createTurnRunner, type TurnOptions } from '../../shared/runtime/turnRunner'

interface ClaimCandidate {
  playerIndex: number
  canPeng: boolean
  canGang: boolean
  chiOptions: ChiMeld[]
}

interface LotusTurnOrchestratorOptions {
  state: LotusGameState
  controllers: LotusController[]
  tableContext: ActionContext
  structuralMeldCount(playerIndex: number): number
  drawFor(playerIndex: number, fromTail?: boolean): Promise<boolean>
  performConcealedKong(playerIndex: number, tile: TileType, options?: { noContinue?: boolean }): Promise<void>
  performWindKong(playerIndex: number): Promise<void>
  declareAddedKong(playerIndex: number, meldIndex: number, tile: TileType): void
  settleAddedKong(playerIndex: number): unknown
  discardTile(playerIndex: number, handIndex: number): unknown
  endDraw(): unknown
  endGame(winnerIndex: number, options?: LotusEndGameOptions): unknown
  announce(text: string, tone?: string): void
  later(callback: () => void, delay: number): number
}

export function createLotusTurnOrchestrator(options: LotusTurnOrchestratorOptions) {
  const { state } = options
  let runner!: ReturnType<typeof createTurnRunner<LotusGameState, LotusController, LotusTurnAction>>

  function hasSettled() {
    return state.phase.value === 'settled'
  }

  function seatDistance(from: number, to: number) {
    return (to - from + state.players.length) % state.players.length
  }

  function beginTurn(playerIndex: number, turnOptions: TurnOptions = {}) {
    return runner.beginTurn(playerIndex, turnOptions)
  }

  // ── 弃牌响应：胡 > 碰/明杠 > 吃（仅下家），单响 ─────────────────────────

  function findHu(from: number, tile: TileType): number[] {
    return state.players
      .map((player, playerIndex) => ({
        playerIndex,
        distance: seatDistance(from, playerIndex),
        canHu: playerIndex !== from && isWinningHand(
          [...player.hand, tile],
          options.structuralMeldCount(playerIndex),
          state.jokerTiles.value,
          state.jokerTiles.value.includes(tile) ? [tile] : [],
        ),
      }))
      .filter(({ canHu }) => canHu)
      .sort((a, b) => a.distance - b.distance)
      .map(({ playerIndex }) => playerIndex)
  }

  function routeDiscard(from: number, tile: TileType) {
    const isFirstDiscard = state.roundFirstDiscard.value
    state.roundFirstDiscard.value = false
    const huPlayers = findHu(from, tile)
    if (huPlayers.length) {
      void offerHu(huPlayers, from, tile, isFirstDiscard, new Map())
      return
    }
    continueClaims(from, tile)
  }

  async function offerHu(
    list: number[],
    from: number,
    tile: TileType,
    isFirstDiscard: boolean,
    decisions: Map<number, LotusHuAction>,
  ) {
    const [playerIndex, ...remaining] = list
    if (playerIndex === undefined) {
      continueClaims(from, tile, decisions)
      return
    }
    const player = state.players[playerIndex]
    const count = matchingCount(player.hand, tile)
    const chiOptions = playerIndex === (from + 1) % state.players.length
      ? canChi(player.hand, tile, state.jokerTiles.value)
      : []
    const dihu = isFirstDiscard && from === state.dealer.value
    const ctx = {
      hand: player.hand,
      exposedMelds: options.structuralMeldCount(playerIndex),
      tile,
      from,
      dihu,
      jokers: state.jokerTiles.value,
      canPeng: count >= 2,
      canGang: count >= 3,
      chiOptions,
    }
    const action = await options.controllers[playerIndex].requestDiscardHu(ctx)
    if (hasSettled()) return
    if (action.kind !== 'win') {
      decisions.set(playerIndex, action)
      void offerHu(remaining, from, tile, isFirstDiscard, decisions)
      return
    }
    options.announce(`${player.name} 胡!`, 'red')
    options.endGame(playerIndex, { winTile: tile, dihu, winHand: [...player.hand, tile], sourceFrom: from })
  }

  /** 精牌弃出后按普通牌面参与碰/明杠 → 吃（下家）响应。 */
  function continueClaims(from: number, tile: TileType, decisions = new Map<number, LotusHuAction>()) {
    const claimants = findClaims(from, tile)
    if (claimants.length) {
      void offerNextClaim(claimants, tile, from, decisions)
      return
    }
    options.later(() => { void beginTurn((from + 1) % state.players.length) }, PACE_MS.afterDiscardToNextTurn)
  }

  function findClaims(from: number, tile: TileType): ClaimCandidate[] {
    return state.players
      .map((player, playerIndex) => ({
        playerIndex,
        count: matchingCount(player.hand, tile),
        chiOptions: playerIndex === (from + 1) % state.players.length
          ? canChi(player.hand, tile, state.jokerTiles.value)
          : [],
        distance: seatDistance(from, playerIndex),
      }))
      .filter(({ playerIndex, count, chiOptions }) => playerIndex !== from && (count >= 2 || chiOptions.length > 0))
      .sort((a, b) => a.distance - b.distance)
      .map(({ playerIndex, count, chiOptions }) => ({
        playerIndex,
        canPeng: count >= 2,
        canGang: count >= 3,
        chiOptions,
      }))
  }

  async function offerNextClaim(
    claimants: ClaimCandidate[],
    tile: TileType,
    from: number,
    decisions = new Map<number, LotusHuAction>(),
  ) {
    const [claimant, ...remainingClaims] = claimants
    if (!claimant) {
      options.later(() => { void beginTurn((from + 1) % state.players.length) }, PACE_MS.afterDiscardToNextTurn)
      return
    }
    const player = state.players[claimant.playerIndex]
    const decided = decisions.get(claimant.playerIndex)
    if (decided) {
      if (decided.kind === 'gang') {
        performDiscardGang(options.tableContext, claimant.playerIndex, tile, from)
        options.later(() => { void beginTurn(claimant.playerIndex, { fromTail: true }) }, PACE_MS.afterClaimGang)
        return
      }
      if (decided.kind === 'peng') {
        performPeng(options.tableContext, claimant.playerIndex, tile, from)
        options.later(() => { void beginTurn(claimant.playerIndex, { skipDraw: true }) }, PACE_MS.skipDrawPengDelay)
        return
      }
      if (decided.kind === 'chi') {
        performChi(claimant.playerIndex, decided.meld, tile, from)
        options.later(() => { void beginTurn(claimant.playerIndex, { skipDraw: true }) }, PACE_MS.afterClaimPeng)
        return
      }
      return offerNextClaim(remainingClaims, tile, from, decisions)
    }
      const ctx = {
        hand: player.hand,
        canPeng: claimant.canPeng,
        canGang: claimant.canGang,
        tile,
        from,
        chiOptions: claimant.chiOptions,
        jokers: state.jokerTiles.value,
      }
    const action = await options.controllers[claimant.playerIndex].requestClaim(ctx)
    if (hasSettled()) return

    switch (action.kind) {
      case 'pass':
        return offerNextClaim(remainingClaims, tile, from, decisions)
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
        return
      case 'chi':
        performChi(claimant.playerIndex, action.meld, tile, from)
        options.later(
          () => { void beginTurn(claimant.playerIndex, { skipDraw: true }) },
          PACE_MS.afterClaimPeng,
        )
        return
    }
  }

  /** 吃：仅弃牌下家可吃。 */
  function offerChi(from: number, tile: TileType, decisions = new Map<number, LotusHuAction>()) {
    const nextPlayer = (from + 1) % state.players.length
    const player = state.players[nextPlayer]
    const chiOptions = canChi(player.hand, tile, state.jokerTiles.value)
    const decided = decisions.get(nextPlayer)
    if (decided) {
      if (decided.kind === 'chi') {
        performChi(nextPlayer, decided.meld, tile, from)
        options.later(() => { void beginTurn(nextPlayer, { skipDraw: true }) }, PACE_MS.afterClaimPeng)
        return
      }
      options.later(() => { void beginTurn(nextPlayer) }, PACE_MS.afterDiscardToNextTurn)
      return
    }
    if (!chiOptions.length) {
      options.later(() => { void beginTurn(nextPlayer) }, PACE_MS.afterDiscardToNextTurn)
      return
    }
    void requestChi(nextPlayer, chiOptions, tile, from)
  }

  async function requestChi(playerIndex: number, chiOptions: ChiMeld[], tile: TileType, from: number) {
    const player = state.players[playerIndex]
    const action = await options.controllers[playerIndex].requestChi({
      hand: player.hand,
      tile,
      from,
      chiOptions,
      jokers: state.jokerTiles.value,
    })
    if (hasSettled()) return
    if (action.kind === 'pass') {
      options.later(() => { void beginTurn(playerIndex) }, PACE_MS.afterDiscardToNextTurn)
      return
    }
    performChi(playerIndex, action.meld, tile, from)
    options.later(
      () => { void beginTurn(playerIndex, { skipDraw: true }) },
      PACE_MS.afterClaimPeng,
    )
  }

  function performChi(playerIndex: number, meld: ChiMeld, tile: TileType, from: number) {
    const player = state.players[playerIndex]
    player.drawnTileIndex = -1
    removeLastDiscard(state.players[from].discards, tile)
    meld.tiles.forEach((item) => {
      if (item === tile) return
      const index = player.hand.indexOf(item)
      if (index >= 0) player.hand.splice(index, 1)
    })
    player.hand = sortTilesWithJokers(player.hand, state.jokerTiles.value)
    player.melds.push({ type: 'chi', tile, from, tiles: meld.tiles })
    state.currentPlayer.value = playerIndex
    options.tableContext.showTableAction('chi', playerIndex, from, tile, player.melds.length - 1)
    options.tableContext.playSound('chi.mp3')
  }

  // ── 加杠 / 抢杠 ────────────────────────────────────────────────

  function findRobbers(kongPlayerIndex: number, tile: TileType) {
    return state.players
      .map((player, playerIndex) => ({
        playerIndex,
        distance: seatDistance(kongPlayerIndex, playerIndex),
        canRob: playerIndex !== kongPlayerIndex
          && canRobKong(player.hand, tile, options.structuralMeldCount(playerIndex), state.jokerTiles.value),
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
    const action = await options.controllers[robberIndex].requestRobKong({
      hand: robber.hand,
      exposedMelds: options.structuralMeldCount(robberIndex),
      tile: kong.tile,
      from: kong.playerIndex,
      jokers: state.jokerTiles.value,
    })
    if (hasSettled() || state.pendingKong.value !== kong) return
    if (action === 'pass') {
      const [nextRobber, ...remaining] = kong.remainingRobbers
      if (nextRobber === undefined) return options.settleAddedKong(kong.playerIndex)
      state.pendingKong.value = { ...kong, remainingRobbers: remaining }
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
        winHand: [...robber.hand, kong.tile],
        sourceFrom: kong.playerIndex,
      })
    }, PACE_MS.betweenRobKongs)
  }

  // ── 杠后补摸来源标记（杠上开花） ─────────────────────────────

  function markDrawSource(playerIndex: number, fromTail: boolean) {
    runner.markDrawSource(playerIndex, fromTail)
  }

  function clearDrawSource() {
    runner.clearDrawSource()
  }

  function isKongDraw(playerIndex: number) {
    return runner.isKongDraw(playerIndex)
  }

  runner = createTurnRunner<LotusGameState, LotusController, LotusTurnAction>({
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
      isDealer: playerIndex === state.dealer.value,
      jokers: state.jokerTiles.value,
      afterKong: Boolean(turnOptions.fromTail),
    }),
    requestTurn: (controller, context) => controller.requestTurn(context as LotusTurnContext),
    handleAction: async (action, playerIndex, player, _turnOptions, api) => {
      switch (action.kind) {
        case 'win':
          return options.endGame(playerIndex, {
            selfDraw: true,
            kongBloom: api.isKongDraw(playerIndex),
            winHand: [...player.hand],
          })
        case 'added-kong':
          return requestAddedKong(playerIndex, action.meldIndex, player.melds[action.meldIndex].tile)
        case 'concealed-kong':
          await options.performConcealedKong(playerIndex, action.tile, { noContinue: true })
          if (api.hasSettled()) return
          return beginTurn(playerIndex, { fromTail: true })
        case 'wind-kong':
          await options.performWindKong(playerIndex)
          if (api.hasSettled()) return
          return beginTurn(playerIndex, { fromTail: true })
        case 'discard':
          return options.discardTile(playerIndex, action.handIndex)
      }
    },
  })

  return {
    beginTurn,
    routeDiscard,
    performChi,
    requestAddedKong,
    markDrawSource,
    clearDrawSource,
    isKongDraw,
  }
}
