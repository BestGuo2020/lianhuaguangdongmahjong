import { describe, expect, it } from 'vitest'
import { buildReplayFrames } from './projection'
import { bloodFlowWinPiles } from '../../components/table/three/bloodFlowWinPile'
import type { ReplayMatch, ReplayRound, ReplayStep } from './types'

// 回放里的「盖楼」：把每一步胡牌折成一楼，随推进累积，并复用实时那套牌堆摆放。
// 关键点：回放没有引擎的完整 WinBatch（番型/赔付在当时的快照里），
// 所以这里验证"按 win 步骤合成的结构子集"足以画出牌堆，且不污染非血流玩法。

function baseStep(overrides: Partial<ReplayStep>): ReplayStep {
  return { t: 'discard', seat: 0, tile: 'm5', wallLeft: 60, headDrawn: 10, currentPlayer: 1, ...overrides }
}

function makeRound(): ReplayRound {
  const steps: ReplayStep[] = [
    baseStep({ t: 'draw', seat: 1, tile: 'p2' }),
    baseStep({ t: 'discard', seat: 1, tile: 'p2' }),
    // 自摸胡：source = 自己摸的牌
    baseStep({ t: 'win', seat: 2, tile: 'm9', from: null, actionType: 'self-draw' }),
    baseStep({ t: 'draw', seat: 3, tile: 's1' }),
    // 点炮胡：source = 放炮者的弃牌
    baseStep({ t: 'win', seat: 0, tile: 's1', from: 3, actionType: 'discard-win' }),
  ]
  return {
    id: 'match-1:1', matchId: 'match-1', roundIndex: 1, round: 1, roundLabel: '东1局',
    dealer: 0, honba: 0, matchType: 'east', dice: { second: [3, 4] }, diceThrowerIndex: 0,
    flipTile: 'p9', jokerTiles: ['p9', 'white'], wildcardTiles: ['white'],
    wallBreakIndex: 12, flipStack: 7, scoresBefore: [1000, 1000, 1000, 1000],
    anchor: {
      hands: [['m1'], ['m2'], ['m3'], ['m4']], melds: [[], [], [], []], discards: [[], [], [], []],
      drawnTileIndex: [-1, -1, -1, -1], redCount: [0, 0, 0, 0], scores: [1000, 1000, 1000, 1000],
      wallLeft: 60, headDrawn: 10, currentPlayer: 0,
    },
    steps,
    final: null,
    landedAt: 0,
  }
}

function makeMatch(rulesetId: ReplayMatch['rulesetId']): ReplayMatch {
  return {
    id: 'match-1', schemaVersion: 1, rulesetId, rulesetName: '莲花麻将·血流',
    matchType: 'east', matchName: '东风场', gameMode: 'local', themeName: 'jade',
    players: [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, avatar: '', startScore: 1000 })),
    humanSeat: 0, startedAt: 1, endedAt: 2, status: 'finished', roundCount: 1, myRank: 1, myScore: 0, summary: '',
  }
}

const pilesOf = (frame: { table: { bloodFlowBatches?: readonly unknown[] } }) => frame.table.bloodFlowBatches ?? []

describe('回放血流牌堆（盖楼）', () => {
  it('随胡牌步骤累积楼层，并给出源牌与胡牌者', () => {
    const frames = buildReplayFrames(makeMatch('lotus-blood-flow'), makeRound(), { revealAll: true })
    // 开局锚点帧还没有楼
    expect(pilesOf(frames[0])).toHaveLength(0)

    const winIndexes = frames
      .map((frame, index) => ({ frame, index }))
      .filter(({ frame }) => frame.step?.t === 'win')
      .map(({ index }) => index)
    expect(winIndexes).toHaveLength(2)

    // 第一次胡牌之后恰好一楼
    const afterFirst = frames[winIndexes[0]].table.bloodFlowBatches ?? []
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].source.tile).toBe('m9')
    expect(afterFirst[0].source.kind).toBe('draw')
    expect(afterFirst[0].source.seat).toBe(2)
    expect(afterFirst[0].winners[0].winner).toBe(2)

    // 第二次胡牌之后两楼（后面那楼是点炮，源牌来自放炮者）
    const afterSecond = frames[winIndexes[1]].table.bloodFlowBatches ?? []
    expect(afterSecond).toHaveLength(2)
    expect(afterSecond[1].source.tile).toBe('s1')
    expect(afterSecond[1].source.kind).toBe('discard')
    expect(afterSecond[1].source.seat).toBe(3)
    expect(afterSecond[1].winners[0].winner).toBe(0)

    // 最终帧保留全部楼
    const last = frames.at(-1)!
    expect(last.table.bloodFlowBatches ?? []).toHaveLength(2)
  })

  it('合成的牌堆数据能被实时那套摆放函数直接消费（两家各一楼）', () => {
    const frames = buildReplayFrames(makeMatch('lotus-blood-flow'), makeRound(), { revealAll: true })
    const last = frames.at(-1)!
    const piles = bloodFlowWinPiles(last.table.bloodFlowBatches ?? [], 0, false)
    expect(piles).toHaveLength(4)
    // humanSeat = 0 ⇒ 座位 0 与 2 各有一楼，其余为空
    expect(piles[0].count).toBe(1)
    expect(piles[1].count).toBe(0)
    expect(piles[2].count).toBe(1)
    expect(piles[3].count).toBe(0)
    expect(piles[2].tiles[0].tile).toBe('m9')
    expect(piles[0].tiles[0].tile).toBe('s1')
    // 楼层：单张时 level=0、column=0
    expect(piles[2].tiles[0].level).toBe(0)
  })

  it('非血流玩法不产生牌堆（不污染其它规则）', () => {
    const frames = buildReplayFrames(makeMatch('lotus-legacy'), makeRound(), { revealAll: true })
    expect(frames.every((frame) => frame.table.bloodFlowBatches === undefined)).toBe(true)
  })
})
