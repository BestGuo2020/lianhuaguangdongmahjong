import { describe, expect, it } from 'vitest'
import {
  REPLAY_ACK_KIND,
  REPLAY_MANIFEST_KIND,
  REPLAY_REQUEST_KIND,
  REPLAY_SLICE_KIND,
  adaptReplayToSeat,
  analysisManifestId,
  createRemoteReplayHost,
  createRemoteReplayPeer,
} from './remoteRelay'
import { encodeReplayPayload, sliceForManifest } from './transfer'
import type { ReplayMatch, ReplayRound, ReplayStep } from './types'

// 联机牌谱中继：房主广播 → 客机收片校验落库；这里用"丢包开关"把两端在进程内跑通，
// 覆盖 AGENTS.md 记录过的线上缺陷（分片在订阅者处被静默丢弃）以及清单丢失的自愈路径。

function step(index: number): ReplayStep {
  const tiles = ['m5', 'p2', 's9', 'east', 'red', 'white'] as const
  const hand = ['m1', 'm2', 'east'] as const
  return {
    t: index % 2 === 0 ? 'draw' : 'discard',
    seat: index % 4,
    tile: tiles[index % tiles.length],
    wallLeft: 70 - index,
    headDrawn: index,
    currentPlayer: index % 4,
    state: { hand: [...hand], melds: [], drawnTileIndex: -1, redCount: 0, discards: ['p1', 'red'] },
  }
}

function makeRound(roundIndex: number, label: string): ReplayRound {
  return {
    id: `remote-match:${roundIndex}`,
    matchId: 'remote-match',
    roundIndex,
    round: roundIndex,
    roundLabel: label,
    dealer: 0,
    honba: 0,
    matchType: 'east',
    dice: { second: [3, 4] },
    diceThrowerIndex: 0,
    flipTile: 'p9',
    jokerTiles: ['p9', 'white'],
    wildcardTiles: ['white'],
    wallBreakIndex: 12,
    flipStack: 7,
    scoresBefore: [1000, 1000, 1000, 1000],
    anchor: {
      hands: [['m1'], ['m2'], ['m3'], ['m4']],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
      drawnTileIndex: [-1, -1, -1, -1],
      redCount: [0, 0, 0, 0],
      scores: [1000, 1000, 1000, 1000],
      wallLeft: 70,
      headDrawn: 1,
      currentPlayer: 0,
    },
    steps: Array.from({ length: 60 }, (_, index) => step(index)),
    final: null,
    landedAt: 0,
  }
}

function makeMatch(roundCount: number): ReplayMatch {
  return {
    id: 'remote-match',
    schemaVersion: 1,
    rulesetId: 'lotus-legacy',
    rulesetName: '莲花麻将',
    matchType: 'east',
    matchName: '东风场',
    gameMode: 'remote',
    themeName: 'rosewood',
    players: [
      { seat: 0, name: '房主', avatar: '', startScore: 2000 },
      { seat: 1, name: '甲', avatar: '', startScore: 2000 },
      { seat: 2, name: '乙', avatar: '', startScore: 2000 },
      { seat: 3, name: '丙', avatar: '', startScore: 2000 },
    ],
    humanSeat: 0,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_600_000,
    status: 'finished',
    roundCount,
    myRank: 1,
    myScore: 3500,
    finalStandings: [
      { seat: 0, name: '房主', score: 3500, rank: 1 },
      { seat: 1, name: '甲', score: 2400, rank: 2 },
      { seat: 2, name: '乙', score: 1600, rank: 3 },
      { seat: 3, name: '丙', score: 500, rank: 4 },
    ],
    summary: '东4局 房主自摸（本家）',
  }
}

interface BusMessage { from: 'host' | 'peer'; message: Record<string, unknown> }

/** 进程内通道：drop 返回 true 表示这条消息被"静默丢弃"（可只丢第一次）。 */
function createRelayHarness(options: { drop?: (message: Record<string, unknown>, index: number) => boolean } = {}) {
  const messages: BusMessage[] = []
  const timers: Array<() => void> = []
  const hostRounds = new Map<string, ReplayRound[]>()
  const hostMatch = new Map<string, ReplayMatch>()
  const peerRounds = new Map<string, ReplayRound[]>()
  const peerMatch = new Map<string, ReplayMatch>()
  const rejected: string[] = []
  const gaveUp: string[] = []
  const analysis: Array<{ matchId: string; roundIndex: number | null; payload: unknown }> = []
  let dropped = 0
  let sent = 0

  const bus = (from: BusMessage['from']) => (message: object) => {
    if (options.drop?.(message as Record<string, unknown>, sent)) {
      dropped += 1
      sent += 1
      return
    }
    sent += 1
    messages.push({ from, message: JSON.parse(JSON.stringify(message)) as Record<string, unknown> })
  }

  const host = createRemoteReplayHost({
    send: bus('host'),
    loadRounds: async (matchId) => hostRounds.get(matchId) ?? [],
    loadMatch: async (matchId) => hostMatch.get(matchId) ?? null,
    // 小片长：保证测试里确实是多片场景（大牌谱压缩后可能只剩一片）
    sliceChars: 200,
    onGiveUp: (id, detail) => gaveUp.push(`${id}: ${detail}`),
  })

  // 模拟 IndexedDB 的 keyPath 语义：同 id 覆盖写入（重复投递天然幂等）
  const putRound = (store: Map<string, ReplayRound[]>, round: ReplayRound) => {
    const list = store.get(round.matchId) ?? []
    const next = list.filter((item) => item.roundIndex !== round.roundIndex)
    next.push(round)
    store.set(round.matchId, next.sort((a, b) => a.roundIndex - b.roundIndex))
  }

  const peer = createRemoteReplayPeer({
    send: bus('peer'),
    saveRound: (round) => { putRound(peerRounds, round) },
    saveMatch: (match) => { peerMatch.set(match.id, match) },
    loadRounds: async (matchId) => peerRounds.get(matchId) ?? [],
    loadMatch: async (matchId) => peerMatch.get(matchId) ?? null,
    getMySeat: () => 2,
    later: (callback) => { timers.push(callback) },
    onRejected: (detail) => rejected.push(detail),
    // §6 分析复现数据：不进回放库，直接交给宿主（这里只登记，校验由 analysis 侧负责）
    onAnalysisPayload: (detail) => analysis.push(detail),
  })

  /** 把队列跑空，并驱动一次客机的定时回执（有界，避免死循环）。 */
  async function pump(maxSteps = 400) {
    for (let step = 0; step < maxSteps; step += 1) {
      while (messages.length) {
        const next = messages.shift()!
        if (next.from === 'host') await peer.handle(next.message)
        else if (next.message.kind === REPLAY_ACK_KIND) await host.handleAck(next.message.ack as never)
        else if (next.message.kind === REPLAY_REQUEST_KIND) await host.handleRequest(next.message as never)
      }
      const due = timers.splice(0)
      if (!due.length) return
      for (const callback of due) callback()
    }
  }

  return {
    host, peer, pump, messages, timers, hostRounds, hostMatch, peerRounds, peerMatch, rejected, gaveUp, analysis,
    get dropped() { return dropped },
    get sent() { return sent },
  }
}

async function publishMatch(harness: ReturnType<typeof createRelayHarness>, roundCount = 2) {
  const match = makeMatch(roundCount)
  harness.hostMatch.set(match.id, match)
  const rounds: ReplayRound[] = []
  for (let index = 1; index <= roundCount; index += 1) {
    const round = makeRound(index, `东${index}局`)
    rounds.push(round)
    harness.hostRounds.set(match.id, [...rounds])
    await harness.host.broadcastRound(round)
  }
  await harness.host.broadcastMatch(match)
  return { match, rounds }
}

describe('联机牌谱中继：房主广播 → 客机落库', () => {
  it('无丢包：客机收到全部局与场次，房主清空待回执', async () => {
    const harness = createRelayHarness()
    const { rounds } = await publishMatch(harness, 2)
    await harness.pump()

    expect(harness.peerRounds.get('remote-match')).toHaveLength(2)
    expect(harness.peerMatch.get('remote-match')!.humanSeat).toBe(2)
    expect(harness.host.pending()).toBe(0)
    expect(harness.rejected).toEqual([])
    expect(harness.gaveUp).toEqual([])

    // 客机（座位 2）拿到的是按自己座位重排后、位次按自己算的记录
    const match = harness.peerMatch.get('remote-match')!
    expect(match.humanSeat).toBe(2)
    expect(match.myRank).toBe(3)
    expect(match.myScore).toBe(1600)
    expect(match.gameMode).toBe('remote')
    // 牌谱内容与房主一致（全知：四家锚点手牌都在）
    expect(harness.peerRounds.get('remote-match')![0].anchor.hands).toEqual(rounds[0].anchor.hands)
    expect(harness.peerRounds.get('remote-match')![0].jokerTiles).toEqual(rounds[0].jokerTiles)
  })

  it('丢一片：客机回执只报缺失片，房主只补那一片即可恢复', async () => {
    let droppedOnce = false
    const harness = createRelayHarness({
      drop: (message, index) => {
        // 丢掉第 1 局清单之后的第 1 片（模拟订阅者处被静默丢弃），只丢一次
        if (!droppedOnce && message.kind === REPLAY_SLICE_KIND && (message.slice as { index: number }).index === 1) {
          droppedOnce = true
          return index > 0
        }
        return false
      },
    })
    const { rounds } = await publishMatch(harness, 1)
    expect(rounds).toHaveLength(1)
    await harness.pump()

    expect(harness.dropped).toBe(1)
    // 重试协议允许重复投递；落库按 id 覆盖，结果只应有一局且内容完整
    const stored = harness.peerRounds.get('remote-match')!
    expect(stored).toHaveLength(1)
    expect(stored[0].steps).toHaveLength(60)
    expect(harness.peer.saved()).toBeGreaterThanOrEqual(1)
    expect(harness.host.pending()).toBe(0)
    expect(harness.rejected).toEqual([])
  })

  it('清单本身丢了：场次记录到达后按缺失局主动补拉（自愈）', async () => {
    let droppedManifestOnce = false
    const harness = createRelayHarness({
      drop: (message) => {
        if (!droppedManifestOnce && message.kind === REPLAY_MANIFEST_KIND
          && (message.manifest as { roundIndex?: number }).roundIndex === 1) {
          droppedManifestOnce = true
          return true
        }
        return false
      },
    })
    const { match } = await publishMatch(harness, 2)
    await harness.pump()

    // 第 1 局清单丢了，但场次记录里写着应有 2 局 → 客机请求补局 → 房主从本地补播
    expect(harness.peerRounds.get('remote-match')).toHaveLength(2)
    expect(harness.peerRounds.get('remote-match')!.map((round) => round.roundLabel)).toEqual(['东1局', '东2局'])
    expect(harness.peerMatch.get(match.id)?.roundCount).toBe(2)
    expect(harness.host.pending()).toBe(0)
    expect(harness.rejected).toEqual([])
  })

  it('内容被篡改：客机校验失败后请求整份重发，重发干净数据即恢复', async () => {
    let corruptedOnce = false
    const harness = createRelayHarness({
      drop: (message) => {
        if (corruptedOnce || message.kind !== REPLAY_SLICE_KIND) return false
        const slice = message.slice as { index: number; data: string }
        if (slice.index !== 0) return false
        corruptedOnce = true
        slice.data = slice.data.replace(/^./, slice.data[0] === 'A' ? 'B' : 'A')
        return false
      },
    })
    await publishMatch(harness, 1)
    await harness.pump()
    const stored = harness.peerRounds.get('remote-match')!
    expect(stored).toHaveLength(1)
    expect(stored[0].steps).toHaveLength(60)
    expect(harness.rejected).toEqual([])
  })

  it('持续丢包：有上限地放弃，不无限重发', async () => {
    const harness = createRelayHarness({
      drop: (message) => message.kind === REPLAY_SLICE_KIND,
    })
    await publishMatch(harness, 1)
    await harness.pump()

    expect(harness.peer.saved()).toBe(0)
    expect(harness.rejected.join(' | ')).toContain('放弃')
    expect(harness.gaveUp.join(' | ')).toContain('客机回执仍缺')
    expect(harness.host.pending()).toBe(0)
    // 上限内：回执次数不超过重试上限
    expect(harness.sent).toBeLessThan(60)
  })

  it('待回执载荷会过期清理（房主不无限持有内存）', async () => {
    const harness = createRelayHarness({ drop: (message) => message.kind === REPLAY_SLICE_KIND })
    await publishMatch(harness, 1)
    expect(harness.host.pending()).toBeGreaterThan(0)
    harness.host.prune(Date.now() + 200_000)
    expect(harness.host.pending()).toBe(0)
    expect(harness.gaveUp.join(' | ')).toContain('长时间没有收到回执')
  })
})

describe('§6 分析复现数据走同一套中继（清单 + 分片 + 回执）', () => {
  /** 一局的复现载荷：这里给一份体积可观的数据，确保走的是"多片 + 丢片可补"的真实路径。 */
  function payload(roundIndex = 1) {
    return {
      formatVersion: 1,
      matchId: 'remote-match',
      roundIndex,
      authorityEpoch: 'epoch',
      roundId: `epoch/round/${roundIndex}`,
      dealer: 0,
      initialWall: Array.from({ length: 81 }, (_, index) => `m${(index % 9) + 1}`),
      initialHands: [[], [], [], []].map((_, seat) => Array.from({ length: 13 }, (_, index) => `s${((index + seat) % 9) + 1}`)),
      dealerDrawnIndex: 13,
      flipTiles: ['east', 'south'],
      jokers: ['east'],
      flipSeat: 0,
      wallBreakIndex: 14,
      flipStack: 7,
      openingScores: [2000, 2000, 2000, 2000],
      commands: Array.from({ length: 40 }, (_, index) => ({
        seat: index % 4, kind: 'discard', at: index, windowId: `epoch/round/${roundIndex}/window/${index + 1}`,
        windowKind: 'turn', tile: `p${(index % 9) + 1}`, handIndex: index % 13,
      })),
    }
  }

  it('无丢包：客机收全后交给宿主，且**不进回放库**（分析数据与展示牌谱分流）', async () => {
    const harness = createRelayHarness()
    await harness.host.broadcastAnalysis('remote-match', 1, payload(1), 1)
    await harness.pump()

    expect(harness.analysis).toHaveLength(1)
    expect(harness.analysis[0]!.matchId).toBe('remote-match')
    expect(harness.analysis[0]!.roundIndex).toBe(1)
    expect((harness.analysis[0]!.payload as { commands: unknown[] }).commands).toHaveLength(40)
    // 回放库必须干净：分析载荷不能污染展示牌谱
    expect(harness.peerRounds.get('remote-match')).toBeUndefined()
    expect(harness.peerMatch.get('remote-match')).toBeUndefined()
    expect(harness.host.pending()).toBe(0)
  })

  it('丢一片：客机回执只报缺失片，补发后照样收全（且只回调一次）', async () => {
    let droppedOnce = false
    const harness = createRelayHarness({
      drop: (message, index) => {
        if (droppedOnce || message.kind !== REPLAY_SLICE_KIND) return false
        if ((message.slice as { index: number }).index !== 1) return false
        droppedOnce = true
        return index > 0
      },
    })
    await harness.host.broadcastAnalysis('remote-match', 1, payload(1), 1)
    await harness.pump()

    expect(harness.dropped).toBe(1)
    expect(harness.analysis).toHaveLength(1)
    expect(harness.rejected).toEqual([])
    expect(harness.gaveUp).toEqual([])
  })

  it('没接分析回调（本机没开分析）也要回执收全，免得房主一直补发', async () => {
    // 客机侧未注册 onAnalysisPayload：收全后仍必须回执（空缺失列表），否则房主会一直等回执重发
    const encoded = await encodeReplayPayload('analysis', payload(3), {
      id: analysisManifestId('remote-match', 3), matchId: 'remote-match', roundIndex: 3,
    }, { schemaVersion: 1 })
    const sent: Array<Record<string, unknown>> = []
    const timers: Array<() => void> = []
    const bare = createRemoteReplayPeer({
      send: (message) => { sent.push(message as Record<string, unknown>) },
      saveRound: () => {}, saveMatch: () => {},
      loadRounds: async () => [], loadMatch: async () => null,
      getMySeat: () => 1,
      // 生产里由定时器 tick 驱动回执：这里先攒着，等分片到齐后再驱动一次
      later: (callback) => { timers.push(callback) },
    })
    await bare.handle({ kind: REPLAY_MANIFEST_KIND, manifest: encoded.manifest })
    for (const slice of sliceForManifest(encoded.manifest, encoded.base64)) {
      await bare.handle({ kind: REPLAY_SLICE_KIND, slice })
    }
    for (const callback of timers.splice(0)) callback()
    const acks = sent.filter(message => message.kind === REPLAY_ACK_KIND) as Array<{ ack: { id: string; missing: number[] } }>
    expect(acks.at(-1)?.ack.id).toBe(analysisManifestId('remote-match', 3))
    expect(acks.at(-1)?.ack.missing).toEqual([])
    // 没有回调时也绝不能把分析载荷写进回放库
    expect(sent.some(message => message.kind === REPLAY_MANIFEST_KIND)).toBe(false)
  })
})

describe('联机牌谱按本机座位改写', () => {
  it('座位与位次都换成自己的；缺 standings 时保留原值', () => {
    const match = makeMatch(4)
    const adapted = adaptReplayToSeat(match, 1)
    expect(adapted.humanSeat).toBe(1)
    expect(adapted.myRank).toBe(2)
    expect(adapted.myScore).toBe(2400)

    const withoutStandings: ReplayMatch = { ...match, finalStandings: undefined }
    const fallback = adaptReplayToSeat(withoutStandings, 3)
    expect(fallback.humanSeat).toBe(3)
    expect(fallback.myRank).toBe(match.myRank)

    // 非法座位（异常包）时退回原值，不产生越界索引
    expect(adaptReplayToSeat(match, 9).humanSeat).toBe(match.humanSeat)
    expect(adaptReplayToSeat(match, -1).humanSeat).toBe(match.humanSeat)
  })
})
