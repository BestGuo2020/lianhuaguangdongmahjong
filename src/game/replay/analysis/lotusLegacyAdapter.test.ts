import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  actionMatchKey,
  canonicalTileKey,
  chosenIndex,
  choiceTookEffect,
  createLotusLegacyDecisionSink,
  decisionStateId,
  decisionStateOf,
  decisionWindowOf,
  isNextSeat,
  legalActionId,
  legalActionsOf,
  lotusSeatView,
  normalizeAction,
  observableOf,
  rebaseHookCandidates,
  roundIdOf,
  seatActionsOf,
  settlementsFromRound,
  splitTemplateVariables,
  toLotusActionLike,
  usageOf,
  windowIdOf,
  windowKindOfMethod,
  type LotusSeatView,
  type LotusTableSnapshot,
  type LotusWindowDescriptor,
} from './lotusLegacyAdapter'
import { createAnalysisRecorder } from './recorder'
import { createAnalysisMemoryStorage } from './storage'
import { LOTUS_RULESET } from '../../variants/lotus/lotusRules'
import { tileName } from '../../core/rules/tiles'
import {
  createLlmStats, LotusLlmController, type LlmDecisionRequestHookInput,
} from '../../llm/llmController'
import { ConditionalReasoningCoordinator } from '../../llm/conditionalReasoning'
import { resetReasoningBudgetForTests } from '../../llm/reasoningBudget'
import type { LlmProviderConfig } from '../../llm/config'
import type { LotusTurnContext } from '../../variants/lotus/lotusControllers'
import type { AnalysisBlockPart } from './codec'
import type { AnalysisLegalAction } from './types'
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
    expect(Object.keys(state).sort()).toEqual(['drawnTileIndex', 'fingerprint', 'hand', 'id', 'legalActions', 'melds'])
    expect(state.fingerprint).toMatch(/^fnv1a-/)
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
    // The next turn can draw before the receipt observer runs; this does not override the pass.
    expect(choiceTookEffect(before, { ...before, handCount: before.handCount + 1 }, { kind: 'pass' })).toBe(true)
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

// ─────────────────────────── LLM 接缝（§4／§5、约定 §9） ───────────────────────────
//
// 分工：A 的 `llmControllerHooks.test.ts` 证明的是**钩子 ↔ 真正发给模型的请求体**逐字相等；
// 这里证明的是**钩子 ↔ 落库记录**（接缝这一层没有把变量加工走样），两段合起来才是
// "记录里的变量与 `messages.user` 逐字相等"这条判据的完整链路。

const MATCH = 'match-lotus-legacy-sink'
const WINDOW_ID = 'round-1/window/1'

/** 真实录制器 + 内存分析区：断言的是**落库的记录**，不是端口调用。 */
function harness() {
  const errors: string[] = []
  const storage = createAnalysisMemoryStorage()
  const recorder = createAnalysisRecorder({ enabled: true, matchId: MATCH, rulesetId: 'lotus-legacy', storage })
  recorder.beginMatch({
    engineBuild: 'test', rulesVersion: 'lotus-legacy', rulesFingerprint: 'f', rules: {},
    aiStrategy: 'source-v2', aiFingerprint: 'f', aiConfig: {}, seatControl: ['human', 'llm', 'llm', 'llm'],
  })
  const sink = createLotusLegacyDecisionSink({ recorder, onError: (detail) => errors.push(detail) })
  /** 刷盘后读回落库记录（candidates 只在 decision 落库时随之下盘，所以断言前要先推一条 decision）。 */
  const parts = async (): Promise<AnalysisBlockPart[]> => {
    await recorder.flush('test')
    return (await storage.read(MATCH)).parts
  }
  return { recorder, sink, errors, parts }
}

/** 该座位此刻的合法动作（与真实窗口同源）。 */
function windowActions(hand: TileType[]): AnalysisLegalAction[] {
  const snapshot: LotusTableSnapshot = {
    players: [
      { hand, melds: [], discards: [], drawnTileIndex: hand.length - 1, score: 2_000 },
      { hand: [], melds: [], discards: [], score: 2_000 },
    ],
    jokers: [],
    wildcardTiles: ['white'],
  }
  const view = lotusSeatView(snapshot, { windowId: WINDOW_ID, roundId: 'round-1', kind: 'draw-turn', seat: 0 }, RULESET)
  return legalActionsOf(view)
}

/**
 * 把本适配层的动作折成**钩子上报的写法**：`tile`/`meld` 走 `tileName()`（中文显示名），
 * 与 `llmController` 的 `analysisLegalActionOf` 同口径；ID 用钩子自己的编号空间。
 */
function asHookAction(action: AnalysisLegalAction, requestId: string, index: number) {
  return {
    id: `${requestId}/${index}`,
    kind: action.kind,
    // `AnalysisLegalAction.tile` 声明成 string，但本适配层写进去的其实是 TileType 牌码
    ...(action.tile ? { tile: tileName(action.tile as TileType) } : {}),
    ...(action.handIndex !== undefined ? { handIndex: action.handIndex } : {}),
    ...(action.meldIndex !== undefined ? { meldIndex: action.meldIndex } : {}),
    ...(action.meld ? { meld: action.meld.map((tile) => tileName(tile as TileType)) } : {}),
  }
}

function requestInput(overrides: Partial<LlmDecisionRequestHookInput> = {}): LlmDecisionRequestHookInput {
  return {
    seat: 0, requestId: 'turn-0-1', windowId: 'turn-0-1',
    legalActions: [], candidates: [], promptTemplateId: 'decision-prompt/1/lotus-legacy/稳健',
    promptVariables: { system: 'SYS-正文', user: 'USER-第一份', ruleCode: 'lotus-legacy', decision: 'turn' },
    provider: 'deepseek', model: 'deepseek-chat', sentAt: 1_000,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetReasoningBudgetForTests()
})

describe('翻精癞子接缝：候选改挂到本窗口的合法动作（§3.3）', () => {
  it('钩子的候选/推荐改挂到本窗口的 ID 空间；记录里的候选动作与合法动作逐字一致', async () => {
    const { recorder, sink, parts } = harness()
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'p1', 'p2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']
    const mine = windowActions(hand)
    expect(mine).toHaveLength(hand.length)
    sink.windowOpened({ seat: 0, windowId: WINDOW_ID, legalActions: mine })

    // 钩子只上报其中两个候选（LLM 侧的候选集是引擎合法集合的子集）
    const picked = [mine[2]!, mine[5]!]
    const candidates = picked.map((action, index) => ({
      id: `turn-0-1/${index}`, label: `A${index + 1}`, action: asHookAction(action, 'turn-0-1', index),
    }))
    sink.hooks.onDecisionRequest(requestInput({
      legalActions: picked.map((action, index) => asHookAction(action, 'turn-0-1', index)),
      candidates,
      recommended: { candidateId: candidates[1]!.id, note: 'engine-suggestion' },
    }))
    // candidates 只在 decision 落库时随之下盘：推一条选择（真实流程里由包装层做）
    recorder.chosen({ windowId: WINDOW_ID, seat: 0, legalActionId: legalActionId(WINDOW_ID, 5), source: 'unknown' })

    const decision = (await parts()).find((part) => part.tag === 'decision')!.value as {
      candidates: Array<{ legalActionId: string; action: unknown }>
      recommended?: { known: boolean; value: { legalActionId: string; note?: string } }
      source: string
    }
    // 改挂成功：ID 是**本窗口**的编号（不是钩子那套 "${引擎侧 requestId}/下标"）
    expect(decision.candidates.map((candidate) => candidate.legalActionId))
      .toEqual([legalActionId(WINDOW_ID, 2), legalActionId(WINDOW_ID, 5)])
    expect(decision.candidates[0]!.action).toEqual(mine[2])
    expect(decision.recommended?.value.legalActionId).toBe(legalActionId(WINDOW_ID, 5))
    expect(decision.recommended?.value.note).toBe('engine-suggestion')
    // 来源：模型（不是 unknown）—— chosen 带回的 'unknown' 不得覆盖运行时确定的来源
    expect(decision.source).toBe('model')
  })

  it('对不上的候选只计数、不猜 ID；找不到在飞窗口就不落孤儿记录（§9.5）', async () => {
    const { sink, recorder, errors, parts } = harness()
    const mine = windowActions(['m1', 'm2', 'm3', 'm4', 'm5'])
    sink.windowOpened({ seat: 0, windowId: WINDOW_ID, legalActions: mine })
    // 一个能对上、一个对不上（手里没有的牌）
    sink.hooks.onDecisionRequest(requestInput({
      legalActions: [],
      candidates: [
        { id: 'turn-0-1/0', action: asHookAction(mine[1]!, 'turn-0-1', 0) },
        { id: 'turn-0-1/1', action: { kind: 'discard', handIndex: 99 } },
      ],
    }))
    recorder.chosen({ windowId: WINDOW_ID, seat: 0, legalActionId: legalActionId(WINDOW_ID, 1), source: 'unknown' })
    const decision = (await parts()).find((part) => part.tag === 'decision')!.value as { candidates: unknown[] }
    expect(decision.candidates).toHaveLength(1)
    expect(errors.some((detail) => detail.includes('无法对应到本窗口的合法动作'))).toBe(true)

    // 窗口已关（或压根没登记）：不写任何尝试。
    // 换一个干净的接缝来断言这条 —— 接缝的报错按设计**只通知一次**（避免刷屏），
    // 上面那条"候选对不上"已经用掉了那次通知。
    const before = (await parts()).filter((part) => part.tag === 'llm').length
    const fresh = harness()
    fresh.sink.hooks.onDecisionRequest(requestInput({ requestId: 'turn-0-9' }))
    expect((await fresh.parts()).filter((part) => part.tag === 'llm')).toHaveLength(0)
    expect(fresh.errors.some((detail) => detail.includes('找不到对应的分析窗口'))).toBe(true)
    expect((await parts()).filter((part) => part.tag === 'llm').length).toBe(before)
  })

  it('吃的组合只在钩子的合法动作表上：必须按 id 取那一份，不能看 candidate.action（回归）', () => {
    // 真实形状：钩子的 `candidates[].action` 是**引擎侧**动作——吃只有 `{kind:'chi', optionIndex}`，
    // 组合在并行的 `legalActions[]` 上。早先只读 `candidate.action`，于是每一个吃候选都被判成
    // "认不出来"，落库时静默少一个候选（真机 e2e 抓到的）。
    const chiOption = { kind: 'sequence' as const, tiles: ['p1', 'p2', 'p3'] as TileType[] }
    const snapshot: LotusTableSnapshot = {
      players: [
        // 0 号座刚弃了 p3；1 号座是它的下家，手上有 p1p2p3p4 ⇒ 可吃
        { hand: [], melds: [], discards: ['p3'], score: 2_000 },
        { hand: ['p1', 'p2', 'p3', 'p4', 'm1'], melds: [], discards: [], score: 2_000 },
      ],
      jokers: [],
      wildcardTiles: ['white'],
    }
    const view = lotusSeatView(
      snapshot,
      { windowId: WINDOW_ID, roundId: 'round-1', kind: 'claim', seat: 1, from: 0, tile: 'p3' }, RULESET,
    )
    const mine = legalActionsOf(view)
    const chiIndex = mine.findIndex((action) => action.kind === 'chi' && action.meld?.join(',') === chiOption.tiles.join(','))
    expect(chiIndex, '该窗口应当有吃这个选项').toBeGreaterThanOrEqual(0)

    const hookChi = { id: 'claim-1-9/2', kind: 'chi', tile: '三筒', from: 0, meld: ['一筒', '二筒', '三筒'] }
    const rebased = rebaseHookCandidates(WINDOW_ID, mine, {
      reportedLegalActions: [hookChi as AnalysisLegalAction],
      // 引擎侧动作：没有组合，只有 optionIndex
      candidates: [{ id: 'claim-1-9/2', label: '吃一筒+二筒+三筒', summary: 'C1', action: { kind: 'chi', optionIndex: 0 } }],
    })
    expect(rebased.unmapped, '吃候选必须能对上（组合来自合法动作表）').toBe(0)
    expect(rebased.candidates.map((candidate) => candidate.legalActionId)).toEqual([legalActionId(WINDOW_ID, chiIndex)])
  })

  it('纯函数口径：牌码与**两套中文牌名**都折回同一个键；变量拆分不吞非对象输入', () => {
    // 三套写法必须同键：牌码（m5）、核心表的中文数字（五万）、LLM 表用的阿拉伯数字（5万）
    expect(actionMatchKey({ kind: 'concealed-kong', tile: 'm5' })).toBe('concealed-kong|m5')
    expect(actionMatchKey({ kind: 'concealed-kong', tile: '五万' })).toBe('concealed-kong|m5')
    expect(actionMatchKey({ kind: 'concealed-kong', tile: '5万' })).toBe('concealed-kong|m5')
    // 吃：钩子的 `6筒,7筒,8筒` 与本适配层的 `p6,p7,p8` 必须是同一个键（回归：实测对不上过）
    expect(actionMatchKey({ kind: 'chi', meld: ['p6', 'p7', 'p8'] }))
      .toBe(actionMatchKey({ kind: 'chi', meld: ['6筒', '7筒', '8筒'] }))
    expect(actionMatchKey({ kind: 'chi', meld: ['p6', 'p7', 'p8'] }))
      .toBe(actionMatchKey({ kind: 'chi', meld: ['六筒', '七筒', '八筒'] }))
    // 风牌两套写法也一样
    expect(actionMatchKey({ kind: 'concealed-kong', tile: 'east' }))
      .toBe(actionMatchKey({ kind: 'concealed-kong', tile: '东风' }))
    // 认不出的字符串原样保留（不猜）
    expect(canonicalTileKey('?')).toBe('?')
    expect(splitTemplateVariables({ system: 'S', user: 'U' })).toEqual({ system: 'S', rest: { user: 'U' } })
    expect(splitTemplateVariables('不是对象')).toEqual({ system: null, rest: {} })
    expect(splitTemplateVariables(undefined)).toEqual({ system: null, rest: {} })
    expect(usageOf({ prompt: 12, completion: 3, weird: 'x' })).toEqual({ prompt: 12, completion: 3 })
    expect(usageOf(null)).toBeNull()
    expect(usageOf({})).toBeNull()
  })
})

describe('翻精癞子接缝：变量逐字相等与模板只存一次（§4）', () => {
  it('落库的 user 与钩子上报的逐字相等；模板正文按 id 只存一条', async () => {
    const { sink, recorder, parts } = harness()
    const mine = windowActions(['m1', 'm2', 'm3', 'm4', 'm5'])
    sink.windowOpened({ seat: 0, windowId: WINDOW_ID, legalActions: mine })
    const system = '你是莲花麻将的牌手…\n（模板正文，含换行与空白）'
    const user = '手牌：一万 二万 三万\n候选：\nA1 打一万\nA2 打二万'
    sink.hooks.onDecisionRequest(requestInput({
      requestId: 'turn-0-1',
      promptVariables: { system, user, ruleCode: 'lotus-legacy' },
    }))
    sink.hooks.onDecisionAnswer({
      requestId: 'turn-0-1', raw: '打一万。', choice: 'A1', outcome: 'success', completedAt: 1_100,
    })
    recorder.chosen({ windowId: WINDOW_ID, seat: 0, legalActionId: legalActionId(WINDOW_ID, 0), source: 'unknown' })

    // 第二次请求：同一个模板 id、不同的变量
    const user2 = '手牌：四万 五万\n候选：\nA1 打四万'
    sink.hooks.onDecisionRequest(requestInput({
      requestId: 'turn-0-2',
      promptVariables: { system, user: user2, ruleCode: 'lotus-legacy' },
    }))
    sink.hooks.onDecisionAnswer({
      requestId: 'turn-0-2', raw: '打四万。', choice: 'A1', outcome: 'success', completedAt: 1_200,
    })

    const all = await parts()
    // 模板只存一次，正文逐字保留
    const templates = all.filter((part) => part.tag === 'promptTemplate')
    expect(templates).toHaveLength(1)
    expect((templates[0]!.value as { id: string; content: unknown }).id).toBe('decision-prompt/1/lotus-legacy/稳健')
    expect((templates[0]!.value as { content: unknown }).content).toBe(system)

    // 每次尝试只存变量；user 逐字相等，模板正文不重复出现（§4 不存"全文提示词重复副本"）
    const attempts = all.filter((part) => part.tag === 'llm').map((part) => part.value as {
      promptVariables: Record<string, unknown>
    })
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.promptVariables.user).toBe(user)
    expect(attempts[1]!.promptVariables.user).toBe(user2)
    for (const attempt of attempts) {
      expect(attempt.promptVariables.system).toBeUndefined()
      expect(JSON.stringify(attempt.promptVariables)).not.toContain('模板正文')
    }
  })

  it('原话、结果与用量如实落库：拿不到的字段不填 0 冒充（§3.3）', async () => {
    const { sink, recorder, parts } = harness()
    sink.windowOpened({ seat: 0, windowId: WINDOW_ID, legalActions: windowActions(['m1', 'm2', 'm3', 'm4', 'm5']) })
    sink.hooks.onDecisionRequest(requestInput({ requestId: 'turn-0-3' }))
    sink.hooks.onDecisionAnswer({
      requestId: 'turn-0-3', raw: '打三万。', choice: 'A2', outcome: 'success',
      usage: { prompt_tokens: 820, completion_tokens: 12 }, responseModel: 'deepseek-chat-0912', completedAt: 1_300,
    })
    recorder.chosen({ windowId: WINDOW_ID, seat: 0, legalActionId: legalActionId(WINDOW_ID, 0), source: 'unknown' })

    const attempt = (await parts()).find((part) => part.tag === 'llm')!.value as {
      outcome: string
      answer: { known: boolean; value: { text: string; candidateId?: string } }
      usage?: Record<string, number>
      responseModel: { known: boolean; value?: string }
      timing: { durationMs?: number }
    }
    expect(attempt.outcome).toBe('success')
    expect(attempt.answer.value).toEqual({ text: '打三万。', candidateId: 'A2' })
    expect(attempt.usage).toEqual({ prompt_tokens: 820, completion_tokens: 12 })
    expect(attempt.responseModel).toEqual({ known: true, value: 'deepseek-chat-0912' })
    expect(attempt.timing.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('翻精癞子接缝：失败与回退的来源（§4、§10.1）', () => {
  it('请求失败 + 回退 ⇒ 决策来源是 model-fallback，不是 model', async () => {
    const { sink, recorder, parts } = harness()
    sink.windowOpened({ seat: 0, windowId: WINDOW_ID, legalActions: windowActions(['m1', 'm2', 'm3', 'm4', 'm5']) })
    sink.hooks.onDecisionRequest(requestInput({ requestId: 'turn-0-4' }))
    sink.hooks.onDecisionAnswer({
      requestId: 'turn-0-4', raw: '', choice: null, outcome: 'timeout',
      fallback: { reason: 'timeout' }, completedAt: 1_400,
    })
    recorder.chosen({ windowId: WINDOW_ID, seat: 0, legalActionId: legalActionId(WINDOW_ID, 0), source: 'unknown' })

    const all = await parts()
    const attempt = all.find((part) => part.tag === 'llm')!.value as {
      outcome: string; fallback?: { reason: string; strategy: string }
    }
    expect(attempt.outcome).toBe('timeout')
    expect((attempt as typeof attempt & { answer?: { known: boolean } }).answer).toEqual({ known: false })
    expect(attempt.fallback).toEqual({ reason: 'timeout', strategy: 'lotus-local-ai' })
    const decision = all.find((part) => part.tag === 'decision')!.value as {
      source: string; llmAttemptIds?: string[]
    }
    // 本地兜底的动作绝不能被归因成模型的选择
    expect(decision.source).toBe('model-fallback')
    // 决策与尝试要互相关联得上
    expect(decision.llmAttemptIds).toHaveLength(1)
  })

  it('回答但候选不可用 ⇒ candidate-missing；接缝自身抛错不冒泡（§9.5）', async () => {
    const { sink, recorder, errors, parts } = harness()
    sink.windowOpened({ seat: 0, windowId: WINDOW_ID, legalActions: windowActions(['m1', 'm2', 'm3', 'm4', 'm5']) })
    sink.hooks.onDecisionRequest(requestInput({ requestId: 'turn-0-5' }))
    sink.hooks.onDecisionAnswer({
      requestId: 'turn-0-5', raw: '随便说说。', choice: 'ZZ', outcome: 'invalid',
      fallback: { reason: '回答里的编号不在合法候选列表' }, completedAt: 1_500,
    })
    recorder.chosen({ windowId: WINDOW_ID, seat: 0, legalActionId: legalActionId(WINDOW_ID, 0), source: 'unknown' })
    const recorded = (await parts()).find((part) => part.tag === 'llm')!.value as { outcome: string }
    expect(recorded.outcome).toBe('candidate-missing')

    // 录制器炸了也不得抛回模型请求路径
    const boom = createLotusLegacyDecisionSink({
      recorder: {
        ...recorder,
        attemptStarted: () => { throw new Error('落库炸了') },
      } as unknown as Parameters<typeof createLotusLegacyDecisionSink>[0]['recorder'],
      onError: (detail) => errors.push(detail),
    })
    boom.windowOpened({ seat: 0, windowId: WINDOW_ID, legalActions: [] })
    expect(() => boom.hooks.onDecisionRequest(requestInput({ requestId: 'turn-0-6' }))).not.toThrow()
    expect(errors.some((detail) => detail.includes('落库炸了'))).toBe(true)
  })
})

describe('翻精癞子接缝 × 真实 LotusLlmController（端到端逐字相等）', () => {
  const API_KEY = 'sk-lotus-legacy-sink-secret'

  function provider(): LlmProviderConfig {
    return {
      providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: API_KEY,
      model: 'deepseek-chat', style: '稳健', timeoutMs: 8_000,
    }
  }

  /** 假 SSE：把真正发出去的请求体抓下来，供"落库变量 == 发给模型"的断言使用。 */
  function stubModelReply(reply: { choice: string; message: string } = { choice: 'A1', message: '稳住。' }) {
    const sent: Array<{ messages?: Array<{ role: string; content: string }> }> = []
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as (typeof sent)[number])
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as never)
    return sent
  }

  /** 一个会让 LLM 真正发请求的回合上下文（非和牌、无必成杠上开花、候选足够多）。 */
  function turnContext(hand: TileType[]): LotusTurnContext {
    return {
      hand, melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, isDealer: true,
      jokers: [], wildcardTiles: ['white'],
      playerIndex: 0, scores: [2_000, 2_000, 2_000, 2_000],
      peers: [0, 1, 2, 3].map(() => ({ discards: [], melds: [] })),
      seatWind: '东', roundWind: '东', dealerIndex: 0, roundIndex: 1,
      requestId: 'turn-0-1', stateVersion: '1:discard:60:0:0:56',
      visibleTiles: [], publicTiles: [], upperLastDiscard: null, earlyRound: true, wallCount: 60,
      turnOrigin: 'draw', drawnTile: null,
    }
  }

  it('真实控制器的请求走接缝：落库的 user 与发给模型的 messages.user 逐字相等', async () => {
    const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'p1', 'p2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']
    const sent = stubModelReply({ choice: 'A1', message: '这手先打一万。' })
    const { sink, recorder, errors, parts } = harness()
    // 引擎侧登记的窗口：合法动作与这一手的上下文同源
    sink.windowOpened({ seat: 0, windowId: WINDOW_ID, legalActions: windowActions(hand) })

    const controller = new LotusLlmController(provider(), sink.hooks, createLlmStats(), new ConditionalReasoningCoordinator())
    await controller.requestTurn(turnContext(hand))
    // 窗口关闭由包装层在同一拍做；这里按真实顺序收尾：请求 → 回答 → 落选择 → 关窗
    recorder.chosen({ windowId: WINDOW_ID, seat: 0, legalActionId: legalActionId(WINDOW_ID, 0), source: 'unknown' })
    sink.windowClosed(0)

    expect(errors, `接缝不该报错：${errors.join(' | ')}`).toEqual([])
    const all = await parts()
    const attempt = all.find((part) => part.tag === 'llm')!.value as {
      outcome: string
      promptVariables: { user?: string; system?: unknown }
      answer: { value: { text: string; candidateId?: string } }
    }
    // 真的发出去了请求、也真的落了一条尝试
    expect(sent).toHaveLength(1)
    expect(attempt.outcome).toBe('success')
    // 落库的 user 与发给模型的 user 逐字相等（接缝没有加工走样）
    const bodyUser = sent[0]!.messages!.find((message) => message.role === 'user')!.content
    expect(attempt.promptVariables.user).toBe(bodyUser)
    expect(attempt.promptVariables.system).toBeUndefined()
    // 模板正文按 id 单独存一次
    const templates = all.filter((part) => part.tag === 'promptTemplate')
    expect(templates).toHaveLength(1)
    expect((templates[0]!.value as { content: unknown }).content)
      .toBe(sent[0]!.messages!.find((message) => message.role === 'system')!.content)
    expect(attempt.answer.value.text).toBe('这手先打一万。')
    // 决策来源是 model（不是 unknown）
    expect((all.find((part) => part.tag === 'decision')!.value as { source: string }).source).toBe('model')
    // 变量里不得出现 API Key（§4、§8）
    expect(JSON.stringify(attempt)).not.toContain(API_KEY)
  })

  it('胡窗口与抢杠窗口不发请求 ⇒ 不会触发钩子（与"拿不到 requestId"是同一对）', async () => {
    const sent = stubModelReply()
    const { sink, errors } = harness()
    // 点炮胡拿**13 张**听牌去胡那张弃牌（14 张是已经和了的手牌，再加一张就不成和）
    const tenpai: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p5', 'p6', 'p7', 's7', 's8', 's9', 'east']
    const controller = new LotusLlmController(provider(), sink.hooks, createLlmStats(), new ConditionalReasoningCoordinator())
    // 点炮胡：确定性裁决，不问模型
    const hu = await controller.requestDiscardHu({
      hand: tenpai, exposedMelds: 0, tile: 'east', from: 1, dihu: false, jokers: [],
      canPeng: false, canGang: false, chiOptions: [], visibleTiles: [],
    })
    // 抢杠：同样确定性
    const rob = await controller.requestRobKong({ hand: tenpai, exposedMelds: 0, tile: 'east', from: 1, jokers: [] })
    expect(hu.kind).toBe('win')
    expect(rob).toBe('win')
    // 两个窗口都没发过请求，也没触发过接缝
    expect(sent).toHaveLength(0)
    expect(errors).toEqual([])
  })
})
