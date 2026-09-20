import { describe, expect, it } from 'vitest'
import { setBotCommandObserver } from '../../variants/lotus/bloodFlow/network/backends'
import { createDirectAuthorityBackend } from '../../variants/lotus/bloodFlow/network/backends'
import { replayReproduction, type ReproductionCommand } from './replayReproduction'
import { openingFromReproduction } from './openingFromReproduction'
import type { AnalysisReproduction } from './types'
import { SEATS, type BloodFlowOpeningState } from '../../variants/lotus/bloodFlow/state'
import type { GamePlayer, Meld, TileType } from '../../core/contracts/types'
import { createWall, tileName } from '../../core/rules/tiles'

// §10.6 的充分条件，用在**权威机器人代决**的对局上：
// 机器人由权威侧就地决定（选择不回传主线程），此前分析记录只能落 auto 标记、无法复现。
// 有了 BotCommandObserver，就能把权威真实提交的命令记下来，从而让这种对局也可复现。

function buildOpening(): BloodFlowOpeningState {
  const pool = createWall()
  const remove = (tile: TileType) => { const index = pool.indexOf(tile); if (index >= 0) pool.splice(index, 1) }
  const flipTiles: [TileType, TileType] = ['p9', 'white']
  flipTiles.forEach(remove)
  const players = SEATS.map((seat): GamePlayer => ({
    seat, name: `P${seat}`, avatar: '', score: 2000,
    hand: pool.splice(0, seat === 0 ? 14 : 13),
    melds: [] as Meld[], discards: [], redCount: 0, drawnTileIndex: -1,
  }))
  return {
    players, wall: pool, flipTiles, jokers: ['red', 'green'],
    headDrawn: 134 - pool.length, dealerDrawnIndex: players[0].hand.length - 1,
    flipStack: 0, flipSeat: 0, wallBreakIndex: 2,
  }
}

function asRecord(opening: BloodFlowOpeningState): AnalysisReproduction {
  return {
    roundIndex: 1, available: true,
    initialWall: opening.wall.map(tile => tileName(tile)),
    initialHands: opening.players.map(player => player.hand.map(tile => tileName(tile))),
    dealer: 0,
    dealerDrawnIndex: opening.dealerDrawnIndex,
    flipTiles: opening.flipTiles.map(tile => tileName(tile)),
    jokers: opening.jokers.map(tile => tileName(tile)),
    flipStack: opening.flipStack, flipSeat: opening.flipSeat, wallBreakIndex: opening.wallBreakIndex,
    openingScores: opening.players.map(player => player.score),
  }
}

describe('权威机器人代决的对局也能复现（§10.6）', () => {
  it('用 BotCommandObserver 记录机器人命令后，重跑能与结束分数一致', async () => {
    const opening = buildOpening()
    const record = asRecord(opening)
    const commands: ReproductionCommand[] = []
    // 记录权威实际提交的机器人命令（含载荷），并保持提交顺序
    setBotCommandObserver((seat, action, windowId) => {
      const payload = action as { kind: string; tile?: TileType; index?: number; from?: number | null; meldIndex?: number }
      void windowId
      commands.push({
        seat, kind: payload.kind,
        ...(payload.tile !== undefined ? { tile: tileName(payload.tile) } : {}),
        ...(payload.index !== undefined ? { handIndex: payload.index } : {}),
        ...(payload.from !== undefined ? { from: payload.from } : {}),
        ...(payload.meldIndex !== undefined ? { meldIndex: payload.meldIndex } : {}),
      })
    })

    try {
      // 时钟必须可推进：窗口截止时间在"未来"，now 恒为 0 的话 expire 永远不会生效
      let clock = 0
      const backend = createDirectAuthorityBackend(() => clock, { winBeatMs: 0 })
      await backend.start({ authorityEpoch: 'test', roundId: 'round-1', opening: structuredClone(opening) } as never)
      // 全程交给权威机器人：每次都是"当前窗口的机器人决定"，直到本局结束
      for (let step = 0; step < 5_000; step += 1) {
        const engine = backend.engine
        if (engine.result) break
        const window = engine.window
        if (!window) break
        const seat = SEATS.find(candidate => window.options[candidate].length > 0)
        if (seat === undefined) {
          // 没人有合法动作 ⇒ 靠超时推进：如实记一条 expire（否则重跑会分叉）
          if (engine.window) {
            commands.push({ seat: 0, kind: 'expire', resolution: 'expire' })
            clock = engine.window.deadlineAt + 1
            engine.expire(clock, engine.window.id)
          }
          continue
        }
        const before = engine.window?.id
        await backend.bot(seat, window.id)
        // 机器人可能不提交（例如它选择过）⇒ 同样记 expire 再推进（真实流程里由主线程的计时器做）
        if (engine.window && engine.window.id === before) {
          commands.push({ seat, kind: 'expire', resolution: 'expire' })
          clock = engine.window.deadlineAt + 1
          engine.expire(clock, engine.window.id)
        }
      }
      const scores = backend.engine.players.map(player => player.score)
      expect(commands.length, '机器人命令应被记录下来').toBeGreaterThan(0)
      expect(backend.engine.result, '本局应打完').toBeTruthy()

      const verified = replayReproduction({ reproduction: record, commands, expectedScores: scores })
      expect(verified.reason, `重跑应成功：${verified.reason}`).toBeNull()
      expect(verified.ok).toBe(true)
      expect(verified.scoresMatch).toBe(true)
      expect(verified.submitted).toBe(commands.length)
    } finally {
      setBotCommandObserver(null)
    }
  })
})
