import { describe, expect, it } from 'vitest'
import { BloodFlowEngine } from '../variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import { SEATS } from '../variants/lotus/bloodFlow/state'
import { seededRandom } from '../variants/lotus/bloodFlow/simulation'
import type { Seat } from '../variants/lotus/bloodFlow/types'
import { createReplayRecorder } from './recorder'
import { createBloodFlowRecordState, recordBloodFlowView, type BloodFlowRecordContext } from './bloodFlowRecorder'
import { buildReplayFrames, type ReplayFrame } from './projection'
import type { Meld } from '../core/contracts/types'
import type { ReplayMatch, ReplayRound } from './types'

// 玩法三（血流）录制：权威引擎跑在 worker 里，客户端只能拿到视角快照。
// 这里用确定性的规则 AI 驱动真实引擎，并逐命令采样「旁观视角」，验证录制与折叠。

function spectatorOf(engine: BloodFlowEngine) {
  return bloodFlowSeatView(engine, 0, { revealAll: true, includeDiscards: true })
}

function contextOf(round: number): BloodFlowRecordContext {
  return {
    matchType: 'east',
    round,
    dealer: 0,
    honba: 0,
    diceThrowerIndex: 0,
    wildcardTiles: ['white'],
  }
}

/** 用确定性策略把一局血流打完，每个命令后采样一次旁观视角（1:1 采样）。 */
function playRound(seed: number, recorder: ReturnType<typeof createReplayRecorder>, roundId: string, roundNo: number) {
  const random = seededRandom(seed)
  const engine = new BloodFlowEngine({
    authorityEpoch: 'replay-test',
    roundId,
    random,
    dealer: 0,
    now: () => 0,
    winBeatMs: 0,
  })
  const state = createBloodFlowRecordState()
  const context = contextOf(roundNo)
  recordBloodFlowView(recorder.hooks, spectatorOf(engine), context, state)
  let commands = 0
  while (!engine.result) {
    if (++commands > 2000) throw new Error(`Stalled seed ${seed}`)
    const window = engine.window!
    const seat = SEATS.find((s: Seat) => window.options[s].length && !window.decisions[s])!
    const moves = window.options[seat]
    const win = moves.find((action) => action.kind === 'win')
    const discards = moves.filter((action) => action.kind === 'discard')
    const action = win ?? (discards.length ? discards[Math.floor(random() * discards.length)] : moves[0])
    if (!engine.submit(engine.command(seat, action))) throw new Error(`Rejected legal action in seed ${seed}`)
    engine.assertConservation()
    recordBloodFlowView(recorder.hooks, spectatorOf(engine), context, state)
  }
  return { engine, commands }
}

function harness() {
  const saved: { matches: ReplayMatch[]; rounds: ReplayRound[] } = { matches: [], rounds: [] }
  const recorder = createReplayRecorder({
    sink: {
      saveMatch: (match) => { saved.matches.push(match) },
      saveRound: (round) => { saved.rounds.push(round) },
    },
    meta: () => ({
      rulesetId: 'lotus-blood-flow',
      rulesetName: '莲花麻将·血流',
      themeName: 'llm',
      humanSeat: 0,
    }),
    now: () => 1_700_000_200_000,
    createId: () => 'bf-match',
  })
  return { saved, recorder }
}

/** 场上可见牌数（不含翻精墩与已归档的和牌张）。 */
function inPlayOf(frame: ReplayFrame): number {
  const players = frame.table.players ?? []
  return frame.wallLeft
    + players.reduce((sum, player) => sum + player.hand.length, 0)
    + players.reduce((sum, player) => sum + player.discards.length, 0)
    + players.reduce(
      (sum, player) => sum + player.melds.reduce((meldSum: number, meld: Meld) => meldSum + meld.tiles.length, 0),
      0,
    )
}

describe('玩法三（血流）回放录制', () => {
  it('确定性一局：事件完备，折叠与引擎终态一致', () => {
    const { recorder } = harness()
    const { engine } = playRound(7, recorder, 'round-1', 1)

    const round = recorder.snapshot().rounds[0]
    expect(round).toBeTruthy()
    const steps = round.steps
    const discards = steps.filter((step) => step.t === 'discard')
    const wins = steps.filter((step) => step.t === 'win')
    const melds = steps.filter((step) => step.t === 'meld')
    const draws = steps.filter((step) => step.t === 'draw')

    // 血流一局会多次胡牌：动作流水与弃牌流水都应收全
    expect(discards.length).toBeGreaterThan(10)
    expect(engine.discardActions.length).toBe(discards.length)
    expect(engine.actions.length).toBe(wins.length + melds.length)
    expect(wins.length).toBeGreaterThanOrEqual(1)
    expect(draws.length).toBeGreaterThan(5)
    expect(steps.every((step) => ['draw', 'discard', 'meld', 'win'].includes(step.t))).toBe(true)
    // 每一步都带真实座位状态，落库前必须可结构化克隆
    expect(steps.filter((step) => step.state).length).toBeGreaterThan(steps.length * 0.8)
    expect(() => structuredClone(round)).not.toThrow()

    // ── 结算快照与引擎终态一致 ──
    const final = round.final!
    expect(final).toBeTruthy()
    engine.players.forEach((player, seat) => {
      expect(final.scores[seat], `座位 ${seat} 分数`).toBe(player.score)
      expect([...final.hands[seat]].sort(), `座位 ${seat} 手牌`).toEqual([...player.hand].sort())
      expect([...final.discards[seat]].sort(), `座位 ${seat} 牌河`).toEqual([...player.discards].sort())
      expect(
        final.melds[seat].map((meld) => `${meld.type}:${[...meld.tiles].sort().join(',')}`).sort(),
        `座位 ${seat} 副露`,
      ).toEqual(player.melds.map((meld) => `${meld.type}:${[...meld.tiles].sort().join(',')}`).sort())
    })
    // 血流没有单一赢家：结算帧不造假赢家，胡牌次数进 details
    expect(final.winSeat).toBeUndefined()
    expect(final.details?.length).toBeGreaterThanOrEqual(1)
    expect(final.draw).toBe(false)

    // ── 折叠：任意一帧牌数单调不增（和牌张进归档），局末与引擎终态吻合 ──
    const match = recorder.snapshot().match!
    const frames = buildReplayFrames(match, round, { revealAll: true })
    expect(frames.length).toBe(steps.length + 2)
    let previousInPlay = Number.POSITIVE_INFINITY
    for (const frame of frames) {
      const inPlay = inPlayOf(frame)
      expect(inPlay, `帧 ${frame.index} 牌数`) .toBeLessThanOrEqual(previousInPlay)
      expect(inPlay).toBeGreaterThanOrEqual(136 - 2 - 12)   // 最多三响 × 若干次
      previousInPlay = inPlay
    }
    const winTiles = engine.publicState().batches.reduce((sum, batch) => sum + batch.winners.length, 0)
    expect(inPlayOf(frames[frames.length - 1])).toBe(136 - 2 - winTiles)
    // 开局帧四家各 13 张（庄家 14）
    expect(frames[0].table.players?.map((player) => player.hand.length).sort()).toEqual([13, 13, 13, 14])
    expect(frames[0].table.jokerTiles.length).toBeGreaterThanOrEqual(1)
    expect(frames[0].table.flipTile).not.toBeNull()
  })

  it('同一场次多局：roundId 变化开新局，收尾按末局分数排名', () => {
    const { recorder } = harness()
    playRound(11, recorder, 'round-1', 1)
    playRound(12, recorder, 'round-2', 2)
    playRound(13, recorder, 'round-3', 3)
    playRound(14, recorder, 'round-4', 4)

    const rounds = recorder.snapshot().rounds
    expect(rounds.map((round) => round.roundLabel)).toEqual(['东1局', '东2局', '东3局', '东4局'])
    expect(rounds.map((round) => round.roundIndex)).toEqual([1, 2, 3, 4])

    const match = recorder.finishAuto()!
    expect(match.rulesetId).toBe('lotus-blood-flow')
    expect(match.rulesetName).toBe('莲花麻将·血流')
    expect(match.status).toBe('finished')
    expect(match.roundCount).toBe(4)
    expect(match.myRank).toBeGreaterThanOrEqual(1)
    expect(match.myRank).toBeLessThanOrEqual(4)
    expect(match.finalStandings).toHaveLength(4)
    expect(match.players.map((player) => player.startScore)).toEqual([2000, 2000, 2000, 2000])
  })

  it('同一 roundId 的重复快照不会重复记事件', () => {
    const { recorder } = harness()
    const random = seededRandom(21)
    const engine = new BloodFlowEngine({
      authorityEpoch: 'replay-test',
      roundId: 'round-dup',
      random,
      dealer: 0,
      now: () => 0,
      winBeatMs: 0,
    })
    const state = createBloodFlowRecordState()
    const context = contextOf(1)
    recordBloodFlowView(recorder.hooks, spectatorOf(engine), context, state)
    for (let commands = 0; commands < 40 && !engine.result; commands += 1) {
      const window = engine.window!
      const seat = SEATS.find((s: Seat) => window.options[s].length && !window.decisions[s])!
      const moves = window.options[seat]
      const action = moves.find((move) => move.kind === 'win')
        ?? moves.find((move) => move.kind === 'discard')
        ?? moves[0]
      engine.submit(engine.command(seat, action))
      const spectator = spectatorOf(engine)
      // 同一份快照重复投递（模拟采样重复）→ 不应产生新事件
      recordBloodFlowView(recorder.hooks, spectator, context, state)
      recordBloodFlowView(recorder.hooks, spectator, context, state)
      recordBloodFlowView(recorder.hooks, spectator, context, state)
    }
    if (!engine.result) {
      // 未打完也要能收尾（丢弃进行中的局）
      expect(recorder.finish('aborted')).toBeNull()
      return
    }
    const round = recorder.snapshot().rounds[0]
    expect(round).toBeTruthy()
    expect(round.steps.filter((step) => step.t === 'discard').length).toBe(engine.discardActions.length)
    expect(round.steps.filter((step) => step.t !== 'discard' && step.t !== 'draw').length)
      .toBe(engine.actions.length)
  })
})
