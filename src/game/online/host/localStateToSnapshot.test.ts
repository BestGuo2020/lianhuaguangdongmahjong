import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { serializeStateToSnapshot, type SnapshotSource } from './localStateToSnapshot'
import type { GamePlayer } from '../../core/contracts/types'

function player(seat: number, hand: string[]): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

function makeSource(players: GamePlayer[]): SnapshotSource {
  return {
    phase: ref('discard'),
    players,
    wall: ref(['m1', 'm2', 'm3']),
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

describe('serializeStateToSnapshot', () => {
  it('脱敏：仅目标座位手牌可见，其余置 null 保留张数', () => {
    const players = [
      player(0, ['m1', 'm2']),
      player(1, ['m3', 'm4', 'm5']),
      player(2, ['m6']),
      player(3, []),
    ]
    const snapshot = serializeStateToSnapshot(makeSource(players), 0, { roomId: 'R', rulesetId: 'lotus-classic' })
    expect(snapshot.players[0].hand).toEqual(['m1', 'm2'])
    expect(snapshot.players[1].hand).toEqual([null, null, null])
    expect(snapshot.players[2].hand).toEqual([null])
    expect(snapshot.players[3].hand).toEqual([])
  })

  it('座位字段原样传递（房主本地下标即绝对座位）', () => {
    const source = makeSource([player(0, []), player(1, []), player(2, []), player(3, [])])
    source.currentPlayer = ref(2)
    source.dealer = ref(1)
    const snapshot = serializeStateToSnapshot(source, 1, { roomId: 'R', rulesetId: 'lotus-classic' })
    expect(snapshot.currentPlayer).toBe(2)
    expect(snapshot.dealer).toBe(1)
    expect(snapshot.seat).toBe(1)
  })

  it('墙与 wallCount 一致性', () => {
    const source = makeSource([player(0, []), player(1, []), player(2, []), player(3, [])])
    source.wall = ref(['m1', 'm2', 'm3'])
    const snapshot = serializeStateToSnapshot(source, 0, { roomId: 'R', rulesetId: 'lotus-classic' })
    expect(snapshot.wallCount).toBe(3)
    expect(snapshot.wall).toEqual(['m1', 'm2', 'm3'])
    expect(snapshot.headDrawn).toBe(1)
  })
})
