import { describe, expect, it } from 'vitest'
import type { GamePlayer, Meld, TileType } from '../../../core/contracts/types'
import { createWall } from '../../../core/rules/tiles'
import { BloodFlowEngine } from './engine'
import type { BloodFlowOpeningState } from './state'
import { SEATS } from './state'

const waiting: TileType[] = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'm4', 'm5', 'm6', 'east']
function scenario(hands: (TileType[] | null)[], melds: Meld[][] = [[], [], [], []], emptyWall = false, next?: TileType) {
  const pool = createWall()
  const remove = (tile: TileType) => { const i = pool.indexOf(tile); if (i < 0) throw new Error(`Fixture exceeds four ${tile}`); pool.splice(i, 1) }
  const flipTiles: [TileType, TileType] = ['p9', 'white']
  flipTiles.forEach(remove)
  for (const hand of hands) hand?.forEach(remove)
  melds.flatMap(m => m.flatMap(g => g.tiles)).forEach(remove)
  const players = SEATS.map((seat): GamePlayer => ({ seat, name: `P${seat}`, avatar: '', score: 2000,
    hand: hands[seat] ? [...hands[seat]!] : pool.splice(0, (seat === 0 ? 14 : 13) - melds[seat].length * 3),
    melds: structuredClone(melds[seat]), discards: [], redCount: 0, drawnTileIndex: -1 }))
  if (next) { const i = pool.indexOf(next); if (i < 0) throw new Error(`Missing next tile ${next}`); pool.splice(i, 1); pool.unshift(next) }
  if (emptyWall) players[0].discards.push(...pool.splice(0))
  const opening: BloodFlowOpeningState = { players, wall: pool, flipTiles, jokers: ['red', 'green'], headDrawn: 134 - pool.length,
    dealerDrawnIndex: players[0].hand.length - 1, flipStack: 0, flipSeat: 0, wallBreakIndex: 2 }
  return new BloodFlowEngine({ authorityEpoch: 'test', roundId: 'round-1', opening, now: () => 0, winBeatMs: 0 })
}
function discardEast(engine: BloodFlowEngine) {
  expect(engine.submit(engine.command(0, { kind: 'discard', index: engine.players[0].hand.indexOf('east') }))).toBe(true)
}

describe('E03 authority conservation and continuous rounds', () => {
  it('protects a drawn joker on timeout while leaving manual joker discards legal', () => {
    const hand: TileType[] = ['m1','m2','m4','m5','m7','m8','p1','p4','p7','s1','s4','s7','north','red']
    const timed = scenario([hand,null,null,null])
    timed.expire(15_000)
    expect(timed.discardActions.at(-1)?.tile).not.toBe('red')
    expect(timed.players[0].hand).toContain('red')
    timed.assertConservation()
    const manual = scenario([hand,null,null,null])
    expect(manual.submit(manual.command(0,{kind:'discard',index:13}))).toBe(true)
    expect(manual.discardActions.at(-1)?.tile).toBe('red')
    manual.assertConservation()
  })
  it('settles three different conditional large hands from one source with exact payer totals', () => {
    const engine = scenario([
      ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'red'],
      ['m1', 'm1', 'm1', 'm9', 'm9', 'm9', 'p1', 'p1', 'p1', 'p9', 'p9', 'p9', 'red'],
      ['east', 'east', 'east', 'south', 'south', 'south', 'west', 'west', 'west', 'north', 'north', 'north', 'red'],
      ['s2', 's2', 's2', 's4', 's4', 's4', 's6', 's6', 's6', 's8', 's8', 's8', 'red'],
    ])
    engine.submit(engine.command(0, { kind: 'discard', index: 13 }))
    for (const seat of [1, 2, 3] as const) expect(engine.submit(engine.command(seat, { kind: 'win' }))).toBe(true)
    expect(engine.archives).toHaveLength(1)
    expect(engine.players.map(p => p.score)).toEqual([1000, 2220, 2600, 2180])
    expect(engine.seats.map(s => s.winCount)).toEqual([0, 1, 1, 1])
    engine.assertConservation()
  })
  it('opens the next action at the authority win beat and starts its deadline then', () => {
    const setup = scenario([[...waiting, 'east'], null, null, null])
    let now = 0
    const engine = new BloodFlowEngine({ ...setup.options, now: () => now, winBeatMs: 450 })
    engine.submit(engine.command(0, { kind: 'win' }))
    expect(engine.window!.opensAt).toBe(450)
    expect(engine.window!.deadlineAt).toBe(15_450)
    const action = engine.window!.options[1].find(a => a.kind === 'discard')!
    const command = engine.command(1, action)
    now = 449; expect(engine.submit(command)).toBe(false)
    now = 450; expect(engine.submit(command)).toBe(true)
  })
  it('collects three independent wins, archives once, rejects repeats, then lets a locked winner self-draw again', () => {
    // Force the dealer's hand to include the only remaining east.
    const hand0: TileType[] = ['m7', 'm8', 'm9', 'p4', 'p5', 'p6', 's4', 's5', 's6', 'p7', 'p8', 's7', 's8', 'east']
    const engine = scenario([hand0, waiting, waiting, waiting], undefined, false, 'red')
    discardEast(engine)
    expect(engine.window!.kind).toBe('win')
    const command = engine.command(1, { kind: 'win' })
    engine.submit(command)
    expect(engine.submit(command)).toBe(false)
    expect(engine.ledger).toHaveLength(0)
    engine.submit(engine.command(2, { kind: 'win' }))
    engine.submit(engine.command(3, { kind: 'win' }))
    expect(engine.archives).toHaveLength(1)
    expect(engine.ledger[0].kind).toBe('win')
    expect(engine.seats.map(s => s.winCount)).toEqual([0, 1, 1, 1])
    expect(engine.players.map(p => p.score)).toEqual([1520, 2160, 2160, 2160])
    expect(engine.submit(command)).toBe(false)
    const frozen = [...engine.players[1].hand.slice(0, -1)]
    expect(engine.window!.options[1].filter(a => a.kind === 'discard')).toEqual([{ kind: 'discard', index: 13 }])
    expect(engine.submit(engine.command(1, { kind: 'discard', index: 0 }))).toBe(false)
    expect(engine.submit(engine.command(1, { kind: 'win' }))).toBe(true)
    expect(engine.players[1].hand).toEqual(frozen)
    expect(engine.seats[1].winCount).toBe(2)
    expect(engine.players[2].score).toBeLessThan(2160) // an already-won player still pays
    engine.assertConservation()
  })

  it('last discard completes all winners before the single round summary', () => {
    const hand0: TileType[] = ['m7', 'm8', 'm9', 'p4', 'p5', 'p6', 's4', 's5', 's6', 'p7', 'p8', 's7', 's8', 'east']
    const engine = scenario([hand0, waiting, waiting, waiting], undefined, true)
    discardEast(engine)
    engine.submit(engine.command(1, { kind: 'win' }))
    engine.submit(engine.command(2, { kind: 'pass' }))
    expect(engine.result).toBeNull()
    engine.expire(15_000) // the third player's timeout counts as pass
    expect(engine.result!.winCounts).toEqual([0, 1, 0, 0])
    expect(engine.archives).toHaveLength(1)
    const result = engine.result
    engine.expire(100_000)
    expect(engine.result).toBe(result)
    expect(result!.winNet.reduce((a, b) => a + b)).toBe(0)
    expect(result!.ledger).toHaveLength(1)
  })

  it('robbed added kong preserves the original peng, archives its fourth tile and pays no kong fee', () => {
    const common: TileType[] = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'south', 'west']
    const hand0: TileType[] = ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'east']
    const engine = scenario([hand0, [...common, 'm4', 'm4'], [...common, 'p4', 'p4'], [...common, 's4', 's4']],
      [[{ type: 'peng', tile: 'east', tiles: ['east', 'east', 'east'], from: 1 }], [], [], []])
    engine.submit(engine.command(0, { kind: 'added-kong', meldIndex: 0 }))
    engine.assertConservation()
    expect(engine.players[0].melds[0].type).toBe('peng')
    for (const seat of [1, 2, 3] as const) engine.submit(engine.command(seat, { kind: 'win' }))
    expect(engine.players[0].melds[0].tiles).toHaveLength(3)
    expect(engine.archives).toHaveLength(1)
    expect(engine.ledger.filter(e => e.kind === 'kong')).toHaveLength(0)
    expect(engine.currentPlayer).toBe(1)
    expect(engine.players.map(p => p.score)).toEqual([1880, 2040, 2040, 2040])
    engine.assertConservation()
  })

  it('heaven win archives the explicitly recorded fourteenth tile', () => {
    const engine = scenario([[...waiting, 'east'], null, null, null])
    expect(engine.submit(engine.command(0, { kind: 'win' }))).toBe(true)
    expect(engine.archives[0].tile).toBe('east')
    expect(engine.players[0].hand).toEqual(waiting)
    expect(engine.seats[0].locked).toBe(true)
    expect(engine.result).toBeNull()
    expect(engine.publicState()).not.toHaveProperty('privateEvidence')
    expect(JSON.stringify(engine.publicState())).not.toContain('assignments')
  })

  it('commits successful concealed and wind kongs once with integer zero-sum fees', () => {
    const engine = scenario([['m1', 'm1', 'm1', 'm1', 'east', 'south', 'west', 'north', 'p4', 'p5', 'p6', 's4', 's5', 's6'], null, null, null])
    const command = engine.command(0, { kind: 'concealed-kong', tile: 'm1' })
    engine.submit(command)
    expect(engine.submit(command)).toBe(false)
    expect(engine.players.map(p => p.score)).toEqual([2060, 1980, 1980, 1980])
    engine.submit(engine.command(0, { kind: 'wind-kong' }))
    expect(engine.players.map(p => p.score)).toEqual([2120, 1960, 1960, 1960])
    expect(engine.ledger).toHaveLength(2)
    engine.assertConservation()
  })
})
