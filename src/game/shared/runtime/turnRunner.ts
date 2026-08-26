import type { GamePhase, RefLike } from '../../core/contracts/gamePort'
import type { GamePlayer, TileType } from '../../core/contracts/types'

interface TurnRunnerState {
  players: GamePlayer[]
  phase: RefLike<GamePhase>
  wall: RefLike<TileType[]>
  currentPlayer: RefLike<number>
  userDrewThisTurn: RefLike<boolean>
  selectedIndex: RefLike<number>
  actionPrompt: RefLike<unknown>
}

export interface TurnOptions {
  skipDraw?: boolean
  fromTail?: boolean
  /** 庄家开局首回合：已持 14 张（引擎跳摸，但对远端视作已摸牌，用于天胡判定）。 */
  preDrawn?: boolean
}

export interface TurnRunnerApi {
  beginTurn(playerIndex: number, options?: TurnOptions): Promise<unknown>
  hasSettled(): boolean
  isKongDraw(playerIndex: number): boolean
  markDrawSource(playerIndex: number, fromTail: boolean): void
  clearDrawSource(): void
}

export interface TurnRunnerOptions<
  S extends TurnRunnerState,
  C,
  A,
> {
  state: S
  controllers: C[]
  drawFor(playerIndex: number, fromTail?: boolean): Promise<boolean>
  endDraw(): unknown
  buildContext(player: GamePlayer, playerIndex: number, options: TurnOptions, kongBloom: boolean): unknown
  requestTurn(controller: C, context: unknown): Promise<A>
  handleAction(
    action: A,
    playerIndex: number,
    player: GamePlayer,
    options: TurnOptions,
    api: TurnRunnerApi,
  ): unknown
}

export function createTurnRunner<S extends TurnRunnerState, C, A>(
  options: TurnRunnerOptions<S, C, A>,
): TurnRunnerApi {
  const { state } = options
  let kongDrawPlayerIndex = -1

  function hasSettled() {
    return state.phase.value === 'lobby'
      || state.phase.value === 'settled'
      || state.phase.value === 'finished'
      || state.phase.value === 'win-effect'
      || state.phase.value === 'revealing'
  }

  async function beginTurn(playerIndex: number, turnOptions: TurnOptions = {}) {
    if (hasSettled()) return
    if (!state.wall.value.length) return options.endDraw()
    state.currentPlayer.value = playerIndex
    state.userDrewThisTurn.value = false
    state.phase.value = 'drawing'
    state.selectedIndex.value = -1
    state.actionPrompt.value = null
    if (turnOptions.skipDraw) kongDrawPlayerIndex = -1

    const drawn = turnOptions.skipDraw
      ? true
      : await options.drawFor(playerIndex, turnOptions.fromTail)
    if (!drawn || hasSettled()) return

    state.phase.value = 'thinking'
    const player = state.players[playerIndex]
    const context = options.buildContext(
      player,
      playerIndex,
      turnOptions,
      kongDrawPlayerIndex === playerIndex,
    )
    const action = await options.requestTurn(options.controllers[playerIndex], context)
    if (hasSettled() || state.currentPlayer.value !== playerIndex) return
    return options.handleAction(action, playerIndex, player, turnOptions, api)
  }

  function markDrawSource(playerIndex: number, fromTail: boolean) {
    kongDrawPlayerIndex = fromTail ? playerIndex : -1
  }

  function clearDrawSource() {
    kongDrawPlayerIndex = -1
  }

  function isKongDraw(playerIndex: number) {
    return kongDrawPlayerIndex === playerIndex
  }

  const api: TurnRunnerApi = { beginTurn, hasSettled, isKongDraw, markDrawSource, clearDrawSource }
  return api
}
