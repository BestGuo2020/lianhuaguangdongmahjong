import { describe, expect, it } from 'vitest'
import {
  actionMatchKey,
  chosenIndex,
  choiceTookEffect,
  decisionStateId,
  decisionStateOf,
  decisionWindowOf,
  isNextSeat,
  legalActionId,
  legalActionsOf,
  lotusSeatView,
  normalizeAction,
  observableOf,
  roundIdOf,
  seatActionsOf,
  settlementsFromRound,
  toLotusActionLike,
  windowIdOf,
  windowKindOfMethod,
  type LotusSeatView,
  type LotusTableSnapshot,
  type LotusWindowDescriptor,
} from './lotusLegacyAdapter'
import { LOTUS_RULESET } from '../../variants/lotus/lotusRules'
import type { Meld, TileType } from '../../core/contracts/types'

// 莲花麻将·翻精癞子 → 分析模型的纯适配（§3.1／§3.2／§3.3／§3.4／§5）：
// 稳定 ID、窗口类型、前态投影（含遮蔽）、合法动作一一对应、结算折算与执行回执口径。

const RULESET = LOTUS_RULESET

/** 一副能确定判定的手牌：m1m1m1 / m234 / p567 / s789 + 东东 对子（14 张，无精）。 */
const WINNING_HAND: TileType[] = [
  'm1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p5', 'p6', 'p7', 's7', 's8', 's9', 'east', 'east',
]
/** 同前但把将对子打散 ⇒ 不成和。 */
const NOT_WINNING_HAND: TileType[] = [
  'm1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p5', 'p6', 'p7', 's7', 's8', 's9', 'east', 'south',
]

function table(overrides: Partial<LotusTableSnapshot> = {}): LotusTableSnapshot {
  return {
    // 四家：0 号座是本家（14 张和牌），其余只给"别家实情"——投影必须把它们遮掉。
    players: [
      { hand: [...WINNING_HAND], melds: [], discards: ['p9'], drawnTileIndex: 13, score: 2_000 },
      { hand: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p1', 'p2', 'p3', 's1'], melds: [], discards: ['p1'], score: 1_900 },
      { hand: ['s2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 'p1', 'p2', 'p4', 'p6', 'p8'], melds: [], discards: [], score: 2_100 },
      { hand: ['east', 'east', 'east', 'west', 'west', 'north', 'north', 'red', 'red', 'green', 'green', 'white', 'white'], melds: [], discards: [], score: 2_000 },
    ],
    jokers: [],
    wildcardTiles: ['white'],
    ...overrides,
  }
}

function windowOf(overrides: Partial<LotusWindowDescriptor> = {}): LotusWindowDescriptor {
  return { windowId: 'round-1/window/1', roundId: 'round-1', kind: 'draw-turn', seat: 0, ...overrides }
}

describe('翻精癞子适配层：窗口与 ID', () => {
  it('窗口 ID 是「本局 + 本局内第 N 次决策」：同局面稳定，跨局不重复', () => {
    expect(windowIdOf('round-1', 3)).toBe('round-1/window/3')
    expect(windowIdOf('round-1', 3)).toBe(windowIdOf('round-1', 3))
    expect(windowIdOf('round-2', 3)).not.toBe(windowIdOf('round-1', 3))
    expect(roundIdOf(1)).toBe('round-1')
    expect(roundIdOf(4)).toBe('round-4')
  })

  it('窗口内稳定 ID：同一窗口同一下标恒等，且与窗口绑定', () => {
    expect(legalActionId('w1', 2)).toBe('w1/2')
    expect(legalActionId('w1', 2)).toBe(legalActionId('w1', 2))
    expect(legalActionId('w2', 2)).not.toBe(legalActionId('w1', 2))
  })

  it('窗口类型：回合=draw-turn，胡/碰杠/吃=claim，抢杠=rob-kong', () => {
    expect(windowKindOfMethod('requestTurn')).toBe('draw-turn')
    expect(windowKindOfMethod('requestDiscardHu')).toBe('claim')
    expect(windowKindOfMethod('requestClaim')).toBe('claim')
    expect(windowKindOfMethod('requestChi')).toBe('claim')
    expect(windowKindOfMethod('requestRobKong')).toBe('rob-kong')
    // 前态 ID 与窗口绑定：同一 (窗口, 座位) 就是同一份前态
    const view = lotusSeatView(table(), windowOf(), RULESET)
    expect(decisionStateId(view)).toBe('round-1/window/1/0')
  })
})

describe('翻精癞子适配层：动作规范化', () => {
  it('规范化保留下标语义，未提供的字段不得凭空出现', () => {
    expect(normalizeAction('w1', 0, { kind: 'discard', tile: 'm5', handIndex: 3 }))
      .toEqual({ id: 'w1/0', kind: 'discard', tile: 'm5', handIndex: 3 })
    expect(Object.keys(normalizeAction('w1', 1, { kind: 'pass' }))).toEqual(['id', 'kind'])
  })

  it('控制器动作形状三套都能读：动作对象 / 吃的 ChiMeld / 抢杠的裸字符串', () => {
    expect(toLotusActionLike({ kind: 'discard', handIndex: 4 })).toEqual({ kind: 'discard', handIndex: 4 })
    expect(toLotusActionLike({ kind: 'chi', meld: { kind: 'sequence', tiles: ['p1', 'p2', 'p3'] } }))
      .toEqual({ kind: 'chi', meld: ['p1', 'p2', 'p3'] })
    expect(toLotusActionLike('win')).toEqual({ kind: 'win' })
    expect(toLotusActionLike('pass')).toEqual({ kind: 'pass' })
    // 认不出来的形状不得瞎猜成一个动作
    expect(toLotusActionLike('kong')).toBeNull()
    expect(toLotusActionLike(null)).toBeNull()
    expect(toLotusActionLike({})).toBeNull()
  })

  it('匹配键只取能区分窗口内选项的字段：同牌不同下标不是同一个选项', () => {
    expect(actionMatchKey({ kind: 'discard', handIndex: 3 })).not.toBe(actionMatchKey({ kind: 'discard', handIndex: 4 }))
    expect(actionMatchKey({ kind: 'discard', tile: 'm5', handIndex: 3 })).toBe(actionMatchKey({ kind: 'discard', handIndex: 3 }))
    expect(actionMatchKey({ kind: 'chi', meld: ['p3', 'p1', 'p2'] })).toBe(actionMatchKey({ kind: 'chi', meld: ['p1', 'p2', 'p3'] }))
    expect(actionMatchKey({ kind: 'added-kong', meldIndex: 1 })).not.toBe(actionMatchKey({ kind: 'added-kong', meldIndex: 0 }))
    expect(actionMatchKey({ kind: 'pass' })).toBe('pass')
  })
})

describe('翻精癞子适配层：合法动作', () => {
  it('摸牌回合：可和 + 每张手牌一个弃牌选项（下标即手牌位置）', () => {
    const view = lotusSeatView(table(), windowOf(), RULESET)
    expect(view.canWin).toBe(true)
    expect(view.drawnTileIndex).toBe(13)
    const actions = legalActionsOf(view)
    // 首个是胡，其后 14 个弃牌
    expect(actions[0]).toMatchObject({ kind: 'win', id: 'round-1/window/1/0' })
    const discards = actions.filter((action) => action.kind === 'discard')
    expect(discards).toHaveLength(WINNING_HAND.length)
    // 下标与手牌一一对应（摸切/锁手依赖这个语义，不能只存牌种）
    discards.forEach((action, index) => {
      expect(action.handIndex).toBe(index)
      expect(action.tile).toBe(WINNING_HAND[index])
      expect(action.id).toBe(legalActionId('round-1/window/1', index + 1))
    })
    // 不成和的手牌：没有胡选项
    const notWin = lotusSeatView(
      table({ players: [{ hand: [...NOT_WINNING_HAND], melds: [], discards: [], drawnTileIndex: 13, score: 2_000 }] }),
      windowOf(), RULESET,
    )
    expect(notWin.canWin).toBe(false)
    expect(seatActionsOf(notWin).some((action) => action.kind === 'win')).toBe(false)
  })

  it('摸牌回合：补杠/暗杠/风杠按引擎同一套判定给出', () => {
    const peng: Meld = { type: 'peng', tile: 'p5', tiles: ['p5', 'p5', 'p5'] }
    const hand: TileType[] = ['p5', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 'east', 'south', 'west', 'north', 'red', 'red']
    const view = lotusSeatView(
      table({ players: [{ hand, melds: [peng], discards: [], drawnTileIndex: 13, score: 2_000 }] }),
      windowOf(), RULESET,
    )
    // 碰过 p5 且手里还有一张 p5 ⇒ 可补杠（meldIndex 0）
    expect(view.addedKongIndexes).toEqual([0])
    // 东南西北各一张 ⇒ 可风杠
    expect(view.windKong).toBe(true)
    const actions = seatActionsOf(view)
    expect(actions).toContainEqual({ kind: 'added-kong', meldIndex: 0, tile: 'p5' })
    expect(actions).toContainEqual({ kind: 'wind-kong' })
    // 手里没有 4 张相同 ⇒ 无暗杠
    expect(view.concealedKongs).toEqual([])
  })

  it('响应窗口：胡 > 杠 > 碰 > 吃 > 过，吃只有下家才有', () => {
    // 手上 p3×3 + p1p2 ⇒ 既能杠能碰也能吃；两张风牌不成对，所以加进 p3 也不成和，
    // 这样优先级断言才落在"杠在最前"上（成和时 win 会正确地排到更前面）。
    const hand: TileType[] = ['p3', 'p3', 'p3', 'p1', 'p2', 's5', 's6', 's7', 'm1', 'm2', 'm3', 'east', 'south']
    // 1 号座是 0 号座的下家（4 人桌），被弃的是 p3
    const next = lotusSeatView(
      table({ players: [{ hand: [], melds: [], discards: [], score: 2_000 }, { hand, melds: [], discards: [], score: 2_000 }] }),
      windowOf({ kind: 'claim', seat: 1, from: 0, tile: 'p3' }), RULESET,
    )
    expect(next.canWin).toBe(false)
    expect(next.response?.canPeng).toBe(true)
    expect(next.response?.canGang).toBe(true)
    expect(next.response?.chiOptions.length).toBeGreaterThan(0)
    const kinds = seatActionsOf(next).map((action) => action.kind)
    expect(kinds[0]).toBe('gang')
    expect(kinds).toContain('peng')
    expect(kinds).toContain('chi')
    expect(kinds.at(-1)).toBe('pass')

    // 2 号座不是下家 ⇒ 没有吃选项（与编排层的闸同口径）
    const notNext = lotusSeatView(
      table({ players: [{ hand: [], melds: [], discards: [], score: 2_000 }, { hand: [], melds: [], discards: [], score: 2_000 }, { hand, melds: [], discards: [], score: 2_000 }] }),
      windowOf({ kind: 'claim', seat: 2, from: 0, tile: 'p3' }), RULESET,
    )
    expect(notNext.response?.chiOptions).toEqual([])
    expect(seatActionsOf(notNext).map((action) => action.kind)).not.toContain('chi')
    expect(isNextSeat(4, 1, 0)).toBe(true)
    expect(isNextSeat(4, 2, 0)).toBe(false)
    expect(isNextSeat(4, 0, 3)).toBe(true)
  })

  it('抢杠窗口：只有胡或过（没有鸣牌选项）', () => {
    // 抢杠是拿**13 张**听牌去抢那张杠牌：补上 east 才是和牌（用 14 张的和牌去抢会多一张）。
    const tenpai: TileType[] = WINNING_HAND.slice(0, 13)
    const view = lotusSeatView(
      table({ players: [{ hand: tenpai, melds: [], discards: [], score: 2_000 }] }),
      windowOf({ kind: 'rob-kong', seat: 0, from: 2, tile: 'east' }), RULESET,
    )
    expect(view.canWin).toBe(true)
    expect(seatActionsOf(view).map((action) => action.kind)).toEqual(['win', 'pass'])
    expect(view.response?.canPeng).toBe(false)
    expect(view.response?.canGang).toBe(false)
    expect(view.response?.chiOptions).toEqual([])
    // 抢不到（手上没听这张）⇒ 只剩过
    const noRob = lotusSeatView(
      table({ players: [{ hand: tenpai, melds: [], discards: [], score: 2_000 }] }),
      windowOf({ kind: 'rob-kong', seat: 0, from: 2, tile: 'red' }), RULESET,
    )
    expect(seatActionsOf(noRob).map((action) => action.kind)).toEqual(['pass'])
  })

  it('决策窗口：合法动作与 ID 一一对应；没有可选动作时不是窗口', () => {
    const view = lotusSeatView(table(), windowOf(), RULESET)
    const window = decisionWindowOf(view)
    expect(window).not.toBeNull()
    expect(window!.windowId).toBe('round-1/window/1')
    expect(window!.kind).toBe('draw-turn')
    expect(window!.seat).toBe(0)
    expect(window!.legalActions.map((action) => action.id))
      .toEqual(window!.legalActions.map((_, index) => legalActionId('round-1/window/1', index)))
    // ID 不重复（下标一一对应）
    expect(new Set(window!.legalActions.map((action) => action.id)).size).toBe(window!.legalActions.length)
    // 认不出来的窗口类型 ⇒ 没有合法动作 ⇒ 不是决策窗口
    expect(decisionWindowOf({ ...view, kind: 'other' })).toBeNull()
  })

  it('控制器返回的动作能对回它自己的候选下标；对不上返回 -1（不记成任何候选）', () => {
    const view = lotusSeatView(table(), windowOf(), RULESET)
    // 和牌是 0 号
    expect(chosenIndex(view, toLotusActionLike({ kind: 'win' }))).toBe(0)
    // 弃第 5 张（下标 4）⇒ 候选里下标 5（0 是胡）
    expect(chosenIndex(view, toLotusActionLike({ kind: 'discard', handIndex: 4 }))).toBe(5)
    expect(chosenIndex(view, toLotusActionLike({ kind: 'discard', handIndex: 99 }))).toBe(-1)
    expect(chosenIndex(view, null)).toBe(-1)
  })
})

describe('翻精癞子适配层：前态投影与遮蔽（§10.4）', () => {
  it('前态只取展示回放恢复不出来的部分，字段形状固定', () => {
    const view = lotusSeatView(table(), windowOf(), RULESET)
    const state = decisionStateOf(view)
    // 多出任何字段都说明有人把新信息塞进了决策输入
    expect(Object.keys(state).sort()).toEqual(['drawnTileIndex', 'hand', 'id', 'legalActions', 'melds'])
    expect(state.hand).toEqual(WINNING_HAND)
    expect(state.drawnTileIndex).toBe(13)
    expect(state.melds).toBe(0)
    expect(state.legalActions.length).toBe(WINNING_HAND.length + 1)
  })

  it('别家暗手为空数组、只给张数；记录文本里不得出现别家的牌（§10.4）', () => {
    const snapshot = table()
    const view = lotusSeatView(snapshot, windowOf(), RULESET)
    // 别家实情在快照里是有的
    expect(snapshot.players[1].hand).toHaveLength(13)
    expect(snapshot.players[2].hand).toHaveLength(13)
    // 投影之后：本家之外全部遮蔽成空数组 + 只给张数
    expect(view.others.map((entry) => entry.seat)).toEqual([1, 2, 3])
    for (const other of view.others) {
      expect(other.hand, `别家（${other.seat}）暗手必须遮蔽`).toEqual([])
      expect(other.handCount).toBe(snapshot.players[other.seat].hand.length)
    }
    // 别家的牌一张都不能出现在决策输入里（第 1 家手里的 p1 本家并没有）
    const text = JSON.stringify(decisionStateOf(view))
    expect(text).not.toContain('m9')
    expect(text).not.toContain('p2')
    // 本家自己的手牌与摸牌索引必须在（这正是展示回放恢复不出来的部分）
    expect(decisionStateOf(view).hand).toContain('p5')
  })

  it('响应窗口不给自己座位的摸牌索引（视角里那不属于该座位）', () => {
    const view = lotusSeatView(
      table({ players: [{ hand: [], melds: [], discards: [], score: 2_000 }, { hand: ['p3', 'p3', 'm1'], melds: [], discards: [], drawnTileIndex: 2, score: 2_000 }] }),
      windowOf({ kind: 'claim', seat: 1, from: 0, tile: 'p3', skipDraw: true }), RULESET,
    )
    expect(decisionStateOf(view).drawnTileIndex).toBe(-1)
  })
})

describe('翻精癞子适配层：执行回执（§3.4、§10.2）', () => {
  const before = { handCount: 13, meldCount: 0, discardCount: 4, score: 2_000 }

  it('只认该座位自己的可见变化：请求成功 ≠ 动作执行成功', () => {
    // 弃牌 ⇒ 牌河变长
    expect(choiceTookEffect(before, { ...before, handCount: 12, discardCount: 5 }, { kind: 'discard' })).toBe(true)
    // 牌河没变 ⇒ 没生效
    expect(choiceTookEffect(before, before, { kind: 'discard' })).toBe(false)
    // 碰 ⇒ 副露变多
    expect(choiceTookEffect(before, { ...before, handCount: 11, meldCount: 1 }, { kind: 'peng' })).toBe(true)
    // 暗杠不留副露 ⇒ 用张数变化兜底
    expect(choiceTookEffect(before, { ...before, handCount: 9 }, { kind: 'concealed-kong' })).toBe(true)
    // 胡 ⇒ 分数变化
    expect(choiceTookEffect(before, { ...before, score: 2_400 }, { kind: 'win' })).toBe(true)
    // 过牌 ⇒ 什么都没变才算生效
    expect(choiceTookEffect(before, before, { kind: 'pass' })).toBe(true)
    expect(choiceTookEffect(before, { ...before, discardCount: 5 }, { kind: 'pass' })).toBe(false)
  })

  it('可见变化指纹只看该座位自己的手牌/副露/牌河/分数', () => {
    const snapshot: LotusTableSnapshot = {
      ...table(),
      players: [
        { hand: ['m1', 'm2'], melds: [], discards: ['p9'], drawnTileIndex: 1, score: 2_050 },
        { hand: [], melds: [], discards: [], score: 1_950 },
      ],
    }
    expect(observableOf(snapshot, 0)).toEqual({ handCount: 2, meldCount: 0, discardCount: 1, score: 2_050 })
    expect(observableOf(snapshot, 1)).toEqual({ handCount: 0, meldCount: 0, discardCount: 0, score: 1_950 })
  })
})

describe('翻精癞子适配层：结算折算（§5）', () => {
  it('四家分数变化之和为 0，开局/局末分与当局读数对得上', () => {
    const records = settlementsFromRound({
      roundIndex: 1,
      roundId: 'round-1',
      openingScores: [2_000, 2_000, 2_000, 2_000],
      endingScores: [2_600, 1_800, 1_800, 1_800],
      result: { winnerIndex: 0, winType: 'self-draw' },
    })
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record).toMatchObject({
      id: 'settlement/round-1/1', roundIndex: 1, roundId: 'round-1',
      kind: 'win-self-draw', winners: [0], batchId: 'round-1/end',
    })
    expect(record.deltas).toEqual([600, -200, -200, -200])
    expect(record.deltas.reduce((sum, delta) => sum + delta, 0)).toBe(0)
    expect(record.payers).toEqual([1, 2, 3])
    expect(record.scoresAfter).toEqual([2_600, 1_800, 1_800, 1_800])
    expect(record.fingerprint).toBeTruthy()
  })

  it('荒庄：没有赢家，四家变化仍守恒（含分数不变的情形）', () => {
    const records = settlementsFromRound({
      roundIndex: 2,
      roundId: 'round-2',
      openingScores: [2_600, 1_800, 1_800, 1_800],
      endingScores: [2_600, 1_800, 1_800, 1_800],
      result: { draw: true },
    })
    expect(records[0].kind).toBe('draw')
    expect(records[0].winners).toEqual([])
    expect(records[0].payers).toEqual([])
    expect(records[0].deltas.reduce((sum, delta) => sum + delta, 0)).toBe(0)
  })

  it('点炮：付款座位由负数侧决定，只记一家', () => {
    const records = settlementsFromRound({
      roundIndex: 3,
      roundId: 'round-3',
      openingScores: [2_600, 1_800, 1_800, 1_800],
      endingScores: [2_800, 1_800, 1_800, 1_600],
      result: { winnerIndex: 0, winType: 'discard' },
    })
    expect(records[0].kind).toBe('win-discard')
    expect(records[0].winners).toEqual([0])
    expect(records[0].payers).toEqual([3])
    expect(records[0].deltas).toEqual([200, 0, 0, -200])
  })

  it('分数向量对不上（长度不同/为空）时不折算，也不瞎补 0', () => {
    expect(settlementsFromRound({
      roundIndex: 1, roundId: 'round-1', openingScores: [2_000, 2_000], endingScores: [2_000, 2_000, 2_000, 2_000], result: null,
    })).toEqual([])
    expect(settlementsFromRound({
      roundIndex: 1, roundId: 'round-1', openingScores: [], endingScores: [], result: null,
    })).toEqual([])
  })

  it('指纹随分数变化：同一局的两次折算不同，同一读数两次相同', () => {
    const input = {
      roundIndex: 1, roundId: 'round-1',
      openingScores: [2_000, 2_000, 2_000, 2_000], endingScores: [2_600, 1_800, 1_800, 1_800],
      result: { winnerIndex: 0, winType: 'self-draw' },
    }
    const first = settlementsFromRound(input)
    expect(settlementsFromRound(input)[0].fingerprint).toBe(first[0].fingerprint)
    expect(settlementsFromRound({ ...input, endingScores: [2_400, 1_900, 1_900, 1_800] })[0].fingerprint)
      .not.toBe(first[0].fingerprint)
  })
})