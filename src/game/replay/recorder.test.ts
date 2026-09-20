import { describe, expect, it, vi } from 'vitest'
import { createReplayRecorder, type ReplaySink } from './recorder'
import type { GamePlayer, Meld, TableActionType, TileType } from '../core/contracts/types'
import type { ReplayFrameSource } from './types'

// 录制器纯单测：直接驱动 hooks，覆盖全部 10 种桌动作映射、场次/连庄/收尾语义。
// （整场真实对局的集成断言在 recorder.sim.test.ts / lotusRecorder.sim.test.ts。）

const ALL_ACTIONS: TableActionType[] = [
  'peng', 'chi', 'discard-gang', 'concealed-gang', 'added-gang', 'flower-gang', 'wind-kong',
  'self-draw', 'discard-win', 'robbed-kong-win',
]

function makePlayer(seat: number): GamePlayer {
  return {
    name: `玩家${seat + 1}`,
    avatar: '',
    seat,
    score: 1000,
    hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 'p4'],
    discards: [],
    melds: [],
    redCount: 0,
    drawnTileIndex: -1,
  }
}

function makeFrame(overrides: Partial<ReplayFrameSource> = {}): ReplayFrameSource {
  return {
    players: [0, 1, 2, 3].map(makePlayer),
    wallLeft: 83,
    headDrawn: 0,
    currentPlayer: 0,
    round: 1,
    dealer: 0,
    honba: 0,
    matchType: 'east',
    diceValues: [3, 4],
    diceThrowerIndex: 0,
    ...overrides,
  }
}

function harness(sink?: Partial<ReplaySink>) {
  const saved = { matches: [] as unknown[], rounds: [] as unknown[] }
  const recorder = createReplayRecorder({
    sink: {
      saveMatch: (match) => { saved.matches.push(match); return sink?.saveMatch?.(match) },
      saveRound: (round) => { saved.rounds.push(round); return sink?.saveRound?.(round) },
    },
    meta: () => ({
      rulesetId: 'lotus-classic',
      rulesetName: '莲花广麻',
      themeName: 'jade',
      humanSeat: 0,
    }),
    now: () => 1_700_000_000_000,
    createId: (() => {
      let serial = 0
      return () => `match-${++serial}`
    })(),
  })
  return { recorder, saved }
}

// 场次 id 必须与分析区共用（§9.2）：分析录制在 phase=opening 开一场，而展示回放的场次记录
// 要到 roundStart 才建立；两边各自生成 id 的话，分析数据会在"按展示回放清单回收"时被整场删掉。
describe('录制器：场次 id 预留（与分析区共用同一把钥匙）', () => {
  it('先预留、后建场：场次 id 就是预留的那个', () => {
    const { recorder } = harness()
    const reserved = recorder.ensureMatchId()
    expect(reserved).toBe('match-1')
    // 预留不建场：此时还没有进行中的场次
    expect(recorder.active()).toBe(false)
    expect(recorder.snapshot().match).toBeNull()
    recorder.hooks.roundStart(makeFrame())
    expect(recorder.snapshot().match?.id, 'roundStart 建场时必须复用预留 id').toBe(reserved)
  })

  it('重复调用返回同一个 id（不会每次换一把钥匙）', () => {
    const { recorder } = harness()
    expect(recorder.ensureMatchId()).toBe(recorder.ensureMatchId())
  })

  it('场次进行中调用返回当前场次 id，不另开一场', () => {
    const { recorder } = harness()
    recorder.hooks.roundStart(makeFrame())
    const live = recorder.snapshot().match!.id
    expect(recorder.ensureMatchId()).toBe(live)
    expect(recorder.snapshot().stats.roundStarts).toBe(1)
  })

  it('下一场重新预留：不会沿用上一场的 id', () => {
    const { recorder } = harness()
    recorder.hooks.roundStart(makeFrame())
    const first = recorder.snapshot().match!.id
    recorder.finishAuto()
    const second = recorder.ensureMatchId()
    expect(second).not.toBe(first)
    recorder.hooks.roundStart(makeFrame())
    expect(recorder.snapshot().match?.id).toBe(second)
  })
})

describe('录制器：桌动作映射', () => {  it('10 种动作全部落成正确的事件类型与鸣牌种类', () => {
    const { recorder } = harness()
    const frame = makeFrame()
    recorder.hooks.roundStart(frame)

    ALL_ACTIONS.forEach((type, index) => {
      recorder.hooks.tableAction({
        type,
        actorIndex: 1,
        sourceIndex: type === 'self-draw' ? null : 0,
        tile: (index % 2 === 0 ? 'm5' : 'east') as TileType,
        meldIndex: index,
      }, frame)
    })
    recorder.hooks.roundEnd({ draw: true }, frame)

    const steps = recorder.snapshot().rounds[0].steps
    expect(steps).toHaveLength(ALL_ACTIONS.length)
    expect(steps.map((step) => step.actionType)).toEqual(ALL_ACTIONS)
    expect(steps.map((step) => step.kind)).toEqual([
      'peng', 'chi', 'gang-discard', 'gang-concealed', 'gang-added', 'gang-flower', 'gang-wind',
      undefined, undefined, undefined,
    ])
    expect(steps.map((step) => step.t)).toEqual([
      'meld', 'meld', 'meld', 'meld', 'meld', 'meld', 'meld',
      'win', 'win', 'win',
    ])
    // 自摸没有来源座位，点炮/抢杠有
    expect(steps[7].from).toBeNull()
    expect(steps[8].from).toBe(0)
    expect(steps[9].from).toBe(0)
    // 被鸣牌带走弃牌的座位要留下真实牌河
    expect(steps[0].sourceDiscards).toEqual([])
    expect(steps[0].state?.melds).toEqual([])
  })

  it('每步记录动作后的真实手牌/副露与真实牌河', () => {
    const { recorder } = harness()
    const frame = makeFrame()
    recorder.hooks.roundStart(frame)

    const actor = frame.players[1]
    actor.hand = ['m1', 'm2']
    actor.discards = ['p1', 'p2', 's3']
    actor.melds = [{ type: 'peng', tile: 's3', from: 0, tiles: ['s3', 's3', 's3'] } satisfies Meld]
    actor.drawnTileIndex = 1
    recorder.hooks.tableAction({ type: 'peng', actorIndex: 1, sourceIndex: 0, tile: 's3', meldIndex: 0 }, frame)
    recorder.hooks.roundEnd({ draw: true }, frame)

    const step = recorder.snapshot().rounds[0].steps[0]
    expect(step.seat).toBe(1)
    expect(step.state).toEqual({
      hand: ['m1', 'm2'],
      melds: [{ type: 'peng', tile: 's3', from: 0, tiles: ['s3', 's3', 's3'] }],
      drawnTileIndex: 1,
      redCount: 0,
      discards: ['p1', 'p2', 's3'],
    })
    expect(step.sourceDiscards).toEqual([])
  })

  it('摸牌/出牌记录墙数、牌头推进、当前家与最近弃牌 id', () => {
    const { recorder } = harness()
    const frame = makeFrame()
    recorder.hooks.roundStart(frame)

    frame.players[0].hand = [...frame.players[0].hand, 's9']
    frame.players[0].drawnTileIndex = 13
    recorder.hooks.draw({ seat: 0, tile: 's9', fromTail: false }, { ...frame, wallLeft: 82, headDrawn: 1 })

    frame.players[0].hand = frame.players[0].hand.filter((tile) => tile !== 's9')
    frame.players[0].discards = ['s9']
    frame.players[0].drawnTileIndex = -1
    recorder.hooks.discard({ seat: 0, tile: 's9', id: 42 }, { ...frame, wallLeft: 82, headDrawn: 1, currentPlayer: 1 })
    recorder.hooks.roundEnd({ draw: true }, frame)

    const [draw, discard] = recorder.snapshot().rounds[0].steps
    expect(draw).toMatchObject({ t: 'draw', tile: 's9', fromTail: false, wallLeft: 82, headDrawn: 1 })
    expect(draw.state?.drawnTileIndex).toBe(13)
    expect(discard).toMatchObject({ t: 'discard', tile: 's9', lastDiscardId: 42, wallLeft: 82, currentPlayer: 1 })
    expect(discard.state?.discards).toEqual(['s9'])
  })

  it('红中花牌：报出牌张与实进张不一致时按手牌收敛并标为补牌', () => {
    const { recorder } = harness()
    const frame = makeFrame()
    recorder.hooks.roundStart(frame)
    const player = frame.players[2]
    player.hand = ['m1', 'm2', 'm9']
    player.melds = [{ type: 'flower', tile: 'red', tiles: ['red'] }]
    player.drawnTileIndex = 2
    recorder.hooks.draw({ seat: 2, tile: 'red', fromTail: false }, frame)
    recorder.hooks.roundEnd({ draw: true }, frame)

    const step = recorder.snapshot().rounds[0].steps[0]
    expect(step.tile).toBe('m9')
    expect(step.fromTail).toBe(true)
    expect(step.state?.melds).toEqual([{ type: 'flower', tile: 'red', tiles: ['red'] }])
  })

  it('分数变化才带 scores（跟庄/杠/胡）', () => {
    const { recorder } = harness()
    const frame = makeFrame()
    recorder.hooks.roundStart(frame)
    recorder.hooks.draw({ seat: 0, tile: 'm1', fromTail: false }, frame)
    const changed = makeFrame({ wallLeft: 81, headDrawn: 2 })
    changed.players[0].score = 1100
    changed.players[1].score = 900
    recorder.hooks.draw({ seat: 1, tile: 'm2', fromTail: false }, changed)
    recorder.hooks.roundEnd({ draw: true }, changed)

    const steps = recorder.snapshot().rounds[0].steps
    expect(steps[0].scores).toBeUndefined()
    expect(steps[1].scores).toEqual([1100, 900, 1000, 1000])
  })
})

describe('录制器：场次与局', () => {
  it('连庄不新开场次，局序号连续', () => {
    const { recorder } = harness()
    const first = makeFrame()
    recorder.hooks.roundStart(first)
    recorder.hooks.roundEnd({ draw: true }, first)

    const repeat = makeFrame({ honba: 1 })
    recorder.hooks.roundStart(repeat)
    recorder.hooks.roundEnd({ draw: true }, repeat)

    const { match, rounds } = recorder.snapshot()
    expect(match?.id).toBe('match-1')
    expect(rounds.map((round) => [round.roundIndex, round.roundLabel, round.honba]))
      .toEqual([[1, '东1局', 0], [2, '东1局', 1]])
  })

  it('再次进入东1局本场0 视为新场次，旧场次按未完成收尾', () => {
    const saved = { matches: [] as Array<{ id: string; status: string }> }
    const { recorder } = harness({ saveMatch: (match) => { saved.matches.push(match) } })
    const first = makeFrame()
    recorder.hooks.roundStart(first)
    recorder.hooks.roundEnd({ draw: true }, first)

    const second = makeFrame({ round: 1, honba: 0 })
    recorder.hooks.roundStart(second)
    recorder.hooks.roundEnd({ draw: true }, second)

    expect(saved.matches.map((match) => [match.id, match.status])).toEqual([['match-1', 'aborted']])
    expect(recorder.snapshot().match?.id).toBe('match-2')
    expect(recorder.snapshot().rounds.map((round) => round.matchId)).toEqual(['match-2'])
  })

  it('一局都没打完时不落库', () => {
    const saved = { matches: 0, rounds: 0 }
    const { recorder } = harness({
      saveMatch: () => { saved.matches += 1 },
      saveRound: () => { saved.rounds += 1 },
    })
    const frame = makeFrame()
    recorder.hooks.roundStart(frame)
    // 开局即退出：进行中的局丢弃
    expect(recorder.finish('aborted')).toBeNull()
    expect(saved.matches).toBe(0)
    expect(saved.rounds).toBe(0)
    expect(recorder.active()).toBe(false)
  })

  it('局末落库并带结算快照与规范化结果', () => {
    const saved = { rounds: [] as Array<{ final: unknown }> }
    const { recorder } = harness({ saveRound: (round) => { saved.rounds.push(round) } })
    const frame = makeFrame()
    recorder.hooks.roundStart(frame)
    // 结算时模拟引擎的响应式代理（真实引擎的 result 是 Vue 深层代理）
    const result = { draw: false, winnerIndex: 0, winTile: 'm9' as TileType, winType: 'self-draw' as const, details: [{ label: '自摸', points: 300 }] }
    frame.players[0].hand = [...frame.players[0].hand, 'm9']
    recorder.hooks.roundEnd(result, frame)

    expect(saved.rounds).toHaveLength(1)
    const round = recorder.snapshot().rounds[0]
    expect(round.final?.winSeat).toBe(0)
    expect(round.final?.winTile).toBe('m9')
    expect(round.final?.draw).toBe(false)
    expect(round.final?.details).toEqual([{ label: '自摸', points: 300 }])
    expect(round.landedAt).toBe(1_700_000_000_000)
    // 落库对象必须是纯数据
    expect(() => structuredClone(round)).not.toThrow()
  })

  it('莲花麻将的翻精/精牌/断点/两次骰子被记录', () => {
    const { recorder } = harness()
    const frame = makeFrame({
      firstDice: [2, 5],
      diceValues: [6, 3],
      flipTile: 'p9',
      jokerTiles: ['p9', 'white'],
      wildcardTiles: ['white'],
      flipStack: 12,
      wallBreakIndex: 34,
    })
    recorder.hooks.roundStart(frame)
    recorder.hooks.roundEnd({ draw: true }, frame)

    const round = recorder.snapshot().rounds[0]
    expect(round.flipTile).toBe('p9')
    expect(round.jokerTiles).toEqual(['p9', 'white'])
    expect(round.wildcardTiles).toEqual(['white'])
    expect(round.flipStack).toBe(12)
    expect(round.wallBreakIndex).toBe(34)
    expect(round.dice).toEqual({ first: [2, 5], second: [6, 3] })
  })

  it('广麻未给精牌时兜底白板癞子（与牌桌兜底一致）', () => {
    const { recorder } = harness()
    const frame = makeFrame()
    recorder.hooks.roundStart(frame)
    recorder.hooks.roundEnd({ draw: true }, frame)
    const round = recorder.snapshot().rounds[0]
    expect(round.jokerTiles).toEqual(['white'])
    expect(round.wildcardTiles).toEqual([])
    expect(round.dice).toEqual({ first: undefined, second: [3, 4] })
  })
})

describe('录制器：收尾状态与名次', () => {
  function recordRounds(recorder: ReturnType<typeof harness>['recorder'], rounds: Array<{ round: number; scores: number[] }>) {
    rounds.forEach(({ round: roundNo, scores }, index) => {
      const frame = makeFrame({ round: roundNo, honba: index === 0 ? 0 : 0 })
      frame.players.forEach((player, seat) => { player.score = scores[seat] })
      recorder.hooks.roundStart(frame)
      recorder.hooks.roundEnd({ draw: true }, frame)
    })
  }

  it('打满东风场（到东4局）判定为 finished，缺 standings 时按末局分数排名', () => {
    const { recorder } = harness()
    recordRounds(recorder, [
      { round: 1, scores: [1000, 1000, 1000, 1000] },
      { round: 2, scores: [1200, 900, 1000, 900] },
      { round: 3, scores: [1200, 900, 1100, 800] },
      { round: 4, scores: [1300, 850, 1150, 700] },
    ])
    const match = recorder.finishAuto()!
    expect(match.status).toBe('finished')
    expect(match.myRank).toBe(1)
    expect(match.myScore).toBe(1300)
    expect(match.finalStandings?.map((entry) => [entry.seat, entry.rank]))
      .toEqual([[0, 1], [2, 2], [1, 3], [3, 4]])
    expect(match.roundCount).toBe(4)
  })

  it('中途退出（未到东4局）判定为 aborted，仍给出位次', () => {
    const { recorder } = harness()
    recordRounds(recorder, [
      { round: 1, scores: [800, 1200, 1000, 1000] },
      { round: 2, scores: [800, 1200, 1000, 1000] },
    ])
    const match = recorder.finish('aborted')!
    expect(match.status).toBe('aborted')
    expect(match.myRank).toBe(4)
    expect(match.summary).toContain('东2局')
  })

  it('传入权威 standings 时以它为准', () => {
    const { recorder } = harness()
    recordRounds(recorder, [{ round: 1, scores: [1000, 1000, 1000, 1000] }])
    const match = recorder.finish('aborted', [
      { seat: 0, name: '玩家1', score: 1000, rank: 3 },
      { seat: 1, name: '玩家2', score: 1000, rank: 1 },
      { seat: 2, name: '玩家3', score: 1000, rank: 2 },
      { seat: 3, name: '玩家4', score: 1000, rank: 4 },
    ])!
    expect(match.myRank).toBe(3)
    expect(match.finalStandings?.[1].rank).toBe(1)
  })

  it('落库异常一律吞掉：同步抛错与 Promise 拒绝都不得打断对局', async () => {
    const throwing = harness({
      saveRound: () => { throw new Error('quota') },
      saveMatch: () => { throw new Error('quota') },
    })
    const frame = makeFrame()
    throwing.recorder.hooks.roundStart(frame)
    expect(() => throwing.recorder.hooks.roundEnd({ draw: true }, frame)).not.toThrow()
    expect(() => throwing.recorder.finish('aborted')).not.toThrow()
    // 记录本身仍然有效（内存快照不依赖存储）
    expect(throwing.recorder.snapshot().rounds).toHaveLength(1)

    const rejecting = harness({
      saveRound: () => Promise.reject(new Error('quota')),
      saveMatch: () => Promise.reject(new Error('quota')),
    })
    rejecting.recorder.hooks.roundStart(makeFrame())
    expect(() => rejecting.recorder.hooks.roundEnd({ draw: true }, makeFrame())).not.toThrow()
    expect(() => rejecting.recorder.finish('aborted')).not.toThrow()
    await Promise.resolve()
  })
})
