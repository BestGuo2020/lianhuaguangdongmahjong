import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import { useReplayPlayer } from './useReplayPlayer'
import type { ReplayMatch, ReplayRound, ReplayStep } from './types'

// 播放状态机单测：帧序列、单步、局切换、鸣牌/和牌锚点跳转。
// 不需要 DOM：帧序列由 projection 从合成牌谱生成。

const MATCH: ReplayMatch = {
  id: 'player-test',
  schemaVersion: 1,
  rulesetId: 'lotus-classic',
  rulesetName: '莲花广麻',
  matchType: 'east',
  matchName: '东风场',
  gameMode: 'local',
  themeName: 'jade',
  players: [
    { seat: 0, name: '本家', avatar: '', startScore: 1000 },
    { seat: 1, name: '下家', avatar: '', startScore: 1000 },
    { seat: 2, name: '对家', avatar: '', startScore: 1000 },
    { seat: 3, name: '上家', avatar: '', startScore: 1000 },
  ],
  humanSeat: 0,
  startedAt: 0,
  endedAt: 0,
  status: 'finished',
  roundCount: 2,
  summary: '',
}

function step(partial: Partial<ReplayStep> & Pick<ReplayStep, 't' | 'seat'>): ReplayStep {
  return {
    wallLeft: 80,
    headDrawn: 1,
    currentPlayer: 0,
    ...partial,
  }
}

function makeRound(roundIndex: number, steps: ReplayStep[]): ReplayRound {
  return {
    id: `${MATCH.id}:${roundIndex}`,
    matchId: MATCH.id,
    roundIndex,
    round: roundIndex,
    roundLabel: `东${roundIndex}局`,
    dealer: 0,
    honba: 0,
    matchType: 'east',
    dice: { second: [3, 4] },
    diceThrowerIndex: 0,
    flipTile: null,
    jokerTiles: ['white'],
    wildcardTiles: [],
    wallBreakIndex: 0,
    flipStack: null,
    scoresBefore: [1000, 1000, 1000, 1000],
    anchor: {
      hands: [['m1'], ['m2'], ['m3'], ['m4']],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
      drawnTileIndex: [-1, -1, -1, -1],
      redCount: [0, 0, 0, 0],
      scores: [1000, 1000, 1000, 1000],
      wallLeft: 80,
      headDrawn: 1,
      currentPlayer: 0,
    },
    steps,
    final: null,
    landedAt: 0,
  }
}

/** 事件序列：2 步普通摸打，然后一次碰（帧 5）与一次自摸（帧 6）。 */
const ROUND_ONE = makeRound(1, [
  step({ t: 'draw', seat: 0, tile: 'm5' }),
  step({ t: 'discard', seat: 0, tile: 'm5' }),
  step({ t: 'draw', seat: 1, tile: 'p1' }),
  step({ t: 'discard', seat: 1, tile: 'p1' }),
  step({ t: 'meld', seat: 2, tile: 's3', kind: 'peng', from: 1, actionType: 'peng' }),
  step({ t: 'win', seat: 0, tile: 'm9', actionType: 'self-draw' }),
])

const ROUND_TWO = makeRound(2, [step({ t: 'discard', seat: 0, tile: 'east' })])

function createPlayer() {
  const rounds = [ROUND_ONE, ROUND_TWO]
  const scope = effectScope()
  const player = scope.run(() => useReplayPlayer({ match: () => MATCH, rounds: () => rounds }))!
  return { player, scope }
}

describe('回放播放状态机', () => {
  it('帧序列 = 开局帧 + 每步一帧（无结算帧时为步数 + 1）', () => {
    const { player, scope } = createPlayer()
    expect(player.frames.value).toHaveLength(ROUND_ONE.steps.length + 1)
    expect(player.frames.value[0].index).toBe(0)
    expect(player.frames.value[0].step).toBeNull()
    expect(player.frames.value[1].step?.t).toBe('draw')
    expect(player.frame.value?.index).toBe(0)
    expect(player.atStart.value).toBe(true)
    scope.stop()
  })

  it('单步前进/后退与边界收敛', () => {
    const { player, scope } = createPlayer()
    player.next()
    expect(player.frameIndex.value).toBe(1)
    player.prev()
    expect(player.frameIndex.value).toBe(0)
    player.prev()
    expect(player.frameIndex.value).toBe(0)   // 越界停在开局帧
    player.last()
    expect(player.atEnd.value).toBe(true)
    player.next()
    expect(player.frameIndex.value).toBe(player.frames.value.length - 1)
    scope.stop()
  })

  it('鸣牌/和牌锚点：跳转只落在重事件帧上，且两端不越界', () => {
    const { player, scope } = createPlayer()
    // 步骤下标 4（碰）与 5（和）→ 帧下标 5 与 6
    expect(player.actionFrames.value).toEqual([5, 6])
    player.jumpAction(1)
    expect(player.frameIndex.value).toBe(5)
    expect(player.frame.value?.step?.t).toBe('meld')
    player.jumpAction(1)
    expect(player.frameIndex.value).toBe(6)
    expect(player.frame.value?.step?.t).toBe('win')
    player.jumpAction(1)
    expect(player.frameIndex.value).toBe(6)   // 没有下一个锚点：停在原位
    player.jumpAction(-1)
    expect(player.frameIndex.value).toBe(5)
    player.first()
    player.jumpAction(-1)
    expect(player.frameIndex.value).toBe(0)
    scope.stop()
  })

  it('切局重置帧位置；无鸣牌的局锚点为空且跳转是空操作', () => {
    const { player, scope } = createPlayer()
    player.last()
    player.selectRound(1)
    expect(player.roundIndex.value).toBe(1)
    expect(player.frameIndex.value).toBe(0)
    expect(player.round.value?.roundLabel).toBe('东2局')
    expect(player.actionFrames.value).toEqual([])
    player.jumpAction(1)
    expect(player.frameIndex.value).toBe(0)
    scope.stop()
  })

  it('视角切换重建帧序列但保留当前步（可按当时所见重看）', () => {
    const { player, scope } = createPlayer()
    player.seek(3)
    expect(player.frames.value[3].table.revealHands).toBe(true)
    player.revealAll.value = false
    expect(player.frameIndex.value).toBe(3)
    expect(player.frames.value[3].table.revealHands).toBe(false)
    expect(player.frames.value[3].step?.t).toBe('draw')
    scope.stop()
  })
})
