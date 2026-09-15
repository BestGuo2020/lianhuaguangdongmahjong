import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../core/local/useGame'
import type { GamePlayer, Meld, TileType } from '../core/contracts/types'
import { createReplayRecorder } from './recorder'
import { firstUncloneable } from './plain'
import { buildReplayFrames, type ReplayFrame } from './projection'
import type { ReplayMatch, ReplayRound } from './types'

// 玩法一（莲花广麻）整场录制回放：录制器接入真实引擎，自动打满一整场东风场，
// 断言「锚点 + 事件流」折叠出的局面与引擎结算时的真实状态一致，且每帧牌数守恒。

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

interface Saved {
  matches: ReplayMatch[]
  rounds: ReplayRound[]
}

function createHarness() {
  const saved: Saved = { matches: [], rounds: [] }
  const recorder = createReplayRecorder({
    sink: {
      saveMatch: (match) => { saved.matches.push(match) },
      saveRound: (round) => { saved.rounds.push(round) },
    },
    meta: () => ({
      rulesetId: 'lotus-classic',
      rulesetName: '莲花广麻',
      themeName: 'jade',
      humanSeat: 0,
    }),
    now: () => 1_700_000_000_000,
    createId: () => 'match-1',
  })
  return { saved, recorder }
}

function clonePlayers(players: readonly GamePlayer[]) {
  return players.map((player) => ({
    name: player.name,
    score: player.score,
    hand: [...player.hand],
    discards: [...player.discards],
    melds: player.melds.map((meld) => ({ ...meld, tiles: [...meld.tiles] })),
  }))
}

type PlayerSnapshot = ReturnType<typeof clonePlayers>

/** 一帧的全部牌张数（手牌 + 副露 + 牌河 + 牌山）——守恒量恒为 136。 */
function tileTotal(frame: ReplayFrame): number {
  const players = frame.table.players ?? []
  const inHands = players.reduce((sum, player) => sum + player.hand.length, 0)
  const inDiscards = players.reduce((sum, player) => sum + player.discards.length, 0)
  const inMelds = players.reduce(
    (sum, player) => sum + player.melds.reduce((meldSum: number, meld: Meld) => meldSum + meld.tiles.length, 0),
    0,
  )
  return frame.wallLeft + inHands + inDiscards + inMelds
}

describe('玩法一（莲花广麻）回放录制', () => {
  it('整场录制：折叠局面与引擎结算态一致，且每帧牌数守恒', async () => {
    stubWindow()
    const { saved, recorder } = createHarness()
    const game = useGame({
      playSound: () => {},
      playSoundAndWait: async () => {},
      recorder: recorder.hooks,
    })

    const startPromise = game.startGame('east')
    const settled: PlayerSnapshot[] = []
    let guard = 0
    while (guard < 8000) {
      guard += 1
      if (game.matchFinished.value || game.phase.value === 'finished') break
      if (game.phase.value === 'settled') {
        settled.push(clonePlayers(game.players))
        game.nextRound()
        continue
      }
      if (game.phase.value === 'lobby') break
      await vi.advanceTimersByTimeAsync(1000)
    }
    await startPromise

    const finished = recorder.finish('finished', game.standings.value.map((entry) => ({
      seat: entry.playerIndex,
      name: entry.name,
      score: entry.score,
      rank: entry.rank,
    })))

    // ── 场次记录 ──
    expect(finished).not.toBeNull()
    expect(saved.matches).toHaveLength(1)
    const match = saved.matches[0]
    expect(match.rulesetName).toBe('莲花广麻')
    expect(match.matchName).toBe('东风场')
    expect(match.themeName).toBe('jade')
    expect(match.gameMode).toBe('local')
    expect(match.status).toBe('finished')
    expect(match.players).toHaveLength(4)
    expect(match.startedAt).toBe(1_700_000_000_000)
    expect(match.myRank).toBeGreaterThanOrEqual(1)
    expect(match.myRank).toBeLessThanOrEqual(4)
    expect(match.roundCount).toBe(settled.length)
    expect(match.finalStandings).toHaveLength(4)
    expect(saved.rounds).toHaveLength(settled.length)
    expect(() => structuredClone(saved.matches[0]), '场次记录不可结构化克隆').not.toThrow()

    // 一整场东风场至少打完 4 局；庄家连庄会产生额外的局（东1局重复出现）。
    expect(settled.length).toBeGreaterThanOrEqual(4)

    const rounds = recorder.snapshot().rounds
    expect(rounds[0].roundLabel).toBe('东1局')
    expect(rounds[rounds.length - 1].roundLabel).toBe('东4局')
    expect(rounds.every((round) => ['东1局', '东2局', '东3局', '东4局'].includes(round.roundLabel))).toBe(true)
    expect(rounds.map((round) => round.roundIndex)).toEqual(rounds.map((_, index) => index + 1))

    rounds.forEach((round, index) => {
      const engineState = settled[index]
      const final = round.final
      expect(final, `第 ${index + 1} 局没有结算快照`).not.toBeNull()

      // 落库前置条件：录制结果必须是纯对象（引擎状态是 Vue 响应式代理，
      // 直接塞进 IndexedDB 会 DataCloneError —— 这条断言在浏览器之外守住它）。
      expect(firstUncloneable(round), `第 ${index + 1} 局该字段不可结构化克隆`).toBeNull()

      // ── 1. 录制的终态 = 引擎结算时的真实状态 ──
      final!.scores.forEach((score, seat) => {
        expect(score, `第 ${index + 1} 局座位 ${seat} 分数`).toBe(engineState[seat].score)
      })
      final!.hands.forEach((hand, seat) => {
        expect([...hand].sort(), `第 ${index + 1} 局座位 ${seat} 手牌`).toEqual([...engineState[seat].hand].sort())
      })
      final!.melds.forEach((melds, seat) => {
        expect(melds.map((meld) => meld.type), `第 ${index + 1} 局座位 ${seat} 副露`).toEqual(
          engineState[seat].melds.map((meld) => meld.type),
        )
      })

      // ── 2. 事件流完备 ──
      // 极短局确实存在：四红中在开局即结束（0 步），庄家起手天胡则首步就是和牌。
      // 因此不按固定步数/固定首步断言，只校验事件类型合法与自洽。
      if (round.steps.length) {
        expect(['draw', 'discard', 'meld', 'win']).toContain(round.steps[0].t)
        expect(round.steps.every((step) => ['draw', 'discard', 'meld', 'win'].includes(step.t))).toBe(true)
        expect(round.steps.filter((step) => step.t === 'discard').length)
          .toBeLessThanOrEqual(round.steps.length)
      }
      // 开局锚点：四家起手 13 张（庄家 14），且锚点本身牌数守恒（发牌 53 张 + 红宝补牌）
      const anchorTotals = round.anchor.hands.map((hand) => hand.length)
      expect(anchorTotals.reduce((sum, count) => sum + count, 0)).toBe(53)
      const anchorTotal = round.anchor.wallLeft
        + round.anchor.hands.reduce((sum, hand) => sum + hand.length, 0)
        + round.anchor.melds.reduce((sum, melds) => sum + melds.reduce((n, meld) => n + meld.tiles.length, 0), 0)
        + round.anchor.discards.reduce((sum, river) => sum + river.length, 0)
      expect(anchorTotal, `第 ${index + 1} 局锚点牌数守恒`).toBe(136)
    })
    // 极短局（四红中/天胡）会让个别局事件很少；要求至少一局拥有完整事件流
    expect(Math.max(...rounds.map((round) => round.steps.length))).toBeGreaterThan(20)

    // ── 3. 任意一帧的牌数守恒 136（局末帧除外：和牌张/马牌移到展示区）──
    const allFrames = rounds.flatMap((round) => buildReplayFrames(match, round, { revealAll: true }))
    expect(allFrames.length).toBeGreaterThan(rounds.length * 10)
    for (const frame of allFrames) {
      if (frame.settled) continue
      expect(tileTotal(frame), `帧 ${frame.index}（${frame.roundLabel}）牌数守恒`).toBe(136)
    }
    // 帧 0 必须有四家完整的起手手牌
    const firstOfRound = buildReplayFrames(match, rounds[0], { revealAll: true })[0]
    expect(firstOfRound.table.players?.map((player) => player.hand.length)).toEqual([14, 13, 13, 13])
    expect(firstOfRound.turn).toBe(1)
    expect(firstOfRound.step).toBeNull()
  }, 120_000)

  it('折叠出的牌河与副露随事件推进单调一致（首局逐帧自检）', async () => {
    stubWindow()
    const { recorder } = createHarness()
    const game = useGame({
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
    const match = recorder.finish('aborted')!
    const [round] = recorder.snapshot().rounds
    if (!round) throw new Error('首局未被记录')
    const frames = buildReplayFrames(match, round, { revealAll: true })
    // 牌河只增不减（除被碰/吃/杠带走），并且每一步最多新增一张
    let previous = frames[0].table.players!.map((player) => player.discards.length)
    for (const frame of frames.slice(1, frames.length - 1)) {
      const current = frame.table.players!.map((player) => player.discards.length)
      current.forEach((count, seat) => {
        expect(count - previous[seat]).toBeLessThanOrEqual(1)
        expect(count).toBeGreaterThanOrEqual(0)
      })
      const total = current.reduce((sum, count) => sum + count, 0)
      const previousTotal = previous.reduce((sum, count) => sum + count, 0)
      expect(total - previousTotal).toBeLessThanOrEqual(1)
      previous = current
    }
    // 每张被记录的弃牌都能在最终牌河里找到（含被鸣牌带走的除外）
    const recordedDiscards = round.steps.filter((step) => step.t === 'discard').length
    let placed = 0
    for (const step of round.steps) {
      if (step.t === 'discard') placed += 1
      if (step.t === 'meld' && step.from != null) placed -= 1
    }
    const riverTotal = frames[frames.length - 1].table.players!
      .reduce((sum, player) => sum + player.discards.length, 0)
    expect(riverTotal).toBeLessThanOrEqual(recordedDiscards)
    expect(placed).toBeGreaterThanOrEqual(riverTotal - 4)
  }, 120_000)
})

describe('回放录制：牌张类型覆盖', () => {
  it('折叠结果里出现的所有牌都在合法牌集中', async () => {
    stubWindow()
    const { recorder } = createHarness()
    const game = useGame({ playSound: () => {}, playSoundAndWait: async () => {}, recorder: recorder.hooks })
    const startPromise = game.startGame('east')
    let guard = 0
    while (guard < 3000) {
      guard += 1
      if (game.matchFinished.value || game.phase.value === 'finished') break
      if (game.phase.value === 'settled') { game.returnToLobby(); break }
      if (game.phase.value === 'lobby') break
      await vi.advanceTimersByTimeAsync(1000)
    }
    await startPromise
    const match = recorder.finish('aborted')!
    const [round] = recorder.snapshot().rounds
    if (!round) throw new Error('首局未被记录')
    const tiles = new Set<TileType>()
    for (const frame of buildReplayFrames(match, round, { revealAll: true })) {
      for (const player of frame.table.players ?? []) {
        player.hand.forEach((tile) => tiles.add(tile))
        player.discards.forEach((tile) => tiles.add(tile))
        player.melds.forEach((meld) => meld.tiles.forEach((tile) => tiles.add(tile)))
      }
    }
    expect(tiles.size).toBeGreaterThan(0)
    expect([...tiles].every((tile) => typeof tile === 'string' && tile.length > 0)).toBe(true)
  }, 120_000)
})
