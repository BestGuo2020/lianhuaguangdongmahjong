import { describe, expect, it } from 'vitest'
import { replayReproduction, type ReproductionCommand } from './replayReproduction'
import type { AnalysisReproduction } from './types'
import { BloodFlowEngine } from '../../variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../../variants/lotus/bloodFlow/seatView'
import { SEATS, type BloodFlowOpeningState } from '../../variants/lotus/bloodFlow/state'
import type { GamePlayer, Meld, TileType } from '../../core/contracts/types'
import { createWall, tileName } from '../../core/rules/tiles'

// §10.6：用赛后复现数据重跑一局，看是否到达同一结束状态。
// 这里先合成一局（真实引擎打满），把牌墙/手牌/开局参数/命令序列按记录格式存下来，再校验。
// 反例与"记录不足"都必须明确失败——校验器说"一致"而不一致，比不校验更糟。

function buildOpening(): BloodFlowOpeningState {
  const pool = createWall()
  const remove = (tile: TileType) => { const index = pool.indexOf(tile); if (index >= 0) pool.splice(index, 1) }
  const flipTiles: [TileType, TileType] = ['p9', 'white']
  flipTiles.forEach(remove)
  const players = SEATS.map((seat): GamePlayer => ({
    seat, name: `P${seat}`, avatar: '', score: 2000,
    hand: pool.splice(0, seat === 0 ? 14 : 13),
    melds: [] as Meld[], discards: [], redCount: 0, drawnTileIndex: -1,
  }))
  return {
    players, wall: pool, flipTiles, jokers: ['red', 'green'],
    headDrawn: 134 - pool.length, dealerDrawnIndex: players[0].hand.length - 1,
    flipStack: 0, flipSeat: 0, wallBreakIndex: 2,
  }
}

/** 把引擎开局转成记录格式（与 useBloodFlowGame 落库的字段一一对应）。 */
function asRecord(opening: BloodFlowOpeningState, roundIndex = 1): AnalysisReproduction {
  return {
    roundIndex,
    available: true,
    initialWall: opening.wall.map(tile => tileName(tile)),
    initialHands: opening.players.map(player => player.hand.map(tile => tileName(tile))),
    dealer: opening.players[opening.flipSeat] ? 0 : 0,
    dealerDrawnIndex: opening.dealerDrawnIndex,
    flipTiles: opening.flipTiles.map(tile => tileName(tile)),
    jokers: opening.jokers.map(tile => tileName(tile)),
    flipStack: opening.flipStack,
    flipSeat: opening.flipSeat,
    wallBreakIndex: opening.wallBreakIndex,
    openingScores: opening.players.map(player => player.score),
  }
}

/** 真打一局：逐窗口挑第一个合法动作、记录下来并提交，直到结算。 */
function playAndRecord(): { record: AnalysisReproduction; commands: ReproductionCommand[]; scores: number[] } {
  const opening = buildOpening()
  const engine = new BloodFlowEngine({ authorityEpoch: 'test', roundId: 'round-1', opening: structuredClone(opening), now: () => 0, winBeatMs: 0 })
  const commands: ReproductionCommand[] = []
  for (let step = 0; step < 5_000 && !engine.result; step += 1) {
    const seats = SEATS.filter(seat => bloodFlowSeatView(engine, seat).ownActions.length > 0)
    if (!seats.length) { const id = engine.window?.id; if (id) engine.expire(0, id); else break; continue }
    const seat = seats[0]
    const view = bloodFlowSeatView(engine, seat)
    const action = view.ownActions[0] as unknown as { kind: string; tile?: TileType; index?: number; from?: number | null; meldIndex?: number }
    commands.push({
      seat,
      kind: action.kind,
      ...(action.tile !== undefined ? { tile: tileName(action.tile) } : {}),
      ...(action.index !== undefined ? { handIndex: action.index } : {}),
      ...(action.from !== undefined ? { from: action.from } : {}),
      ...(action.meldIndex !== undefined ? { meldIndex: action.meldIndex } : {}),
    })
    engine.submit(engine.command(seat, action as never))
    const id = view.window?.id ?? engine.window?.id
    if (id) engine.expire(0, id)
  }
  return { record: asRecord(opening), commands, scores: engine.players.map(player => player.score) }
}

describe('赛后复现校验（§10.6）', () => {
  it('正例：按记录重跑能到达同一结束状态', () => {
    const { record, commands, scores } = playAndRecord()
    expect(commands.length, '合成的一局应当有命令').toBeGreaterThan(0)
    const result = replayReproduction({ reproduction: record, commands, expectedScores: scores })
    expect(result.reason).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.scoresMatch).toBe(true)
    expect(result.submitted).toBe(commands.length)
    expect(result.finalScores).toEqual(scores)
  })

  it('不做终局比对时（没有期望分数）只证明能跑完，不谎称结果一致', () => {
    const { record, commands } = playAndRecord()
    const result = replayReproduction({ reproduction: record, commands })
    expect(result.ok).toBe(true)
    expect(result.scoresMatch).toBeNull()
  })

  it('反例：命令被改成当时非法的动作 ⇒ 必须报对不上，而不是照旧成功', () => {
    const { record, commands, scores } = playAndRecord()
    // 只改牌种可能仍是合法动作（同花色的另一张），因此改成当时必然非法的类型
    const tampered = commands.map((command, index) => (index === 0 ? { ...command, kind: 'peng', tile: 'white' } : command))
    const result = replayReproduction({ reproduction: record, commands: tampered, expectedScores: scores })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('对不上')
  })

  it('反例：命令序列整体错位 ⇒ 必须被挡住，不得悄悄跑完', () => {
    const { record, commands, scores } = playAndRecord()
    // 去掉最前面一条，让后续命令与窗口对不上
    const shifted = commands.slice(1)
    const result = replayReproduction({ reproduction: record, commands: shifted, expectedScores: scores })
    if (!result.ok) expect(result.reason).toBeTruthy()
    else expect(result.scoresMatch).toBe(false)   // 若仍能跑完，结束分数必须与记录不同
  })

  it('记录不足：命令少了最后一条 ⇒ 必须报记录不足，不得假装成功', () => {
    const { record, commands, scores } = playAndRecord()
    const result = replayReproduction({ reproduction: record, commands: commands.slice(0, -1), expectedScores: scores })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不完整')
  })

  it('复现数据缺字段时直接失败（交给 openingFromReproduction 判断）', () => {
    const { record, commands } = playAndRecord()
    const broken: AnalysisReproduction = { ...record, initialHands: undefined }
    const result = replayReproduction({ reproduction: broken, commands })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('initialHands')
  })

  it('auto 标记（权威机器人/超时代决）必须给出确切原因，而不是笼统的命令不足', () => {
    const { record, commands, scores } = playAndRecord()
    const marked = commands.map((command, index) => (index === 1
      ? { seat: command.seat, kind: 'auto', resolution: 'auto' as const }
      : command))
    const result = replayReproduction({ reproduction: record, commands: marked, expectedScores: scores })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('auto')
    expect(result.reason, '不能只说命令不足，要说清是权威机器人代决').toContain('权威机器人')
  })
})
