// 莲花广麻适配层的单测（约定 §9 的 P0 判据）：
// 前态投影的**字段形状 + 遮蔽**、窗口 ID 的稳定性与跨局唯一性、合法动作与 ID 的一一对应、
// 结算四家变化之和为 0、以及"被拒动作不产生记录"这条口径的前提（choiceTookEffect 不猜）。
import { describe, expect, it } from 'vitest'
import {
  choiceTookEffect,
  decisionStateId,
  decisionStateOf,
  decisionWindowId,
  legalActionId,
  legalActionsOf,
  normalizeAction,
  roundKindOfResult,
  settlementsFromScoreChange,
  windowKindOf,
  type LotusClassicActionLike,
  type LotusClassicSeatView,
  type LotusClassicViewLike,
} from './lotusClassicAdapter'

/**
 * 三个牌面集合**刻意互不重叠**（决策者只用数牌万/条、牌墙只用筒、别家只用字牌）：
 * 任何一个别家的牌或牌墙的牌出现在前态里都能被断言抓到。
 */
const HANDS = [
  ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 's1', 's2', 's3', 's4'],
  ['east', 'east', 'south', 'south', 'west', 'west', 'north', 'north', 'red', 'red', 'green', 'green', 'white'],
  ['white', 'white', 'red', 'red', 'green', 'green', 'east', 'east', 'south', 'south', 'west', 'west', 'north'],
  ['north', 'north', 'north', 'east', 'east', 'east', 'south', 'south', 'west', 'west', 'red', 'green', 'white'],
]
/** 别家暗手用的牌面（全是字牌，与决策者的数牌不重叠）。 */
const OTHER_SEAT_TILES = ['east', 'south', 'west', 'north', 'red', 'green', 'white']
const WALL = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']

function seatView(seat: number, overrides: Partial<LotusClassicSeatView> = {}): LotusClassicSeatView {
  return {
    seat,
    handCount: HANDS[seat]!.length,
    hand: [...HANDS[seat]!],
    drawnTileIndex: seat === 0 ? HANDS[0]!.length - 1 : -1,
    discards: [],
    melds: [],
    score: 25_000,
    ...overrides,
  }
}

function view(overrides: Partial<LotusClassicViewLike> = {}): LotusClassicViewLike {
  return {
    windowId: decisionWindowId('r1', 3),
    roundId: 'r1',
    roundIndex: 1,
    seat: 0,
    windowKind: 'turn',
    actions: [
      { kind: 'discard', tile: 'm1', handIndex: 0 },
      { kind: 'discard', tile: 'm2', handIndex: 2 },
      { kind: 'pass' },
    ],
    players: [seatView(0), seatView(1), seatView(2), seatView(3)],
    wallCount: 62,
    dealer: 0,
    currentPlayer: 0,
    wall: WALL,
    ...overrides,
  }
}

describe('窗口 ID：本局内稳定、跨局不重复（§3.1）', () => {
  it('同一 (局, 序号) 重复计算得到同一 ID', () => {
    expect(decisionWindowId('r2', 7)).toBe(decisionWindowId('r2', 7))
    expect(decisionWindowId('r2', 7)).toBe('r2/window/7')
  })

  it('同序号跨局不重复（序列每局清零，靠 roundId 区分）', () => {
    expect(decisionWindowId('r1', 1)).not.toBe(decisionWindowId('r2', 1))
  })

  it('窗口内动作 ID 与 legalActions 一一对应，且不含未编号条目', () => {
    const current = view()
    const actions = legalActionsOf(current.windowId, current.actions)
    expect(actions).toHaveLength(current.actions.length)
    actions.forEach((action, index) => {
      expect(action.id).toBe(legalActionId(current.windowId, index))
      expect(action.kind).toBe(current.actions[index]!.kind)
    })
    // 缺 ID / 重复 ID 的条目数必须为 0（两侧同编号对照的前提）
    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length)
    expect(actions.every((action) => action.id.startsWith(`${current.windowId}/`))).toBe(true)
  })

  it('规范化保留摸切语义（手牌下标）与补杠关联的副露下标', () => {
    const normalized = normalizeAction('w', 2, { kind: 'discard', tile: 'm1', handIndex: 5 })
    expect(normalized).toEqual({ id: 'w/2', kind: 'discard', tile: 'm1', handIndex: 5 })
    expect(normalizeAction('w', 0, { kind: 'added-kong', meldIndex: 1, tile: 'p3' }))
      .toEqual({ id: 'w/0', kind: 'added-kong', tile: 'p3', meldIndex: 1 })
  })

  it('窗口类型直接对应三类窗口，不猜', () => {
    expect(windowKindOf('turn')).toBe('draw-turn')
    expect(windowKindOf('claim')).toBe('claim')
    expect(windowKindOf('rob-kong')).toBe('rob-kong')
  })
})

describe('决策前态：字段形状 + 遮蔽（§10.4）', () => {
  it('只含自己那一份手牌，别家暗手一个牌面都不出现', () => {
    const current = view()
    const state = decisionStateOf(current, 0)
    expect(state.hand).toEqual(HANDS[0])
    expect(state.drawnTileIndex).toBe(HANDS[0]!.length - 1)
    expect(state.melds).toBe(0)

    // 别家的牌面（与决策者手牌不重叠）不得出现在前态的任何字段里
    const dumped = JSON.stringify(state)
    for (const tile of OTHER_SEAT_TILES) expect(dumped).not.toContain(`"${tile}"`)
  })

  it('未摸牌墙顺序绝不写入前态（视图里故意带了真牌墙）', () => {
    const current = view()
    expect(current.wall).toEqual(WALL)
    const dumped = JSON.stringify(decisionStateOf(current, 0))
    for (const tile of WALL) expect(dumped).not.toContain(`"${tile}"`)
  })

  it('字段形状固定：多一个字段就失败（防止顺手把整个局面塞进前态）', () => {
    const state = decisionStateOf(view(), 0)
    expect(Object.keys(state).sort()).toEqual(
      ['drawnTileIndex', 'fingerprint', 'hand', 'id', 'legalActions', 'melds'].sort(),
    )
  })

  it('非决策者座位只拿到合法动作，不含任何手牌字段', () => {
    const state = decisionStateOf(view(), 1)
    expect(state.hand).toBeUndefined()
    expect(state.drawnTileIndex).toBeUndefined()
    expect(state.melds).toBeUndefined()
    expect(state.legalActions).toHaveLength(3)
  })

  it('前态 ID 按 (窗口, 座位) 去重：同窗口同座位重复计算得到同一 ID', () => {
    const current = view()
    expect(decisionStateId(current, 2)).toBe(decisionStateId(current, 2))
    expect(decisionStateId(current, 2)).not.toBe(decisionStateId(current, 3))
  })

  it('指纹随状态变化：牌墙数变了就不是同一份前态', () => {
    expect(decisionStateOf(view(), 0).fingerprint).not.toBe(decisionStateOf(view({ wallCount: 61 }), 0).fingerprint)
  })
})

describe('执行回执：只认可见变化，不因为有函数被调用过就算生效（§3.2）', () => {
  const discard: LotusClassicActionLike = { kind: 'discard', tile: 'm1', handIndex: 0 }

  it('弃牌 ⇒ 牌河变长才算生效', () => {
    const before = view()
    const executed = view({ players: [seatView(0, { discards: ['m1'] }), seatView(1), seatView(2), seatView(3)] })
    expect(choiceTookEffect(before, executed, 0, discard)).toBe(true)
    // 状态没动 ⇒ 没有生效（被拒/被更高优先级压过）
    expect(choiceTookEffect(before, view(), 0, discard)).toBe(false)
    // 别人的牌河变长不算我的动作生效
    const byOther = view({ players: [seatView(0), seatView(1, { discards: ['p4'] }), seatView(2), seatView(3)] })
    expect(choiceTookEffect(before, byOther, 0, discard)).toBe(false)
  })

  it('碰/杠 ⇒ 副露变多才算生效', () => {
    const before = view({ windowKind: 'claim' })
    const executed = view({ windowKind: 'claim', players: [seatView(0, { melds: [{ type: 'peng', tiles: ['m1', 'm1', 'm1'] }] }), seatView(1), seatView(2), seatView(3)] })
    expect(choiceTookEffect(before, executed, 0, { kind: 'peng' })).toBe(true)
    expect(choiceTookEffect(before, view({ windowKind: 'claim' }), 0, { kind: 'peng' })).toBe(false)
  })

  it('胡 ⇒ 本局结束且赢家是该座位', () => {
    const before = view({ windowKind: 'claim' })
    expect(choiceTookEffect(before, view({ roundEnded: true, winningSeat: 0 }), 0, { kind: 'win' })).toBe(true)
    expect(choiceTookEffect(before, view({ roundEnded: true, winningSeat: 2 }), 0, { kind: 'win' })).toBe(false)
    expect(choiceTookEffect(before, view(), 0, { kind: 'win' })).toBe(false)
  })

  it('过牌 ⇒ 什么都没变才算生效', () => {
    const before = view({ windowKind: 'claim' })
    expect(choiceTookEffect(before, view({ windowKind: 'claim' }), 0, { kind: 'pass' })).toBe(true)
    const after = view({ windowKind: 'claim', players: [seatView(0, { melds: [{ type: 'peng' }] }), seatView(1), seatView(2), seatView(3)] })
    expect(choiceTookEffect(before, after, 0, { kind: 'pass' })).toBe(false)
  })

  it('认不出的动作 ⇒ false（保持 pending，绝不猜成生效）', () => {
    expect(choiceTookEffect(view(), view(), 0, { kind: 'unknown-kind' })).toBe(false)
  })
})

describe('结算折算：四家变化之和为 0、分数链对得上（§5）', () => {
  it('自摸：赢家为正、其余为负，和为 0，scoresAfter 与当局结束分一致', () => {
    const opening = [25_000, 25_000, 25_000, 25_000]
    const ending = [31_000, 23_000, 23_000, 23_000]
    const settlement = settlementsFromScoreChange({
      roundIndex: 1, roundId: 'r1', before: opening, after: ending,
      kind: roundKindOfResult({ winType: 'self-draw' }), sourceEventId: 'round-1-end',
    })
    expect(settlement.deltas).toEqual([6_000, -2_000, -2_000, -2_000])
    expect(settlement.deltas.reduce((sum, delta) => sum + delta, 0)).toBe(0)
    expect(settlement.winners).toEqual([0])
    expect(settlement.payers).toEqual([1, 2, 3])
    expect(settlement.scoresAfter).toEqual(ending)
    expect(settlement.kind).toBe('self-draw')
  })

  it('局中分数流动（杠/跟庄）：同样守恒，kind 如实标成 score-flow', () => {
    const settlement = settlementsFromScoreChange({
      roundIndex: 2, roundId: 'r2', before: [20_000, 25_000, 30_000, 25_000], after: [21_000, 25_000, 30_000, 24_000],
      kind: 'score-flow', sourceEventId: 'flow-7',
    })
    expect(settlement.deltas.reduce((sum, delta) => sum + delta, 0)).toBe(0)
    expect(settlement.winners).toEqual([0])
    expect(settlement.payers).toEqual([3])
  })

  it('多笔流水串起来与当局结束分对得上（开分 → 每笔 → 结束分）', () => {
    const opening = [25_000, 25_000, 25_000, 25_000]
    const flows = [
      { after: [26_000, 24_000, 25_000, 25_000], kind: 'score-flow' },
      { after: [26_000, 24_000, 25_000, 25_000 + 0], kind: 'score-flow' },
      { after: [20_000, 30_000, 25_000, 25_000], kind: 'self-draw' },
    ]
    let previous: number[] = opening
    let last: number[] = opening
    for (const [index, flow] of flows.entries()) {
      const settlement = settlementsFromScoreChange({
        roundIndex: 1, roundId: 'r1', before: previous, after: flow.after, kind: flow.kind, sourceEventId: `e${index}`,
      })
      expect(settlement.deltas.reduce((sum, delta) => sum + delta, 0)).toBe(0)
      previous = settlement.scoresAfter
      last = settlement.scoresAfter
    }
    expect(last).toEqual(flows[flows.length - 1]!.after)
    expect(last.reduce((sum, score) => sum + score, 0)).toBe(opening.reduce((sum, score) => sum + score, 0))
  })

  it('结算类型口径：自摸 / 点炮 / 抢杠 / 荒庄 / 非结算', () => {
    expect(roundKindOfResult({ winType: 'self-draw' })).toBe('self-draw')
    expect(roundKindOfResult({ winType: 'discard' })).toBe('win-discard')
    expect(roundKindOfResult({ robbedKong: true })).toBe('robbed-kong-win')
    expect(roundKindOfResult({ draw: true })).toBe('draw')
    expect(roundKindOfResult(null)).toBe('score-flow')
  })
})