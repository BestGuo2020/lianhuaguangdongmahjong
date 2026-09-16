import { describe, expect, it } from 'vitest'
import { BloodFlowAuthority } from '../variants/lotus/bloodFlow/network/authority'
import { createDirectAuthorityBackend } from '../variants/lotus/bloodFlow/network/backends'
import { BLOOD_FLOW_CONFIG } from '../variants/lotus/bloodFlow/config'
import { createWall } from '../core/rules/tiles'
import { createReplayRecorder } from './recorder'
import {
  createBloodFlowRecordState,
  recordBloodFlowSettle,
  recordBloodFlowView,
  type BloodFlowRecordContext,
} from './bloodFlowRecorder'
import type { ReplayMatch, ReplayRound } from './types'
import type { Seat } from '../variants/lotus/bloodFlow/types'

// 联机（P2P）血流回放的**房主侧取数**：房主权威引擎在 worker/进程内，
// 全知牌谱只能通过 `authority.spectatorView()` 的旁观视角拿到（四家明牌 + 累计弃牌流水）。
// 这里用进程内 backend 做确定性验证：座位视角拿不到他家手牌，旁观视角必须拿得到。

const CONTEXT: BloodFlowRecordContext = {
  matchType: 'east',
  round: 1,
  dealer: 0,
  honba: 0,
  diceThrowerIndex: 0,
  wildcardTiles: ['white'],
}

function createHarness() {
  const clock = { now: 1_000 }
  const backend = createDirectAuthorityBackend(() => clock.now, { winBeatMs: 0 })
  const authority = new BloodFlowAuthority({
    roomId: 'room-1',
    authorityEpoch: 'epoch-1',
    hostPeer: 'host',
    seatByPeer: new Map<string, Seat>([['host', 0], ['p1', 1], ['p2', 2], ['p3', 3]]),
    mode: 'east',
    backend,
    send: () => {},
    now: () => clock.now,
    prepareOpening: async () => ({ initialWall: createWall(), firstDice: [1, 2], secondDice: [3, 4] }),
  })
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
      gameMode: 'remote' as const,
    }),
    now: () => clock.now,
    createId: () => 'remote-bf-match',
  })
  return { clock, backend, authority, saved, recorder }
}

/** 让所有座位都通过规则版本协商（房主的 hello 已内置）。 */
async function greetPeers(authority: BloodFlowAuthority) {
  for (const peer of ['p1', 'p2', 'p3']) {
    await authority.receive(
      { kind: 'blood_flow_hello', roomId: 'room-1', ruleVersion: BLOOD_FLOW_CONFIG.version },
      peer,
    )
  }
}

describe('联机血流回放：房主旁观视角取数', () => {
  it('座位视角只有自己的手牌；旁观视角给四家明牌与累计弃牌流水', async () => {
    const { backend } = createHarness()
    await backend.start({
      initialWall: createWall(),
      firstDice: [1, 2],
      secondDice: [3, 4],
      dealer: 0,
      scores: [2000, 2000, 2000, 2000],
      authorityEpoch: 'epoch-1',
      roundId: 'epoch-1/round/1',
    })

    const ownSeat = await backend.view(1)
    const spectator = await backend.spectator()

    // 座位视角：自己的手牌有牌，而他家手牌是隐藏的（空数组）
    expect(ownSeat.seat).toBe(1)
    expect(ownSeat.players[1].hand.length).toBeGreaterThan(0)
    expect(ownSeat.players[0].hand).toHaveLength(0)
    expect('discardActions' in ownSeat).toBe(false)

    // 旁观视角：四家明牌 + 累计弃牌流水（回放录制需要它才不会漏掉中间弃牌）
    expect(spectator.players.every((player) => player.hand.length > 0)).toBe(true)
    expect(spectator.players.map((player) => player.hand.length).sort()).toEqual([13, 13, 13, 14])
    expect(Array.isArray(spectator.discardActions)).toBe(true)
    // 牌山/精牌信息照旧可用（回放要还原牌山与牌面标记）
    expect(spectator.flipTile).toBeTruthy()
    expect(spectator.jokers.length).toBeGreaterThanOrEqual(1)
    expect(spectator.wallCount).toBeGreaterThan(0)
  })

  it('权威 spectatorView 在协商前/未开局时返回 null 而不抛错（有界调用）', async () => {
    const { authority } = createHarness()
    await expect(authority.spectatorView()).resolves.toBeNull()
  })

  it('用旁观视角整局录制：事件流有步、结算四家明牌，场次标为联机', async () => {
    const { backend, recorder, saved } = createHarness()
    await backend.start({
      initialWall: createWall(),
      firstDice: [1, 2],
      secondDice: [3, 4],
      dealer: 0,
      scores: [2000, 2000, 2000, 2000],
      authorityEpoch: 'epoch-1',
      roundId: 'epoch-1/round/1',
    })
    const engine = backend.engine
    const state = createBloodFlowRecordState()

    // 与房主权威同一条取数路径：每步取 spectator()，结算时用旁观视角收尾
    recordBloodFlowView(recorder.hooks, await backend.spectator(), CONTEXT, state)
    let steps = 0
    while (!engine.result && steps < 2_000) {
      steps += 1
      const window = engine.window!
      const seat = ([0, 1, 2, 3] as Seat[]).find((s) => window.options[s].length && !window.decisions[s])!
      const moves = window.options[seat]
      const action = moves.find((move) => move.kind === 'win')
        ?? moves.find((move) => move.kind === 'discard')
        ?? moves[0]
      if (!engine.submit(engine.command(seat, action))) throw new Error('rejected legal action')
      const view = await backend.spectator()
      recordBloodFlowView(recorder.hooks, view, CONTEXT, state)
      if (view.public.roundResult) {
        recordBloodFlowSettle(recorder.hooks, view, CONTEXT, state)
        break
      }
    }

    recorder.finishAuto()
    const rounds = recorder.snapshot().rounds
    expect(rounds).toHaveLength(1)
    const round = rounds[0]
    expect(round.steps.length).toBeGreaterThan(10)
    // 四家都出现过手牌（全知；若走座位视角只会有座位 0 一家）
    const seatsWithHands = new Set<number>()
    for (const step of round.steps) {
      if (step.state && step.state.hand.length) seatsWithHands.add(step.seat)
    }
    expect(seatsWithHands.size).toBeGreaterThan(1)
    // 结算帧四家明牌
    for (const hand of round.final?.hands ?? []) expect(hand.length).toBeGreaterThan(0)
    // 联机牌谱要经广播传输：必须是可结构化克隆的纯数据
    expect(() => structuredClone(round)).not.toThrow()
    expect(saved.matches.at(-1)?.gameMode).toBe('remote')
    expect(saved.rounds).toHaveLength(1)
  })
})
