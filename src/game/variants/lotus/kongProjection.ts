import type { TileType } from '../../core/contracts/types'
import { TILE_TYPES } from '../../core/rules/tiles'
import { LOTUS_RULESET, matchingCount } from './lotusRules'

export type ProjectedKongKind = 'discard-gang' | 'concealed-kong' | 'wind-kong'

export interface KongProjectionInput {
  kind: ProjectedKongKind
  hand: TileType[]
  exposedMelds: number
  jokers: TileType[]
  tile?: TileType
  visibleTiles?: TileType[]
}

export interface KongProjection {
  legal: boolean
  postKongHand: TileType[]
  waits: TileType[]
  drawableTiles: TileType[]
  guaranteedKongBloom: boolean
}

function removeCopies(hand: TileType[], tile: TileType, amount: number): TileType[] | null {
  const result = [...hand]
  for (let index = 0; index < amount; index += 1) {
    const at = result.indexOf(tile)
    if (at < 0) return null
    result.splice(at, 1)
  }
  return result
}

function postKongHand(input: KongProjectionInput): TileType[] | null {
  if (input.kind === 'discard-gang') {
    return input.tile ? removeCopies(input.hand, input.tile, 3) : null
  }
  if (input.kind === 'concealed-kong') {
    return input.tile ? removeCopies(input.hand, input.tile, 4) : null
  }
  let result: TileType[] | null = [...input.hand]
  for (const wind of ['east', 'south', 'west', 'north'] as const) {
    result = result ? removeCopies(result, wind, 1) : null
  }
  return result
}

export function projectKongBloom(input: KongProjectionInput): KongProjection {
  const postHand = postKongHand(input)
  if (!postHand) return { legal: false, postKongHand: [], waits: [], drawableTiles: [], guaranteedKongBloom: false }
  const waits = LOTUS_RULESET.win.waitingTiles(postHand, input.exposedMelds + 1, {
    jokers: input.jokers,
    jokerSubstitutes: ['white'],
  })
  const visible = input.visibleTiles ?? []
  const drawableTiles = TILE_TYPES.filter((tile) => 4 - matchingCount(visible, tile) > 0)
  const waitSet = new Set(waits)
  return {
    legal: true,
    postKongHand: postHand,
    waits,
    drawableTiles,
    guaranteedKongBloom: drawableTiles.length > 0 && drawableTiles.every((tile) => waitSet.has(tile)),
  }
}

/** 当前摸牌态是否存在一个合法弃牌可进入听牌。 */
export function hasReadyDiscard(hand: TileType[], exposedMelds: number, jokers: TileType[]): boolean {
  const protectedTiles = new Set<TileType>([...jokers, 'white'])
  const hasNatural = hand.some((tile) => !protectedTiles.has(tile))
  return hand.some((tile, index) => {
    if (hasNatural && protectedTiles.has(tile)) return false
    const after = hand.filter((_, candidateIndex) => candidateIndex !== index)
    return LOTUS_RULESET.win.waitingTiles(after, exposedMelds, {
      jokers,
      jokerSubstitutes: ['white'],
    }).length > 0
  })
}
