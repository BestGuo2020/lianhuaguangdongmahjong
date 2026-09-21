import { describe, expect, it } from 'vitest'
import {
  choiceTookEffect,
  decisionStateId,
  decisionStateOf,
  legalActionId,
  legalActionsOf,
  normalizeAction,
  seatLegalActions,
  settlementsFromView,
  windowKindOf,
  type BloodFlowLedgerViewLike,
  type BloodFlowViewLike,
} from './bloodFlowAdapter'
import { BloodFlowEngine } from '../../variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../../variants/lotus/bloodFlow/seatView'
import { SEATS } from '../../variants/lotus/bloodFlow/state'
import type { GamePlayer, Meld, TileType } from '../../core/contracts/types'
import { createWall } from '../../core/rules/tiles'

// 血流视角 → 分析模型的纯适配（§3.2／§3.3／§3.4）：
// 稳定 ID、窗口类型判定、前态提取、以及"这一手到底有没有生效"的口径。

function view(overrides: Partial<BloodFlowViewLike> = {}): BloodFlowViewLike {
  return {
    seat: 0,
    roundId: 'epoch/round/1',
    authorityEpoch: 'epoch',
    window: {
      id: 'w1', version: 4, opensAt: 1_000, deadlineAt: 6_000,
      options: [
        [{ kind: 'discard', tile: 'm5', index: 3 }, { kind: 'win' }, { kind: 'pass' }],
        [{ kind: 'peng', tile: 'm5', from: 0 }, { kind: 'pass' }],
      ],
    },
    ownActions: [{ kind: 'discard', tile: 'm5', index: 3 }, { kind: 'win' }, { kind: 'pass' }],
    hand: ['m1', 'm2', 'm5'],
    drawnTileIndex: 2,
    players: [
      { hand: ['m1', 'm2', 'm5'], discards: ['p1'], melds: [], score: 2_000 },
      { hand: [], discards: ['p2', 'p3'], melds: [{}], score: 1_900 },
    ],
    // public.seats 是**每座胡牌信息**（真实结构），不是牌河
    public: { seats: [
      { winCount: 0, locked: false, recordIds: [] },
      { winCount: 0, locked: false, recordIds: [] },
    ] },
    ...overrides,
  }
}

describe('血流适配层', () => {
  it('窗口内稳定 ID：同一窗口同一下标恒等，且与窗口绑定', () => {
    expect(legalActionId('w1', 2)).toBe('w1/2')
    expect(legalActionId('w1', 2)).toBe(legalActionId('w1', 2))
    expect(legalActionId('w2', 2)).not.toBe(legalActionId('w1', 2))
  })

  it('动作规范化：保留下标语义（摸切不能被当成同牌不同位置），吃牌保留组合', () => {
    expect(normalizeAction('w1', 0, { kind: 'discard', tile: 'm5', index: 3 }))
      .toEqual({ id: 'w1/0', kind: 'discard', tile: 'm5', handIndex: 3 })
    expect(normalizeAction('w1', 1, { kind: 'peng', tile: 'm5', from: 0 }))
      .toEqual({ id: 'w1/1', kind: 'peng', tile: 'm5', from: 0 })
    expect(normalizeAction('w1', 2, { kind: 'chi', tile: 'm4', tiles: ['m3', 'm5'] }))
      .toEqual({ id: 'w1/2', kind: 'chi', tile: 'm4', meld: ['m3', 'm5'] })
    // 未提供的字段不得凭空出现（不填 0、不填空串）
    expect(Object.keys(normalizeAction('w1', 3, { kind: 'pass' }))).toEqual(['id', 'kind'])
  })

  it('合法动作集按 options 下标编号', () => {
    const actions = legalActionsOf('w1', [{ kind: 'discard', tile: 'm9', index: 0 }, { kind: 'pass' }])
    expect(actions.map((action) => action.id)).toEqual(['w1/0', 'w1/1'])
    expect(actions[0]).toMatchObject({ kind: 'discard', tile: 'm9', handIndex: 0 })
  })

  it('窗口类型：有弃牌=摸牌回合，只有吃碰杠胡=响应窗口，都没有=other', () => {
    expect(windowKindOf([{ kind: 'discard' }, { kind: 'win' }])).toBe('draw-turn')
    expect(windowKindOf([{ kind: 'peng' }, { kind: 'pass' }])).toBe('claim')
    expect(windowKindOf([{ kind: 'win' }])).toBe('claim')
    expect(windowKindOf([{ kind: 'added-kong' }])).toBe('claim')
    expect(windowKindOf([{ kind: 'pass' }])).toBe('other')
  })

  it('前态 ID 随状态版本变化：同一窗口的不同状态版本是不同前态', () => {
    const first = decisionStateId(view(), 0)
    const second = decisionStateId(view({ window: { id: 'w1', version: 5 } }), 0)
    expect(first).toBe('epoch/round/1/w1/0/4')
    expect(second).not.toBe(first)
  })

  it('取该座位的合法动作：自己用 ownActions 兜底，别家只认 options', () => {
    const snapshot = view()
    expect(seatLegalActions(snapshot, 0)).toHaveLength(3)
    expect(seatLegalActions(snapshot, 1).map((action) => action.kind)).toEqual(['peng', 'pass'])
    // 别家没有 options 时不得拿自己的手牌/动作冒充（宁可空）
    expect(seatLegalActions(view({ window: { id: 'w1', version: 4 } }), 1)).toEqual([])
  })

  it('前态只取展示回放恢复不出来的部分，并带上合法动作', () => {
    const state = decisionStateOf(view(), 0)
    expect(state).toMatchObject({ id: 'epoch/round/1/w1/0/4', drawnTileIndex: 2, melds: 0 })
    expect(state.hand).toEqual(['m1', 'm2', 'm5'])
    expect(state.legalActions.map((action) => action.id)).toEqual(['w1/0', 'w1/1', 'w1/2'])

    // 看别家时：不给自己座位专属的摸牌索引（视角里那不属于该座位）
    const other = decisionStateOf(view(), 1)
    expect(other.drawnTileIndex).toBe(-1)
    expect(other.melds).toBe(1)
    expect(other.legalActions.map((action) => action.kind)).toEqual(['peng', 'pass'])
  })

  // §10.4：导出的决策输入只含"当时合法可见"的信息 —— 私有牌墙与对手暗手不得进入分析记录。
  // 用**真实引擎的座位视角**验证（而不是手搓快照），因为遮蔽是权威投影的职责。
  it('决策输入不含私有牌墙与对手暗手：字段形状固定，别家只有张数（§10.4）', () => {
    const pool = createWall()
    const remove = (tile: TileType) => { const index = pool.indexOf(tile); if (index >= 0) pool.splice(index, 1) }
    const flipTiles: [TileType, TileType] = ['p9', 'white']
    flipTiles.forEach(remove)
    const players = SEATS.map((seat): GamePlayer => ({
      seat, name: `P${seat}`, avatar: '', score: 2_000,
      hand: pool.splice(0, seat === 0 ? 14 : 13), melds: [], discards: [], redCount: 0, drawnTileIndex: -1,
    }))
    const engine = new BloodFlowEngine({
      authorityEpoch: 'epoch', roundId: 'epoch/round/1',
      opening: { players, wall: pool, flipTiles, jokers: ['red', 'green'],
        headDrawn: 134 - pool.length, dealerDrawnIndex: players[0].hand.length - 1,
        flipStack: 0, flipSeat: 0, wallBreakIndex: 2 },
      now: () => 0, winBeatMs: 0,
    })
    const seatView = bloodFlowSeatView(engine, 2)

    // 视角本身：只给牌墙**张数**，不给牌墙顺序；别家暗手是空数组 + 张数
    expect(seatView.wallCount).toBe(engine.wall.length)
    expect('wall' in (seatView as unknown as Record<string, unknown>)).toBe(false)
    expect('discardActions' in (seatView as unknown as Record<string, unknown>), '旁观专属字段不得出现在座位视角').toBe(false)
    for (const other of [0, 1, 3]) {
      expect(seatView.players[other].hand, `别家（${other}）暗手必须遮蔽`).toEqual([])
      expect(seatView.players[other].concealedTileCount).toBe(engine.players[other].hand.length)
    }

    const state = decisionStateOf(seatView, 2)
    // 字段形状固定：多出任何字段都说明有人把新信息塞进了决策输入
    expect(Object.keys(state).sort()).toEqual(['drawnTileIndex', 'hand', 'id', 'legalActions', 'melds'])
    // 手牌只能是**该座位自己的**（与引擎里同一份），且不含别家的牌
    expect(state.hand).toEqual(engine.players[2].hand)
    expect(state.hand.length).toBeGreaterThanOrEqual(13)
    // 记录文本里不得出现遮蔽前的对手张数痕迹，也不得出现完整牌墙（136 张的枚举）
    const text = JSON.stringify(state)
    expect(text).not.toContain('concealedTileCount')
    expect(text).not.toContain('flipTiles')
  })

  it('结算流水从权威账本派生：批次与杠各一条、同源多响保留同一 batchId、去重后不重复记（§5）', () => {
    const view: BloodFlowLedgerViewLike = {
      roundId: 'epoch/round/1',
      public: { batches: [
        { batchId: 'b1', source: { id: 's1', tile: 'm5', seat: 1, kind: 'discard' },
          winners: [{ winner: 0 }, { winner: 2 }], deltas: [60, -30, 60, -90], scoresAfter: [2060, 1970, 2060, 1910] },
      ] },
      kongEvents: [
        { id: 'k1', actor: 3, kongKind: 'concealed', deltas: [0, 0, -30, 90], scoresAfter: [2060, 1970, 2030, 2000] },
      ],
    }
    const seen = new Set<string>()
    const first = settlementsFromView(view, 1, seen)
    expect(first).toHaveLength(2)
    expect(first[0]).toMatchObject({
      id: 'settlement/epoch/round/1/b1', roundIndex: 1, sourceEventId: 's1', kind: 'win',
      winners: [0, 2], payers: [1, 3], batchId: 'b1',
    })
    expect(first[0].scoresAfter).toEqual([2060, 1970, 2060, 1910])
    expect(first[1]).toMatchObject({ kind: 'kong-concealed', winners: [3], payers: [2], batchId: 'k1' })

    // 视角是累计的：同一批次/杠再来一次不得重复记
    expect(settlementsFromView(view, 1, seen)).toEqual([])
    // 新增一条才继续记（每次结算只保存一次引用）
    const more: BloodFlowLedgerViewLike = {
      roundId: 'epoch/round/1',
      public: { batches: [...(view.public!.batches!), { batchId: 'b2', source: { id: 's2', tile: 'p9', seat: 0, kind: 'draw' },
        winners: [{ winner: 1 }], deltas: [-20, 60, -20, -20], scoresAfter: [2040, 2030, 2010, 1980] }] },
      kongEvents: view.kongEvents,
    }
    const second = settlementsFromView(more, 1, seen)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ id: 'settlement/epoch/round/1/b2', kind: 'self-draw', winners: [1] })
  })

  it('执行回执口径：只看该座位自己的可见变化，看不见就不算执行成功', () => {
    const discard = { kind: 'discard', tile: 'm5', index: 3 }
    const before = view()
    const afterDiscard = view({ players: [
      { hand: ['m1', 'm2'], discards: ['p1', 'm5'], melds: [], score: 2_000 },
      { hand: [], discards: ['p2', 'p3'], melds: [{}], score: 1_900 },
    ] })
    expect(choiceTookEffect(before, afterDiscard, 0, discard)).toBe(true)
    // 牌河没变 ⇒ 没生效（请求成功 ≠ 执行成功）
    expect(choiceTookEffect(before, view(), 0, discard)).toBe(false)

    const afterPeng = view({ players: [
      { hand: ['m1'], discards: ['p1'], melds: [{}], score: 2_000 },
      { hand: [], discards: ['p2'], melds: [], score: 1_900 },
    ] })
    expect(choiceTookEffect(before, afterPeng, 0, { kind: 'peng', tile: 'm5', from: 1 })).toBe(true)
    expect(choiceTookEffect(before, view(), 0, { kind: 'peng', tile: 'm5', from: 1 })).toBe(false)

    // 胡牌：用 public.seats[].winCount 判定（真实结构里它才是胡牌事实）
    const afterWin = view({ public: { seats: [
      { winCount: 1, locked: true, recordIds: ['r1'] },
      { winCount: 0, locked: false, recordIds: [] },
    ] } })
    expect(choiceTookEffect(before, afterWin, 0, { kind: 'win' })).toBe(true)
    expect(choiceTookEffect(before, view(), 0, { kind: 'win' })).toBe(false)
    // 视角没带 winCount 时退回分数变化作兜底
    const scored = view({
      public: { seats: [{}, {}] },
      players: [
        { hand: ['m1'], discards: ['p1'], melds: [], score: 2_120 },
        { hand: [], discards: ['p2', 'p3'], melds: [{}], score: 1_880 },
      ],
    })
    expect(choiceTookEffect(view({ public: { seats: [{}, {}] } }), scored, 0, { kind: 'win' })).toBe(true)

    // 过牌：没有自己的可见变化才算生效
    expect(choiceTookEffect(view(), view(), 0, { kind: 'pass' })).toBe(true)
    expect(choiceTookEffect(view(), afterDiscard, 0, { kind: 'pass' })).toBe(false)

    // 视角里没有该座位信息时不猜
    expect(choiceTookEffect({ seat: 0 }, { seat: 0 }, 3, discard)).toBe(false)
  })
})
