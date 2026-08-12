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
  it('闲家点炮：庄 2H + 两闲各 1H', () => {
    const players = makePlayers()
    const settlement = winPayments(1, { winnerIsDealer: false, selfDrawStyle: false })
    const totalWon = applyWinScore(players, 1, settlement, 0)
    expect(totalWon).toBe(400)
    expect(players[1].score).toBe(2400)
    expect(players[0].score).toBe(1800)
    expect(players[2].score).toBe(1900)
    expect(players[3].score).toBe(1900)
  })
  it('庄家自摸：三闲各 4H', () => {
    const players = makePlayers()
    const settlement = winPayments(1, { winnerIsDealer: true, selfDrawStyle: true })
    const totalWon = applyWinScore(players, 0, settlement, 0)
    expect(totalWon).toBe(1200)
    expect(players[0].score).toBe(3200)
    expect(players[1].score).toBe(1600)
  })
  it('天胡（庄家）：三闲各 4H，总分守恒', () => {
    const players = makePlayers()
    applyWinScore(players, 0, winPayments(8, { winnerIsDealer: true, selfDrawStyle: true }), 0)
    const total = players.reduce((sum, player) => sum + player.score, 0)
    expect(total).toBe(8000)
  })
})
