import { describe, expect, it } from 'vitest'
import { replayReproduction, type ReproductionCommand } from './replayReproduction'
import type { AnalysisReproduction } from './types'
import { BloodFlowEngine } from '../../variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../../variants/lotus/bloodFlow/seatView'
import { SEATS, type BloodFlowOpeningState } from '../../variants/lotus/bloodFlow/state'
import type { GamePlayer, Meld, TileType } from '../../core/contracts/types'
import { createWall, tileName, TILE_TYPES } from '../../core/rules/tiles'

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
    // 当局开局分数：缺了它重跑只能从初始分起步，结束分数不可比对（§6 明列必需）。
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
      // 与录制侧一致：带窗口归属与窗口类型（§11 的两侧 kind 对照就靠这两个字段）
      ...(view.window ? { windowId: view.window.id, windowKind: view.window.kind } : {}),
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

/** 显示名 → 牌码（录制侧 `analysisCommandEntry` 落库的是牌码）。 */
const rawTileCode = (name: string) => TILE_TYPES.find(tile => tileName(tile) === name) ?? name

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

  // 回归：录制侧曾漏记 `openingScores`，于是第 2 局以后重跑从初始分起步，
  // 结束分数必然对不上（逐家净变化其实完全一致）。缺了就如实说缺，不许拿跑出来的数字冒充比对结果。
  it('记录缺开局分数时明确报"无从比对"，不得用初始分起步的结果冒充一致', () => {
    const { record, commands, scores } = playAndRecord()
    const { openingScores: _drop, ...withoutScores } = record
    void _drop
    const result = replayReproduction({ reproduction: withoutScores, commands, expectedScores: scores })
    expect(result.ok).toBe(false)
    expect(result.scoresMatch).toBeNull()
    expect(result.reason).toContain('openingScores')
  })

  it('auto 标记（权威机器人/超时代决）必须给出确切原因，而不是笼统的命令不足', () => {
    const { record, commands, scores } = playAndRecord()
    // 真实录像里的 auto 条目同样带 windowId/windowKind（记录侧只是没有该座位的选择）
    const marked = commands.map((command, index) => (index === 1
      ? { ...command, kind: 'auto', resolution: 'auto' as const }
      : command))
    const result = replayReproduction({ reproduction: record, commands: marked, expectedScores: scores })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('auto')
    expect(result.reason, '不能只说命令不足，要说清是权威机器人代决').toContain('权威机器人')
  })

  // 回归：真实录像里 `tile` 落库的是**牌码**（'south'），而候选动作的 tile 要经 `tileName` 归一
  // （'南风'）。此前直接拿归一后的候选去比未归一的记录，于是「同类候选与记录一模一样」也被判对不上 ——
  // 实测 round-1/window/33 的暗杠 south 就是这样中止整局重放的。
  it('记录里的牌写成牌码（录制侧原样格式）也必须匹配', () => {
    const { record, commands, scores } = playAndRecord()
    const withTiles = commands.filter(command => command.tile !== undefined)
    expect(withTiles.length, '合成局应含带牌种的动作，否则本用例证明不了什么').toBeGreaterThan(0)
    const rawCoded = commands.map(command => (command.tile === undefined
      ? command : { ...command, tile: rawTileCode(command.tile) }))
    expect(rawCoded.some(command => command.tile === 'south' || /^[mps][1-9]$/.test(command.tile ?? '')),
      '确实转换成了牌码').toBe(true)
    const result = replayReproduction({ reproduction: record, commands: rawCoded, expectedScores: scores })
    expect(result.reason).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.scoresMatch).toBe(true)
  })

  it('牌码与显示名混用也照样匹配（旧记录不能因为写法不同而失效）', () => {
    const { record, commands, scores } = playAndRecord()
    const mixed = commands.map((command, index) => (command.tile === undefined || index % 2 === 0
      ? command : { ...command, tile: rawTileCode(command.tile) }))
    const result = replayReproduction({ reproduction: record, commands: mixed, expectedScores: scores })
    expect(result.reason).toBeNull()
    expect(result.ok).toBe(true)
  })

  it('每条命令都带窗口归属：缺 windowId 会被计入诊断（排序会把它甩到末尾）', () => {
    const { record, commands, scores } = playAndRecord()
    const stripped = commands.map(command => ({ ...command, windowId: undefined }))
    const result = replayReproduction({ reproduction: record, commands: stripped, expectedScores: scores })
    // 缺归属时要么失败并报出"无窗口归属条目"，要么（碰巧顺序仍对）成功；但绝不能悄悄跑错还要说成功
    if (!result.ok) expect(result.reason).toContain('无窗口归属条目')
    else expect(result.scoresMatch).toBe(true)
  })

  it('两侧窗口类型不一致时，诊断要说清是序列错位（§11）', () => {
    const { record, commands, scores } = playAndRecord()
    // 把记录里的窗口类型全部改成错的，并让第一条命令变成非法动作 ⇒ 失败信息必须点出 kind 不一致
    const tampered = commands.map((command, index) => ({
      ...command,
      windowKind: 'peng',
      ...(index === 0 ? { kind: 'peng', tile: 'white' } : {}),
    }))
    const result = replayReproduction({ reproduction: record, commands: tampered, expectedScores: scores })
    expect(result.ok).toBe(false)
    expect(result.kindMismatches).toBeGreaterThan(0)
    expect(result.reason).toContain('kind 不一致')
    expect(result.reason).toContain('记录说该编号是')
  })

  it('正常录像里两侧窗口类型逐点对应：kindMismatches 为 0', () => {
    const { record, commands, scores } = playAndRecord()
    const result = replayReproduction({ reproduction: record, commands, expectedScores: scores })
    expect(result.ok).toBe(true)
    expect(result.kindMismatches, '同编号窗口的 kind 应两侧一致').toBe(0)
  })
})
