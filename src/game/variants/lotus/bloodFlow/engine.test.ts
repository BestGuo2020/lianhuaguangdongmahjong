import { describe, expect, it } from 'vitest'
import type { GamePlayer, Meld, TileType } from '../../../core/contracts/types'
import { createWall } from '../../../core/rules/tiles'
import { BloodFlowEngine } from './engine'
import type { BloodFlowAction, BloodFlowOpeningState } from './state'
import { SEATS } from './state'
import { bloodFlowSeatView } from './seatView'

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

const claimHand: TileType[] = ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east']
const discarder: TileType[] = ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5']
/** 不参与 m5/east 响应的普通手牌（用于隔离被测座位）。 */
const noClaim: TileType[] = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'south', 'west', 'north']

describe('锁手与杠的时机（2026-09-10 用户报错）', () => {
  it('锁手后仍可点炮继续胡，但不能过胡（胡是唯一选项）', () => {
    const hand0: TileType[] = ['m7', 'm8', 'm9', 'p4', 'p5', 'p6', 's4', 's5', 's6', 'p7', 'p8', 's7', 's8', 'east']
    const index = (engine: BloodFlowEngine) => engine.players[0].hand.indexOf('east')
    // 未锁手：同一窗口同时给「胡」与「过」——锁手之前允许过胡（用户确认）。
    const open = scenario([hand0, waiting, noClaim, noClaim])
    open.submit(open.command(0, { kind: 'discard', index: index(open) }))
    expect(open.window!.options[1]).toEqual([{ kind: 'win' }, { kind: 'pass' }])

    // 已锁手：点炮胡照给（任意听依然能在弃牌上胡），但不给「过」。
    const locked = scenario([hand0, waiting, noClaim, noClaim])
    locked.seats[1] = { ...locked.seats[1], locked: true }
    locked.submit(locked.command(0, { kind: 'discard', index: index(locked) }))
    expect(locked.window!.options[1]).toEqual([{ kind: 'win' }])
  })

  it('锁手后自摸窗口也不给「过」：只能胡或打掉摸牌', () => {
    // 座位 1 锁手且听 east；庄家打牌后下家摸到 east → 自摸窗口。
    const engine = scenario([discarder, waiting, noClaim, noClaim], undefined, false, 'east')
    engine.seats[1] = { ...engine.seats[1], locked: true }
    expect(engine.submit(engine.command(0, { kind: 'discard', index: 13 }))).toBe(true)
    const window = engine.window!
    expect(window.kind).toBe('turn')
    const kinds = window.options[1].map(a => a.kind)
    expect(kinds).toContain('win')
    expect(kinds).not.toContain('pass')
    expect(kinds.filter(kind => kind === 'discard')).toHaveLength(1)   // 只能打摸上来的那张
  })

  it('碰/吃之后的这一手只能出牌，不能立刻开杠（对齐经典 userDrewThisTurn 门控）', () => {
    const engine = scenario([discarder, claimHand, noClaim, noClaim])
    engine.submit(engine.command(0, { kind: 'discard', index: 13 }))   // 打出 m5（claimHand 有 3 张）
    const claim = engine.window!
    expect(claim.options[1].some(a => a.kind === 'peng')).toBe(true)
    engine.submit(engine.command(1, { kind: 'peng' }))
    const turn = engine.window!
    expect(turn.kind).toBe('turn')
    // 碰后手里还剩 1 张 m5（老规则会给补杠）：本手没摸牌 → 只能出牌。
    const kinds = turn.options[1].map(a => a.kind)
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds.every(kind => kind === 'discard')).toBe(true)
  })

  it('摸牌后的这一手仍然提供开杠（门控只针对「非摸牌」回合）', () => {
    const kongHand: TileType[] = ['m5', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 's7', 's8', 's9', 'east']
    const engine = scenario([kongHand, noClaim, noClaim, noClaim])
    // 庄家开局首回合视作已摸牌（跳牌）：暗杠候选保留。
    expect(engine.window!.options[0].some(a => a.kind === 'concealed-kong' && a.tile === 'm5')).toBe(true)
  })
})

describe('normal-speed local action boundaries', () => {
  it.each<BloodFlowAction>([{kind:'peng'}, {kind:'chi',tiles:['m3','m4','m5']}, {kind:'gang'}])('finishes $kind before opening the next decision', action => {
    let now = 100
    const base = scenario([discarder, claimHand, null, null])
    const engine = new BloodFlowEngine({...base.options, paced:true, now:()=>now})
    const command = engine.command(0,{kind:'discard',index:13})
    engine.submit(command)
    const stage = engine.transition!
    expect(stage.kind).toBe('discard')
    expect(engine.window).toBeNull()
    expect(engine.players[0].discards).toContain('m5')
    expect(engine.advance(stage.id)).toBe(false)
    expect(engine.submit(command)).toBe(false)
    now = stage.readyAt; expect(engine.advance(stage.id)).toBe(true)
    const claim = engine.window!
    engine.submit(engine.command(1,action)); passRemaining(engine,claim.id)
    expect(engine.window).toBeNull()
    expect(engine.players[1].melds).toHaveLength(1)
    expect(engine.players[1].drawnTileIndex).toBe(-1)
    const wallCount = engine.wall.length
    const groupStage = engine.transition!
    now = groupStage.readyAt; engine.advance(groupStage.id)
    expect(engine.advance(groupStage.id)).toBe(false)
    if (action.kind === 'gang') {
      expect(engine.wall.length).toBe(wallCount-1)
      expect(engine.transition?.kind).toBe('draw')
      expect(engine.window).toBeNull()
      now = engine.transition!.readyAt; engine.advance(engine.transition!.id)
    } else expect(engine.wall.length).toBe(wallCount)
    expect(engine.window?.kind).toBe('turn')
    expect(engine.window!.deadlineAt-now).toBe(15000)
    engine.assertConservation()
  })
  it('commits a win once, holds the source-to-payment beat, then draws exactly once', () => {
    let now=0
    const base=scenario([[...waiting,'east'],null,null,null])
    const engine=new BloodFlowEngine({...base.options,paced:true,now:()=>now})
    const command=engine.command(0,{kind:'win'}),wallCount=engine.wall.length
    engine.submit(command)
    const stage=engine.transition!,scores=engine.players.map(p=>p.score)
    expect(stage.kind).toBe('win');expect(stage.readyAt).toBeGreaterThanOrEqual(2000)
    expect(engine.wall.length).toBe(wallCount);expect(engine.window).toBeNull()
    expect(engine.submit(command)).toBe(false)
    now=stage.readyAt;engine.advance(stage.id);engine.advance(stage.id)
    expect(engine.wall.length).toBe(wallCount-1)
    expect(engine.players.map(p=>p.score)).toEqual(scores)
    expect(engine.ledger).toHaveLength(1)
    expect(engine.transition?.kind).toBe('draw')
  })
})
function discardFive(engine: BloodFlowEngine) {
  expect(engine.submit(engine.command(0, { kind: 'discard', index: engine.players[0].hand.indexOf('m5') }))).toBe(true)
}
function passRemaining(engine: BloodFlowEngine, windowId: string) {
  for (const seat of SEATS) if (engine.window?.id === windowId && engine.window.options[seat].length && !engine.window.decisions[seat]) {
    // 锁手座位没有「过」：按规则提交它唯一的「胡」。
    const forced = engine.seats[seat].locked
      ? engine.window.options[seat].find(a => a.kind === 'win') : undefined
    expect(engine.submit(engine.command(seat, forced ?? { kind: 'pass' }))).toBe(true)
  }
}

describe('shared discard response choices', () => {
  it.each<BloodFlowAction>([{ kind: 'peng' }, { kind: 'gang' }, { kind: 'chi', tiles: ['m3', 'm4', 'm5'] }])(
    'allows $kind directly alongside hu in one window', action => {
      const engine = scenario([discarder, claimHand, null, null])
      discardFive(engine)
      const window = engine.window!
      expect(bloodFlowSeatView(engine, 1).ownActions).toEqual(expect.arrayContaining([
        { kind: 'win' }, { kind: 'peng' }, { kind: 'gang' }, { kind: 'chi', tiles: ['m3', 'm4', 'm5'] }, { kind: 'pass' },
      ]))
      expect(engine.submit(engine.command(1, action))).toBe(true)
      passRemaining(engine, window.id)
      expect(engine.players[1].melds[0].type).toBe(action.kind)
      expect(engine.players[0].discards).not.toContain('m5')
      expect(engine.currentPlayer).toBe(1)
      expect(engine.window!.kind).toBe('turn')
      expect(engine.archives).toHaveLength(0)
      engine.assertConservation()
    },
  )
  it('passing once skips every offered claim on that discard', () => {
    const engine = scenario([discarder, claimHand, null, null])
    discardFive(engine)
    const window = engine.window!
    passRemaining(engine, window.id)
    expect(engine.window!.kind).toBe('turn')
    expect(engine.players[1].melds).toHaveLength(0)
    expect(engine.players[0].discards).toContain('m5')
    engine.assertConservation()
  })
  it('waits for another hu decision and gives it priority over an already selected peng', () => {
    const otherWait: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm6', 'p4', 'p5', 'p6', 's4', 's5', 's6', 'south', 'south']
    const engine = scenario([discarder, claimHand, otherWait, null])
    discardFive(engine)
    const window = engine.window!
    expect(engine.submit(engine.command(1, { kind: 'peng' }))).toBe(true)
    expect(engine.window!.id).toBe(window.id)
    expect(engine.players[1].melds).toHaveLength(0)
    expect(engine.submit(engine.command(2, { kind: 'win' }))).toBe(true)
    passRemaining(engine, window.id)
    expect(engine.players[1].melds).toHaveLength(0)
    expect(engine.seats[2].winCount).toBe(1)
    expect(engine.archives).toHaveLength(1)
    engine.assertConservation()
  })
  it('includes a nonwinning peng claimant while another seat is deciding hu', () => {
    const otherWait: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm6', 'p4', 'p5', 'p6', 's4', 's5', 's6', 'south', 'south']
    const pengHand = [...claimHand]; pengHand[4] = 'north'
    const engine = scenario([discarder, pengHand, otherWait, null])
    discardFive(engine)
    const window = engine.window!
    expect(window.options[1]).toContainEqual({ kind: 'peng' })
    expect(window.options[1]).not.toContainEqual({ kind: 'win' })
    expect(window.options[2]).toContainEqual({ kind: 'win' })
    expect(engine.submit(engine.command(1, { kind: 'peng' }))).toBe(true)
    passRemaining(engine, window.id)
    expect(engine.players[1].melds[0].type).toBe('peng')
    expect(engine.window!.kind).toBe('turn')
    engine.assertConservation()
  })
  it('offers only hu/pass for a last-discard claim', kind => {
    const engine = scenario([discarder, claimHand, null, null], undefined, true)
    discardFive(engine)
    expect(engine.window!.options[1]).toEqual([{ kind: 'win' }, { kind: 'pass' }])
    passRemaining(engine, engine.window!.id)
    expect(engine.result).not.toBeNull()
    engine.assertConservation()
  })
  it('锁手座位在弃牌响应窗口里只有「胡」（不得过胡）', () => {
    const engine = scenario([discarder, claimHand, null, null])
    engine.seats[1] = { ...engine.seats[1], locked: true }
    discardFive(engine)
    expect(engine.window!.options[1]).toEqual([{ kind: 'win' }])
    passRemaining(engine, engine.window!.id)
    engine.assertConservation()
  })
})

describe('E03 authority conservation and continuous rounds', () => {
  it.each([14, 11, 8, 5, 2])('keeps the marked draw at the right edge of a %i-tile turn after a sorted opening', (count) => {
    const melds: Meld[] = Array.from({ length: (14 - count) / 3 }, (_, i) => ({
      type: 'peng', tile: `p${i + 1}` as TileType, tiles: Array(3).fill(`p${i + 1}`) as TileType[], from: 1,
    }))
    const hand = (['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 's1', 's2', 's3', 's4', 's5'] as TileType[]).slice(0, count)
    const base = scenario([hand, null, null, null], [melds, [], [], []])
    const opening = structuredClone(base.options.opening!)
    opening.dealerDrawnIndex = 0 // Sorting has placed the actual extra tile at the left edge.
    const engine = new BloodFlowEngine({ ...base.options, opening })
    const player = engine.players[0]
    expect(player.hand).toEqual([...hand.slice(1), hand[0]])
    expect(player.drawnTileIndex).toBe(count - 1)
    expect(engine.window!.source.tile).toBe(hand[0])
    engine.assertConservation()
  })
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
    expect(engine.players.map(p => p.score)).toEqual([-200, 2540, 3280, 2380])
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
    for (const seat of [1, 2, 3] as const) expect(engine.window!.options[seat]).toEqual([{ kind: 'win' }, { kind: 'pass' }])
    engine.assertConservation()
    expect(engine.players[0].melds[0].type).toBe('peng')
    for (const seat of [1, 2, 3] as const) engine.submit(engine.command(seat, { kind: 'win' }))
    expect(engine.players[0].melds[0].tiles).toHaveLength(3)
    expect(engine.archives).toHaveLength(1)
    expect(engine.ledger.filter(e => e.kind === 'kong')).toHaveLength(0)
    expect(engine.currentPlayer).toBe(1)
    expect(engine.players.map(p => p.score)).toEqual([1760, 2080, 2080, 2080])
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
