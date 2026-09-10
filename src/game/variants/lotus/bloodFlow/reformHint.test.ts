import { expect, it } from 'vitest'
import type { TileType } from '../../../core/contracts/types'
import type { WaitScores } from '../patterns/handWaits'
import type { PublicWinScore } from './types'
import { computeReformHint } from './reformHint'

function score(paymentPerPayer: number, source: 'self-draw' | 'discard' = 'self-draw'): PublicWinScore {
  return { paymentPerPayer, source } as PublicWinScore
}

function waitScores(payment: number): WaitScores {
  return [
    { tile: 'm5', selfDraw: score(payment), discard: score(payment, 'discard') },
    { tile: 's2', selfDraw: score(payment), discard: score(payment, 'discard') },
  ]
}

it('suggests the reform discard when converting to an any-tile wait beats the win', () => {
  const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p9', 'p9', 'p9', 's7', 'white']
  const anyWait: WaitScores = Array.from({ length: 34 }, (_, index) => {
    const tile = ['m', 'p', 's'].flatMap(suit => [1, 2, 3, 4, 5, 6, 7, 8, 9].map(rank => `${suit}${rank}` as TileType))
      .concat(['east', 'south', 'west', 'north', 'red', 'green', 'white'] as TileType[])[index]
    return { tile, selfDraw: score(40), discard: score(40, 'discard') }
  })
  const hint = computeReformHint({
    hand, drawnTileIndex: 13, wallCount: 60, visible: hand,
    ownScore: score(20),
    hints: { current: waitScores(20), discards: [{ discard: 's7', waits: anyWait }] },
  })
  expect(hint).toEqual({ discard: 's7', reason: 'any-wait', gain: expect.any(Number) })
  expect(hint!.gain).toBeGreaterThan(0)
})

it('stays silent when no discard keeps a better tenpai', () => {
  const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p9', 'p9', 'p9', 's7', 's7']
  const narrow = waitScores(20)
  const hint = computeReformHint({
    hand, drawnTileIndex: 13, wallCount: 60, visible: hand,
    ownScore: score(80),
    hints: { current: narrow, discards: [{ discard: 's7', waits: narrow }] },
  })
  expect(hint).toBeNull()
})

it('ignores the drawn tile itself and stays silent below the gain ratio', () => {
  const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p9', 'p9', 'p9', 's7', 'white']
  const hint = computeReformHint({
    hand, drawnTileIndex: 13, wallCount: 60, visible: hand,
    ownScore: score(20),
    hints: { current: waitScores(20), discards: [{ discard: 'white', waits: waitScores(40) }] },
  })
  expect(hint).toBeNull()
})
