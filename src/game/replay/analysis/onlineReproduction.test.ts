// §6 复现载荷的构造与**严格解码**：这份数据经网络到达客户端，任何一项不过都必须整份拒绝。
//
// 为什么这么严：半份数据写进分析区，赛后"复现"会得出一个**看似成功**的错误结论 ——
// 比直接失败更难发现。所以这里逐项钉住：版本、身份、牌名、长度、四家手牌、开局分数、命令规模。
import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_REPRODUCTION_FORMAT_VERSION,
  ANALYSIS_REPRODUCTION_MAX_COMMANDS,
  buildReproductionPayload,
  decodeReproductionPayload,
  reproductionFromPayload,
  unavailableReproduction,
  type AnalysisReproductionPayload,
  type EngineReproductionDump,
} from './onlineReproduction'
import { TILE_TYPES } from '../../core/rules/tiles'

const hand = (offset: number) => Array.from({ length: 13 }, (_, index) => TILE_TYPES[(offset + index) % TILE_TYPES.length])
const wall = Array.from({ length: 81 }, (_, index) => TILE_TYPES[index % TILE_TYPES.length])

function dump(overrides: Partial<EngineReproductionDump> = {}): EngineReproductionDump {
  return {
    roundId: 'epoch/round/1',
    opening: {
      players: [
        { hand: [...hand(0), TILE_TYPES[30]], score: 2000 },
        { hand: hand(4), score: 2000 },
        { hand: hand(8), score: 2000 },
        { hand: hand(12), score: 2000 },
      ],
      wall,
      flipTiles: [TILE_TYPES[0], TILE_TYPES[1]],
      jokers: [TILE_TYPES[0]],
      headDrawn: 53,
      dealerDrawnIndex: 13,
      flipStack: 7,
      flipSeat: 0,
      wallBreakIndex: 14,
    },
    openingScores: [2000, 2000, 2000, 2000],
    dealer: 0,
    commands: [
      { seat: 0, kind: 'discard', at: 1, windowId: 'epoch/round/1/window/1', windowKind: 'turn', tile: 'm1', handIndex: 13 },
      { seat: -1, kind: 'expire', at: 2, resolution: 'expire' as const, windowId: 'epoch/round/1/window/2', windowKind: 'meld', waitingSeats: [1, 2] },
      { seat: 2, kind: 'chi', at: 3, windowId: 'epoch/round/1/window/3', windowKind: 'meld', tiles: ['m2', 'm3', 'm4'] },
    ],
    dice: { first: [2, 3], second: [3, 4] },
    ...overrides,
  }
}

const build = (overrides: Partial<EngineReproductionDump> = {}) => buildReproductionPayload({
  dump: dump(overrides), matchId: 'match-1', roundIndex: 1, authorityEpoch: 'epoch', roundId: 'epoch/round/1',
})

describe('§6 复现载荷：构造', () => {
  it('从权威引擎快照组装出可下发的载荷', () => {
    const payload = build()!
    expect(payload.formatVersion).toBe(ANALYSIS_REPRODUCTION_FORMAT_VERSION)
    expect(payload.matchId).toBe('match-1')
    expect(payload.roundIndex).toBe(1)
    expect(payload.initialWall).toHaveLength(81)
    expect(payload.initialHands.map(item => item.length)).toEqual([14, 13, 13, 13])
    expect(payload.openingScores).toEqual([2000, 2000, 2000, 2000])
    expect(payload.commands).toHaveLength(3)
    expect(payload.dice).toEqual({ first: [2, 3], second: [3, 4] })
  })

  it('拿不到就返回 null：空命令序列、错局快照、缺字段、坏数据一律不组装', () => {
    // 空命令序列＝引擎没开命令记录：给出去只会让客户端"复现"失败得不明白
    expect(build({ commands: [] })).toBeNull()
    // 命令规模异常
    expect(build({ commands: Array.from({ length: ANALYSIS_REPRODUCTION_MAX_COMMANDS + 1 }, () => ({ seat: 0, kind: 'pass', at: 0 })) })).toBeNull()
    // 缺开局分数（§6 必需：缺了结束分数无法比对）
    expect(build({ openingScores: [] })).toBeNull()
    // 牌墙缺失
    expect(build({ opening: { ...dump().opening, wall: [] } })).toBeNull()
    // 翻精不是两张
    expect(build({ opening: { ...dump().opening, flipTiles: [TILE_TYPES[0]] } })).toBeNull()
    // 手牌含未知牌名
    expect(build({ opening: { ...dump().opening, players: [{ hand: ['not-a-tile'], score: 2000 }, ...dump().opening.players.slice(1)] } })).toBeNull()
  })

  it('错局防护：快照的 roundId 与被请求的局不一致时不组装', () => {
    // 权威在读快照时可能已推进到下一局 —— "下一局的牌墙 + 本局的命令"会重跑出看似成功的错误结论
    expect(buildReproductionPayload({
      dump: dump({ roundId: 'epoch/round/2' }), matchId: 'match-1', roundIndex: 1,
      authorityEpoch: 'epoch', roundId: 'epoch/round/1',
    })).toBeNull()
  })
})

describe('§6 复现载荷：解码（网络输入，逐项校验）', () => {
  it('自己构造的载荷能原样解回（往返一致）', () => {
    const payload = build()!
    const decoded = decodeReproductionPayload(JSON.parse(JSON.stringify(payload)))
    expect(decoded.reason).toBeNull()
    expect(decoded.payload).toEqual(payload)
  })

  it('版本不兼容直接拒绝（不猜格式）', () => {
    const decoded = decodeReproductionPayload({ ...build()!, formatVersion: 99 })
    expect(decoded.payload).toBeNull()
    expect(decoded.reason).toContain('格式版本不兼容')
  })

  it('坏数据逐项拒绝并给出原因', () => {
    const cases: Array<[string, unknown, string]> = [
      ['不是对象', 'nope', '载荷不是对象'],
      ['缺场次', { ...build()!, matchId: '' }, '载荷缺少场次/局号'],
      ['缺庄家', { ...build()!, dealer: 7 }, '载荷缺少权威身份或庄家'],
      ['牌墙含未知牌', { ...build()!, initialWall: ['nope', ...wall.slice(1)] }, '初始牌墙缺失或含未知牌'],
      ['手牌不是四家', { ...build()!, initialHands: [hand(0), hand(1)] }, '初始手牌缺失或含未知牌'],
      ['翻精只有一张', { ...build()!, flipTiles: [TILE_TYPES[0]] }, '翻精不是两张已知牌'],
      ['精牌缺失', { ...build()!, jokers: [] }, '精牌缺失或含未知牌'],
      ['开局参数缺失', { ...build()!, flipStack: null }, '开局参数缺失'],
      ['庄家下标越界', { ...build()!, dealerDrawnIndex: 99 }, '庄家第 14 张下标越界'],
      ['缺开局分数', { ...build()!, openingScores: [2000] }, '开局分数缺失（缺了它结束后无法比对）'],
      ['命令不是数组', { ...build()!, commands: {} }, '命令序列缺失或规模异常'],
      ['命令座位非法', { ...build()!, commands: [{ seat: 9, kind: 'discard', at: 1 }] }, '命令条目座位非法'],
      ['命令缺 kind', { ...build()!, commands: [{ seat: 0, at: 1 }] }, '命令条目缺少 kind'],
      ['命令含未知牌', { ...build()!, commands: [{ seat: 0, kind: 'discard', at: 1, tile: 'nope' }] }, '命令条目含未知牌'],
      ['推进来源非法', { ...build()!, commands: [{ seat: 0, kind: 'pass', at: 1, resolution: 'guess' }] }, '命令条目推进来源非法'],
    ]
    for (const [label, value, expected] of cases) {
      const decoded = decodeReproductionPayload(value)
      expect(decoded.payload, label).toBeNull()
      expect(decoded.reason, label).toBe(expected)
    }
  })

  it('expire 条目的 seat=-1 是合法的（它不是某个座位的决定）', () => {
    const decoded = decodeReproductionPayload(build()!)
    expect(decoded.reason).toBeNull()
    expect(decoded.payload!.commands.some(entry => entry.seat === -1 && entry.resolution === 'expire')).toBe(true)
  })
})

describe('§6 复现载荷：落进分析区', () => {
  it('写成 origin=authority 的复现记录，且与载荷不共享引用', () => {
    const payload: AnalysisReproductionPayload = build()!
    const record = reproductionFromPayload(payload)
    expect(record.origin).toBe('authority')
    expect(record.available).toBe(true)
    expect(record.roundIndex).toBe(1)
    expect(record.flipTile).toBe(payload.flipTiles[0])
    expect(record.commands).toHaveLength(payload.commands.length)
    // 深拷贝：载荷被复用/改写时不得影响已落库的记录
    payload.commands[0]!.kind = 'mutated'
    payload.initialWall[0] = 'white'
    expect(record.commands![0]!.kind).not.toBe('mutated')
    expect(record.initialWall![0]).not.toBe('white')
  })

  it('拿不到时只写"不可用 + 原因"（§6：不猜测补齐）', () => {
    const record = unavailableReproduction(3, '联机权威端未提供赛后复现数据')
    expect(record.available).toBe(false)
    expect(record.origin).toBeUndefined()
    expect(record.unavailableReason).toBe('联机权威端未提供赛后复现数据')
    expect(record.commands).toBeUndefined()
    expect(record.initialWall).toBeUndefined()
  })
})
