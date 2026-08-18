import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { serializeStateToSnapshot, type SnapshotSource } from './localStateToSnapshot'
import { decodeServerMessage } from '../protocol/decoder'
import type { GamePlayer, TileType } from '../../core/contracts/types'

function player(seat: number, hand: TileType[]): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

function makeSource(players: GamePlayer[]): SnapshotSource {
  return {
    phase: ref('discard'),
    players,
    wall: ref<TileType[]>(['m1', 'm2', 'm3']),
    wallHeadDrawn: ref(1),
    currentPlayer: ref(0),
    lastDiscard: ref(null),
    result: ref(null),
    announcement: ref(null),
    winPresentation: ref(null),
    winningPlayerIndex: ref(-1),
    round: ref(1),
    dealer: ref(0),
    honba: ref(0),
    matchType: ref('east'),
    matchFinished: ref(false),
    diceValues: ref([1, 2]),
  }
}

function context(overrides: Partial<Parameters<typeof serializeStateToSnapshot>[2]> = {}) {
  return {
    roomId: 'R',
    rulesetId: 'lotus-classic' as const,
    authorityEpoch: 'epoch-1',
    sequence: 1,
    ...overrides,
  }
}

describe('serializeStateToSnapshot', () => {
  it('脱敏：仅目标座位手牌可见，其余置 null 保留张数', () => {
    const players = [
      player(0, ['m1', 'm2']),
      player(1, ['m3', 'm4', 'm5']),
      player(2, ['m6']),
      player(3, []),
    ]
    const snapshot = serializeStateToSnapshot(makeSource(players), 0, context())
    expect(snapshot.players[0].hand).toEqual(['m1', 'm2'])
    expect(snapshot.players[1].hand).toEqual([null, null, null])
    expect(snapshot.players[2].hand).toEqual([null])
    expect(snapshot.players[3].hand).toEqual([])
  })

  it('座位字段原样传递（房主本地下标即绝对座位）', () => {
    const source = makeSource([player(0, []), player(1, []), player(2, []), player(3, [])])
    source.currentPlayer = ref(2)
    source.dealer = ref(1)
    const snapshot = serializeStateToSnapshot(source, 1, context())
    expect(snapshot.currentPlayer).toBe(2)
    expect(snapshot.dealer).toBe(1)
    expect(snapshot.seat).toBe(1)
  })

  it('墙与 wallCount 一致性', () => {
    const source = makeSource([player(0, []), player(1, []), player(2, []), player(3, [])])
    source.wall = ref<TileType[]>(['m1', 'm2', 'm3'])
    const snapshot = serializeStateToSnapshot(source, 0, context())
    expect(snapshot.wallCount).toBe(3)
    expect(snapshot.wall).toEqual(['m1', 'm2', 'm3'])
    expect(snapshot.headDrawn).toBe(1)
  })

  it('远端快照省略牌墙内容，只保留数量和进度', () => {
    const source = makeSource([player(0, []), player(1, []), player(2, []), player(3, [])])
    const snapshot = serializeStateToSnapshot(source, 1, context({
      includeWall: false,
    }))
    expect(snapshot.wall).toBeUndefined()
    expect(snapshot.wallCount).toBe(3)
    expect(snapshot.headDrawn).toBe(1)
  })

  it('序列化结果能通过客户端解码器校验（含 openingStack 等必填字段）', () => {
    const players = [player(0, ['m1']), player(1, []), player(2, []), player(3, [])]
    const snapshot = serializeStateToSnapshot(makeSource(players), 0, context())
    expect(decodeServerMessage(snapshot)).not.toBeNull()
  })

  it('没有有效房主代次或快照序号时拒绝生成可发送快照', () => {
    const source = makeSource([player(0, []), player(1, []), player(2, []), player(3, [])])
    expect(() => serializeStateToSnapshot(source, 0, context({ authorityEpoch: '', sequence: 1 }))).toThrow()
    expect(() => serializeStateToSnapshot(source, 0, context({ sequence: 0 }))).toThrow()
  })

  it('引擎记录 wallBreakIndex 时快照下发真实断点（联机广麻 3D 开口位置修复）', () => {
    // 回归：广麻引擎此前无 wallBreakIndex 字段，快照恒发 0，客户端 3D 的
    // `props.wallBreakIndex ?? wallBreakIndex(dice)` 把 0 当有效值，开口位置无视骰子。
    // 引擎补字段后，快照必须携带真实断点。
    const source = makeSource([player(0, []), player(1, []), player(2, []), player(3, [])])
    source.wallBreakIndex = ref(104)
    const snapshot = serializeStateToSnapshot(source, 0, context())
    expect(snapshot.wallBreakIndex).toBe(104)
  })
})
