import type { RefLike, DealAnimation, OpeningStage } from '../../core/contracts/gamePort'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import { sortTiles } from '../../core/rules/tiles'
import { PLAYER_SEED } from '../../core/local/localGameConfig'

interface OpeningState {
  players: GamePlayer[]
  dealer: RefLike<number>
  openingStage: RefLike<OpeningStage | null>
  dealAnimation: RefLike<DealAnimation>
}

/** AI 座位种子（座位 1-3，下标 0..2）：昵称/头像由 LLM 人设覆盖 */
export interface PlayerSeed {
  name: string
  avatar: string
  score?: number
  isLlm?: boolean
}

export function resetLocalPlayers(
  state: Pick<OpeningState, 'players'>,
  defaultScore?: number,
  aiSeeds?: Array<PlayerSeed>,
) {
  const previousScores = state.players.map((player) => player.score)
  state.players.splice(0, state.players.length, ...PLAYER_SEED.map((player, index) => {
    const aiSeed = index > 0 ? aiSeeds?.[index - 1] : undefined
    return {
      ...player,
      name: aiSeed?.name ?? player.name,
      avatar: aiSeed?.avatar ?? player.avatar,
      score: aiSeed?.score ?? previousScores[index] ?? defaultScore ?? player.score,
      isLlm: aiSeed?.isLlm ?? false,
      seat: index,
      hand: [],
      discards: [],
      melds: [],
      redCount: 0,
      drawnTileIndex: -1,
    }
  }))
}

export interface InitialDealOptions<S extends OpeningState> {
  state: S
  takeTile(fromTail?: boolean): TileType | null
  wait(delay: number): Promise<void>
  playSound(name: string, volume?: number): unknown
  sortHand?: (hand: TileType[]) => TileType[]
  isCancelled?(): boolean
}

export async function dealInitialHands<S extends OpeningState>(options: InitialDealOptions<S>) {
  const { state } = options
  state.openingStage.value = 'deal'
  const seatOrder = state.players.map(
    (_, offset) => (state.dealer.value + offset) % state.players.length,
  )

  const receiveDealtTile = (playerIndex: number, tile: TileType | null) => {
    if (tile) state.players[playerIndex].hand.push(tile)
  }

  const dealBatch = async (playerIndex: number, count: number) => {
    if (count === 4) options.playSound('deal.mp3', 0.72)
    for (let index = 0; index < count; index += 1) {
      receiveDealtTile(playerIndex, options.takeTile(false))
    }
    state.dealAnimation.value = {
      playerIndex,
      count,
      serial: state.dealAnimation.value.serial + 1,
    }
    await options.wait(count === 4 ? 260 : 150)
  }

  for (let batch = 0; batch < 3; batch += 1) {
    for (const playerIndex of seatOrder) {
      await dealBatch(playerIndex, 4)
      if (options.isCancelled?.()) return false
    }
  }

  const jumpTiles = Array.from({ length: 5 }, () => options.takeTile(false))
  const jumpOrder = [state.dealer.value, seatOrder[1], seatOrder[2], seatOrder[3], state.dealer.value]
  jumpOrder.forEach((playerIndex, index) => receiveDealtTile(playerIndex, jumpTiles[index]))
  state.dealAnimation.value = {
    playerIndex: state.dealer.value,
    count: 2,
    serial: state.dealAnimation.value.serial + 1,
  }
  await options.wait(260)
  for (const playerIndex of [seatOrder[1], seatOrder[2], seatOrder[3]]) {
    state.dealAnimation.value = {
      playerIndex,
      count: 1,
      serial: state.dealAnimation.value.serial + 1,
    }
    await options.wait(150)
  }
  if (options.isCancelled?.()) return false

  const sortHand = options.sortHand ?? sortTiles
  state.players.forEach((player) => { player.hand = sortHand(player.hand) })
  return true
}
