import { describe, expect, it, vi } from 'vitest'
import { createMemoryDriver, type ReplayStoreDriver } from './idb'
import { createReplayStorage } from './storage'
import type { ReplayMatch, ReplayRound } from './types'

function makeMatch(id: string, startedAt: number): ReplayMatch {
  return {
    id,
    schemaVersion: 1,
    rulesetId: 'lotus-classic',
    rulesetName: '莲花广麻',
    matchType: 'east',
    matchName: '东风场',
    gameMode: 'local',
    themeName: 'jade',
    players: [{ seat: 0, name: '本家', avatar: '', startScore: 1000 }],
    humanSeat: 0,
    startedAt,
    endedAt: startedAt + 1000,
    status: 'finished',
    roundCount: 1,
    myRank: 1,
    myScore: 1200,
    summary: '东1局 本家自摸',
  }
}

function makeRound(matchId: string, roundIndex: number): ReplayRound {
  return {
    id: `${matchId}:${roundIndex}`,
    matchId,
    roundIndex,
    round: roundIndex,
    roundLabel: `东${roundIndex}局`,
    dealer: 0,
    honba: 0,
    matchType: 'east',
    dice: { second: [1, 2] },
    diceThrowerIndex: 0,
    flipTile: null,
    jokerTiles: ['white'],
    wildcardTiles: [],
    wallBreakIndex: 0,
    flipStack: null,
    scoresBefore: [1000, 1000, 1000, 1000],
    anchor: {
      hands: [[], [], [], []],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
      drawnTileIndex: [-1, -1, -1, -1],
      redCount: [0, 0, 0, 0],
      scores: [1000, 1000, 1000, 1000],
      wallLeft: 83,
      headDrawn: 0,
      currentPlayer: 0,
    },
    steps: [],
    final: null,
    landedAt: 1,
  }
}

describe('回放存储（内存驱动）', () => {
  it('场次与局按需读写', async () => {
    const storage = createReplayStorage({ driver: createMemoryDriver() })
    expect(storage.available).toBe(true)

    await storage.saveMatch(makeMatch('a', 100))
    await storage.saveRound(makeRound('a', 1))
    await storage.saveRound(makeRound('a', 2))

    const list = await storage.list()
    expect(list.map((match) => match.id)).toEqual(['a'])
    expect(list[0].myRank).toBe(1)

    const rounds = await storage.loadRounds('a')
    expect(rounds.map((round) => round.roundIndex)).toEqual([1, 2])
    expect(await storage.loadMatch('a')).not.toBeNull()
    expect(await storage.loadMatch('missing')).toBeNull()
  })

  it('列表按开始时间倒序（最新在前）', async () => {
    const storage = createReplayStorage({ driver: createMemoryDriver() })
    await storage.saveMatch(makeMatch('old', 100))
    await storage.saveMatch(makeMatch('new', 900))
    await storage.saveMatch(makeMatch('mid', 500))
    expect((await storage.list()).map((match) => match.id)).toEqual(['new', 'mid', 'old'])
  })

  it('超出上限时淘汰最旧的场次（连同其牌谱）', async () => {
    const driver = createMemoryDriver()
    const storage = createReplayStorage({ driver, maxMatches: 2 })
    for (const [id, startedAt] of [['m1', 100], ['m2', 200], ['m3', 300]] as const) {
      await storage.saveMatch(makeMatch(id, startedAt))
      await storage.saveRound(makeRound(id, 1))
    }
    const list = await storage.list()
    expect(list.map((match) => match.id)).toEqual(['m3', 'm2'])
    expect(await storage.loadRounds('m1')).toEqual([])
    expect(await storage.loadRounds('m2')).toHaveLength(1)
  })

  it('调整保留上限后立即淘汰超出的最旧场次', async () => {
    const storage = createReplayStorage({ driver: createMemoryDriver(), maxMatches: 3 })
    expect(storage.maxMatches).toBe(3)
    for (const [id, startedAt] of [['a', 100], ['b', 200], ['c', 300], ['d', 400]] as const) {
      await storage.saveMatch(makeMatch(id, startedAt))
    }
    expect((await storage.list()).map((match) => match.id)).toEqual(['d', 'c', 'b'])

    await storage.setMaxMatches(2)
    expect(storage.maxMatches).toBe(2)
    expect((await storage.list()).map((match) => match.id)).toEqual(['d', 'c'])

    // 非法上限收敛为至少 1 场，不会把库清空
    await storage.setMaxMatches(0)
    expect(storage.maxMatches).toBe(1)
    expect((await storage.list()).map((match) => match.id)).toEqual(['d'])
  })

  it('删除单场与清空', async () => {
    const storage = createReplayStorage({ driver: createMemoryDriver() })
    await storage.saveMatch(makeMatch('a', 100))
    await storage.saveRound(makeRound('a', 1))
    await storage.remove('a')
    expect(await storage.list()).toEqual([])
    expect(await storage.loadRounds('a')).toEqual([])

    await storage.saveMatch(makeMatch('b', 100))
    await storage.clearAll()
    expect(await storage.list()).toEqual([])
  })
})

describe('回放存储降级', () => {
  it('无 IndexedDB 时不可用且所有操作安全空转', async () => {
    const storage = createReplayStorage({ driver: null })
    expect(storage.available).toBe(false)
    await expect(storage.saveMatch(makeMatch('a', 1))).resolves.toBeUndefined()
    await expect(storage.saveRound(makeRound('a', 1))).resolves.toBeUndefined()
    expect(await storage.list()).toEqual([])
    expect(await storage.loadRounds('a')).toEqual([])
    expect(await storage.loadMatch('a')).toBeNull()
    await expect(storage.remove('a')).resolves.toBeUndefined()
    await expect(storage.clearAll()).resolves.toBeUndefined()
    await expect(storage.trim()).resolves.toBeUndefined()
  })

  it('写入失败（配额满/隐私模式）后静默降级，不向对局抛错', async () => {
    const failing: ReplayStoreDriver = {
      putMatch: () => Promise.reject(new Error('QuotaExceededError')),
      putRound: () => Promise.reject(new Error('QuotaExceededError')),
      getMatch: () => Promise.reject(new Error('QuotaExceededError')),
      listMatches: () => Promise.reject(new Error('QuotaExceededError')),
      listRounds: () => Promise.reject(new Error('QuotaExceededError')),
      countMatches: () => Promise.reject(new Error('QuotaExceededError')),
      deleteMatch: () => Promise.reject(new Error('QuotaExceededError')),
      clearAll: () => Promise.reject(new Error('QuotaExceededError')),
      close: () => {},
    }
    const onError = vi.fn()
    const storage = createReplayStorage({ driver: failing, onError })
    await expect(storage.saveMatch(makeMatch('a', 1))).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    // 失败后不再重试，也不再对外报"可用"
    expect(storage.available).toBe(false)
    await expect(storage.saveRound(makeRound('a', 1))).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
