import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLotusGame } from '../variants/lotus/lotusGame'
import { createReplayRecorder } from './recorder'
import { firstUncloneable } from './plain'
import { buildReplayFrames, type ReplayFrame } from './projection'
import type { GamePlayer, Meld } from '../core/contracts/types'
import type { ReplayMatch, ReplayRound } from './types'

// 玩法二（莲花麻将）整场录制回放：翻精墩 2 张移出牌墙，场上牌数守恒为 134。

/** 莲花麻将：牌墙 + 手牌 + 副露 + 牌河恒为 134（翻精墩已移出）。 */
const LOTUS_TILES = 134

function stubWindow() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function tileTotal(frame: ReplayFrame): number {
  const players = frame.table.players ?? []
  return frame.wallLeft
    + players.reduce((sum, player) => sum + player.hand.length, 0)
    + players.reduce((sum, player) => sum + player.discards.length, 0)
    + players.reduce(
      (sum, player) => sum + player.melds.reduce((meldSum: number, meld: Meld) => meldSum + meld.tiles.length, 0),
      0,
    )
}

function snapshotPlayers(players: readonly GamePlayer[]) {
  return players.map((player) => ({
    score: player.score,
    hand: [...player.hand].sort(),
    discards: [...player.discards].sort(),
    melds: player.melds.map((meld) => `${meld.type}:${[...meld.tiles].sort().join(',')}`).sort(),
  }))
}

function createHarness() {
  const saved: { matches: ReplayMatch[]; rounds: ReplayRound[] } = { matches: [], rounds: [] }
  const recorder = createReplayRecorder({
    sink: {
      saveMatch: (match) => { saved.matches.push(match) },
      saveRound: (round) => { saved.rounds.push(round) },
    },
    meta: () => ({
      rulesetId: 'lotus-legacy',
      rulesetName: '莲花麻将',
      themeName: 'rosewood',
      humanSeat: 0,
    }),
    now: () => 1_700_000_100_000,
    createId: () => 'lotus-match',
  })
  return { saved, recorder }
}

describe('玩法二（莲花麻将）回放录制', () => {
  it('整场录制：翻精信息齐全，折叠局面与引擎结算态一致，每帧牌数守恒 134', async () => {
    stubWindow()
    const { saved, recorder } = createHarness()
    const game = useLotusGame({
      playSound: () => {},
      playSoundAndWait: async () => {},
      recorder: recorder.hooks,
    })

    const startPromise = game.startGame('east')
    const settled: ReturnType<typeof snapshotPlayers>[] = []
    let guard = 0
    while (guard < 8000) {
      guard += 1
      if (game.matchFinished.value || game.phase.value === 'finished') break
      if (game.phase.value === 'settled') {
        settled.push(snapshotPlayers(game.players))
        game.nextRound()
        continue
      }
      if (game.phase.value === 'lobby') break
      await vi.advanceTimersByTimeAsync(1000)
    }
    await startPromise

    const match = recorder.finishAuto(game.standings.value.map((entry) => ({
      seat: entry.playerIndex,
      name: entry.name,
      score: entry.score,
      rank: entry.rank,
    })))!
    expect(match).not.toBeNull()
    expect(match.rulesetId).toBe('lotus-legacy')
    expect(match.rulesetName).toBe('莲花麻将')
    expect(match.themeName).toBe('rosewood')
    expect(match.status).toBe('finished')
    expect(match.myRank).toBeGreaterThanOrEqual(1)
    expect(match.roundCount).toBe(settled.length)
    expect(saved.matches).toHaveLength(1)
    expect(saved.rounds).toHaveLength(settled.length)

    const rounds = recorder.snapshot().rounds
    expect(rounds.length).toBeGreaterThanOrEqual(4)
    expect(rounds.map((round) => round.roundLabel)).toContain('东1局')
    expect(rounds[rounds.length - 1].roundLabel).toBe('东4局')

    rounds.forEach((round, index) => {
      // ── 翻精信息（莲花麻将特有）──
      expect(round.flipTile, `第 ${index + 1} 局缺少翻精指示牌`).not.toBeNull()
      expect(round.jokerTiles.length, `第 ${index + 1} 局缺少精牌`).toBeGreaterThanOrEqual(1)
      expect(round.flipStack).not.toBeNull()
      expect(round.wallBreakIndex).toBeGreaterThanOrEqual(0)
      expect(round.dice.first).toHaveLength(2)
      expect(round.dice.second).toHaveLength(2)
      expect([...round.dice.first!, ...round.dice.second!].every((value) => value >= 1 && value <= 6)).toBe(true)

      // ── 终态与引擎真实状态一致 ──
      const engine = settled[index]
      const final = round.final
      expect(final, `第 ${index + 1} 局没有结算快照`).not.toBeNull()
      final!.scores.forEach((score, seat) => {
        expect(score, `第 ${index + 1} 局座位 ${seat} 分数`).toBe(engine[seat].score)
      })
      final!.hands.forEach((hand, seat) => {
        expect([...hand].sort(), `第 ${index + 1} 局座位 ${seat} 手牌`).toEqual(engine[seat].hand)
      })
      final!.melds.forEach((melds, seat) => {
        expect(
          melds.map((meld) => `${meld.type}:${[...meld.tiles].sort().join(',')}`).sort(),
          `第 ${index + 1} 局座位 ${seat} 副露`,
        ).toEqual(engine[seat].melds)
      })
      expect(round.steps.length, `第 ${index + 1} 局事件数`).toBeGreaterThan(0)
      expect(firstUncloneable(round), `第 ${index + 1} 局该字段不可结构化克隆`).toBeNull()
    })
    // 天胡/地胡会造成极短的局；要求至少有一局拥有完整事件流
    expect(Math.max(...rounds.map((round) => round.steps.length))).toBeGreaterThan(20)

    // ── 任意一帧牌数守恒 134（局末帧不做断言：和牌张/马牌进入展示区）──
    const frames = rounds.flatMap((round) => buildReplayFrames(match, round, { revealAll: true }))
    expect(frames.length).toBeGreaterThan(rounds.length * 10)
    for (const frame of frames) {
      if (frame.settled) continue
      expect(tileTotal(frame), `帧 ${frame.index}（${frame.roundLabel}）牌数守恒`).toBe(LOTUS_TILES)
    }
    // 开局帧带翻精与精牌信息，供回放还原牌山与牌面标记
    const first = buildReplayFrames(match, rounds[0], { revealAll: true })[0]
    expect(first.table.flipTile).toBe(rounds[0].flipTile)
    expect(first.table.jokerTiles).toEqual(rounds[0].jokerTiles)
    expect(first.table.wallBreakIndex).toBe(rounds[0].wallBreakIndex)
    expect(first.table.flipStack).toBe(rounds[0].flipStack ?? undefined)
  }, 180_000)

  it('中途退出：保留已打完的局并标未完成', async () => {
    stubWindow()
    const { recorder } = createHarness()
    const game = useLotusGame({
      playSound: () => {},
      playSoundAndWait: async () => {},
      recorder: recorder.hooks,
    })
    const startPromise = game.startGame('east')
    let guard = 0
    while (guard < 4000) {
      guard += 1
      if (game.matchFinished.value || game.phase.value === 'finished') break
      if (game.phase.value === 'settled') { game.returnToLobby(); break }
      if (game.phase.value === 'lobby') break
      await vi.advanceTimersByTimeAsync(1000)
    }
    await startPromise

    const match = recorder.finishAuto()!
    expect(match.status).toBe('aborted')
    expect(match.roundCount).toBe(1)
    expect(match.myRank).toBeGreaterThanOrEqual(1)
    const [round] = recorder.snapshot().rounds
    if (!round) throw new Error('首局未被记录')
    expect(round.final).not.toBeNull()
    expect(buildReplayFrames(match, round, { revealAll: false })[0].table.revealHands).toBe(false)
    expect(buildReplayFrames(match, round, { revealAll: true })[0].table.revealHands).toBe(true)
  }, 180_000)
})
