import { describe, expect, it } from 'vitest'
import type { GamePlayer } from '../../core/contracts/types'
import { applyKongScore, applyWinScore } from './lotusScoring'
import { winPayments } from './lotusRules'

function makePlayers(): GamePlayer[] {
  return [0, 1, 2, 3].map((seat) => ({
    name: `p${seat}`,
    avatar: '',
    score: 2000,
    seat,
    hand: [],
    discards: [],
    melds: [],
    redCount: 0,
    drawnTileIndex: -1,
  }))
}

describe('杠分（复用 applyKongScore）', () => {
  it('加杠：其余三家各付 1B', () => {
    const players = makePlayers()
    applyKongScore(players, 0, 'added')
    expect(players[0].score).toBe(2300)
    expect(players[1].score).toBe(1900)
    expect(players[2].score).toBe(1900)
    expect(players[3].score).toBe(1900)
  })
  it('明杠：放杠者付 1B', () => {
    const players = makePlayers()
    applyKongScore(players, 2, 'discard', 1)
    expect(players[2].score).toBe(2100)
    expect(players[1].score).toBe(1900)
    expect(players[0].score).toBe(2000)
  })
  it('暗杠与风杠：其余三家各付 2B', () => {
    const concealed = makePlayers()
    applyKongScore(concealed, 1, 'concealed')
    expect(concealed[1].score).toBe(2600)
    expect(concealed[0].score).toBe(1800)
    const wind = makePlayers()
    applyKongScore(wind, 3, 'concealed')
    expect(wind[3].score).toBe(2600)
  })
})

describe('胡牌收付（applyWinScore）', () => {
  it('庄家自摸：三闲各 4H，共12H', () => {
    const players = makePlayers()
    const totalWon = applyWinScore(players, 0, winPayments(1, { winnerIsDealer: true, selfDrawStyle: true }), 0)
    expect(totalWon).toBe(1200)
    expect(players.map(({ score }) => score)).toEqual([3200, 1600, 1600, 1600])
  })

  it('庄家点炮给闲家：庄 4H + 两闲各 1H，共6H', () => {
    const players = makePlayers()
    const totalWon = applyWinScore(players, 1, winPayments(1, { winnerIsDealer: false, selfDrawStyle: false }), 0, 0)
    expect(totalWon).toBe(600)
    expect(players.map(({ score }) => score)).toEqual([1600, 2600, 1900, 1900])
  })

  it('闲家自摸：庄 4H + 两闲各 2H，共8H', () => {
    const players = makePlayers()
    const totalWon = applyWinScore(players, 1, winPayments(1, { winnerIsDealer: false, selfDrawStyle: true }), 0)
    expect(totalWon).toBe(800)
    expect(players.map(({ score }) => score)).toEqual([1600, 2800, 1800, 1800])
  })

  it('闲家点庄家：点炮者 4H + 两闲各 2H，共8H', () => {
    const players = makePlayers()
    const totalWon = applyWinScore(players, 0, winPayments(1, { winnerIsDealer: true, selfDrawStyle: false }), 0, 1)
    expect(totalWon).toBe(800)
    expect(players.map(({ score }) => score)).toEqual([2800, 1600, 1800, 1800])
  })

  it('闲家点闲家：庄 2H + 点炮者 2H + 另一闲 1H，共5H', () => {
    const players = makePlayers()
    const totalWon = applyWinScore(players, 2, winPayments(1, { winnerIsDealer: false, selfDrawStyle: false }), 0, 1)
    expect(totalWon).toBe(500)
    expect(players.map(({ score }) => score)).toEqual([1800, 1800, 2500, 1900])
  })

  it('天胡（庄家）：三闲各 4H，总分守恒', () => {
    const players = makePlayers()
    applyWinScore(players, 0, winPayments(8, { winnerIsDealer: true, selfDrawStyle: true }), 0)
    const total = players.reduce((sum, player) => sum + player.score, 0)
    expect(total).toBe(8000)
  })
})
