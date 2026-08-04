import { describe, expect, it } from 'vitest'
import { performDiscardGang, performPeng, removeLastDiscard, removeMatches } from './actions'
import type { ActionContext } from './actions'
import type { GamePlayer, TileType } from './types'

function player(hand: TileType[] = [], seat = 0): GamePlayer {
  return {
    name: 'P', avatar: '', score: 1000, seat,
    hand, discards: [], melds: [], redCount: 0, drawnTileIndex: 1,
  }
}

function context(players: GamePlayer[], currentPlayer = 0): ActionContext & { events: string[] } {
  const events: string[] = []
  return {
    players,
    currentPlayer: { value: currentPlayer },
    showTableAction: (type, actorIndex, _sourceIndex, tile, meldIndex) => {
      events.push(`action:${type}:${actorIndex}:${tile}:${meldIndex}`)
    },
    showScoreFlow: (deltas) => {
      events.push(`score:${deltas.map((d) => `${d.playerIndex}:${d.amount}`).join(',')}`)
    },
    playSound: (name) => { events.push(`sound:${name}`) },
    events,
  }
}

describe('removeMatches / removeLastDiscard', () => {
  it('removeMatches 移除指定张数并保持原数组不变', () => {
    const hand: TileType[] = ['m1', 'm2', 'm1', 'm3']
    expect(removeMatches(hand, 'm1', 2)).toEqual(['m2', 'm3'])
    expect(hand).toEqual(['m1', 'm2', 'm1', 'm3'])
  })

  it('removeLastDiscard 只移除最后一张且匹配才移除', () => {
    const pile: TileType[] = ['m1', 'east']
    removeLastDiscard(pile, 'east')
    expect(pile).toEqual(['m1'])
    removeLastDiscard(pile, 'm9')  // 末张不匹配，不动
    expect(pile).toEqual(['m1'])
  })
})

describe('performPeng 共享碰执行', () => {
  it('移除手牌 2 张、消掉弃牌、组成碰副露并轮到本家', () => {
    const players = [
      player(['east', 'east', 'm1', 'm2']),
      player(['m1', 'm2'], 1),
      player([], 2),
      player([], 3),
    ]
    players[1].discards = ['s1', 'east']
    const ctx = context(players)
    performPeng(ctx, 0, 'east', 1)

    expect(players[0].hand).toEqual(['m1', 'm2'])
    expect(players[0].drawnTileIndex).toBe(-1)
    expect(players[0].melds).toEqual([{ type: 'peng', tile: 'east', from: 1, tiles: ['east', 'east', 'east'] }])
    expect(players[1].discards).toEqual(['s1'])
    expect(ctx.currentPlayer.value).toBe(0)
    expect(ctx.events).toEqual([
      'action:peng:0:east:0',
      'sound:peng.mp3',
    ])
  })

  it('对任意座位（含 AI）同样生效', () => {
    const players = [
      player(['east', 'm1', 'm2']),
      player([], 1),
      player(['p5', 'p5', 'm9', 'm9'], 2),
      player([], 3),
    ]
    players[0].discards = ['p5']
    const ctx = context(players)
    performPeng(ctx, 2, 'p5', 0)

    expect(players[2].hand).toEqual(['m9', 'm9'])
    expect(players[2].melds[0]).toEqual({ type: 'peng', tile: 'p5', from: 0, tiles: ['p5', 'p5', 'p5'] })
    expect(players[0].discards).toEqual([])
    expect(ctx.currentPlayer.value).toBe(2)
  })
})

describe('performDiscardGang 共享点杠执行', () => {
  it('移除手牌 3 张、组成杠副露、结算点杠分数并轮到本家', () => {
    const players = [
      player(['east', 'east', 'east', 'm1']),
      player(['m1'], 1),
      player([], 2),
      player([], 3),
    ]
    players[1].discards = ['s1', 'east']
    const ctx = context(players)
    performDiscardGang(ctx, 0, 'east', 1)

    expect(players[0].hand).toEqual(['m1'])
    expect(players[0].melds[0]).toEqual({ type: 'gang', tile: 'east', from: 1, tiles: ['east', 'east', 'east', 'east'] })
    expect(players[1].discards).toEqual(['s1'])
    expect(players[0].score).toBe(1100)
    expect(players[1].score).toBe(900)
    expect(ctx.currentPlayer.value).toBe(0)
    expect(ctx.events).toContain('sound:gang.mp3')
    expect(ctx.events).toContain('score:0:100,1:-100')
  })

  it('对任意座位（含 AI）同样生效', () => {
    const players = [
      player(['s9', 'm1']),
      player([], 1),
      player(['s9', 's9', 's9', 'p2'], 2),
      player([], 3),
    ]
    players[0].discards = ['s9']
    const ctx = context(players)
    performDiscardGang(ctx, 2, 's9', 0)

    expect(players[2].hand).toEqual(['p2'])
    expect(players[2].melds[0].type).toBe('gang')
    expect(players[0].score).toBe(900)
    expect(players[2].score).toBe(1100)
    expect(ctx.currentPlayer.value).toBe(2)
  })
})
