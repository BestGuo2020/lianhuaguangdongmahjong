import { describe, expect, it } from 'vitest'
import { advanceMatchState } from './useGame'

const base = {
  round: 1,
  dealer: 0,
  honba: 0,
  matchType: 'east',
  scores: [1000, 1000, 1000, 1000],
}

describe('场次推进', () => {
  it('庄家和牌时连庄并增加本场', () => {
    expect(advanceMatchState({ ...base, result: { winnerIndex: 0 } })).toEqual({
      round: 1, dealer: 0, honba: 1, finished: false,
    })
  })

  it('闲家和牌时进入下一局并顺移庄位', () => {
    expect(advanceMatchState({ ...base, honba: 2, result: { winnerIndex: 2 } })).toEqual({
      round: 2, dealer: 1, honba: 0, finished: false,
    })
  })

  it('东四结束后结束东风场，半庄场则进入南一', () => {
    const eastFour = { ...base, round: 4, dealer: 3, result: { winnerIndex: 1 } }
    expect(advanceMatchState(eastFour)).toMatchObject({ round: 5, dealer: 0, finished: true })
    expect(advanceMatchState({ ...eastFour, matchType: 'hanchan' })).toMatchObject({ round: 5, dealer: 0, finished: false })
  })
})
