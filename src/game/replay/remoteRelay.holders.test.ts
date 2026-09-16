import { describe, expect, it } from 'vitest'
import {
  REPLAY_INVENTORY_KIND,
  REPLAY_MANIFEST_KIND,
  REPLAY_REQUEST_KIND,
  REPLAY_SLICE_KIND,
  createManifestRegistry,
  createRemoteReplayHost,
  createRemoteReplayPeer,
  createRemoteReplayServer,
  isRemoteReplayMessage,
  replayBackoffMs,
  roundManifestId,
  type RemoteReplayMessage,
} from './remoteRelay'
import type { ReplayMatch, ReplayRound, ReplayStep } from './types'

// 「缺局问任意持有者」的确定性验证：房主清过库/换过权威时，缺局方仍能从还在线的玩家补齐。
// 多参与者共用一个可丢包的广播总线 + 可排序的错峰调度器，因此"谁先发、谁取消、发了几份"都可断言。

function step(index: number): ReplayStep {
  const tiles = ['m5', 'p2', 's9', 'east', 'red', 'white'] as const
  return {
    t: index % 2 === 0 ? 'draw' : 'discard',
    seat: index % 4,
    tile: tiles[index % tiles.length],
    wallLeft: 70 - index,
    headDrawn: index,
    currentPlayer: index % 4,
    state: { hand: ['m1', 'm2', 'east'], melds: [], drawnTileIndex: -1, redCount: 0, discards: ['p1', 'red'] },
  }
}

function makeRound(matchId: string, roundIndex: number): ReplayRound {
  return {
    id: `${matchId}:${roundIndex}`, matchId, roundIndex, round: roundIndex, roundLabel: `东${roundIndex}局`,
    dealer: 0, honba: 0, matchType: 'east', dice: { second: [3, 4] }, diceThrowerIndex: 0, flipTile: 'p9',
    jokerTiles: ['p9', 'white'], wildcardTiles: ['white'], wallBreakIndex: 12, flipStack: 7,
    scoresBefore: [1000, 1000, 1000, 1000],
    anchor: {
      hands: [['m1'], ['m2'], ['m3'], ['m4']], melds: [[], [], [], []], discards: [[], [], [], []],
      drawnTileIndex: [-1, -1, -1, -1], redCount: [0, 0, 0, 0], scores: [1000, 1000, 1000, 1000],
      wallLeft: 70, headDrawn: 1, currentPlayer: 0,
    },
    steps: Array.from({ length: 40 }, (_, index) => step(index + roundIndex)),
    final: null, landedAt: 0,
  }
}

function makeMatch(matchId: string, roundCount: number): ReplayMatch {
  return {
    id: matchId, schemaVersion: 1, rulesetId: 'lotus-blood-flow', rulesetName: '莲花麻将·血流',
    matchType: 'east', matchName: '东风场', gameMode: 'remote', themeName: 'llm',
    players: [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, avatar: '', startScore: 1000 })),
    humanSeat: 0, startedAt: 1, endedAt: 2, status: 'finished', roundCount, myRank: 1, myScore: 100,
    finalStandings: [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, score: 1000 - seat * 100, rank: seat + 1 })),
    summary: '',
  }
}

interface BusMessage { from: string; message: RemoteReplayMessage }

interface HolderOptions {
  name: string
  /** 本机储存（模拟各自的 IndexedDB）。 */
  rounds?: ReplayRound[]
  match?: ReplayMatch | null
  /** 造缺局：这些局号不落库。 */
  dropRounds?: number[]
  dropManifestsFor?: (manifest: { id: string; roundIndex?: number }) => boolean
}

function createHolder(options: HolderOptions) {
  const rounds = new Map<string, ReplayRound[]>()
  const matches = new Map<string, ReplayMatch>()
  let saved = 0
  return {
    name: options.name,
    rounds, matches,
    get saved() { return saved },
    bumpSaved() { saved += 1 },
    withRound(round: ReplayRound) {
      const list = rounds.get(round.matchId) ?? []
      const next = list.filter((item) => item.roundIndex !== round.roundIndex)
      next.push(round)
      rounds.set(round.matchId, next.sort((a, b) => a.roundIndex - b.roundIndex))
    },
  }
}

describe('联机回放补局：任意持有者应答', () => {
  function createFabric(names: string[], options: { hostName?: string | null } = {}) {
    const hostName = options.hostName === undefined ? names[0] : options.hostName
    const registry = createManifestRegistry()
    const messages: BusMessage[] = []
    const timers: Array<{ callback: () => void; delay: number; at: number }> = []
    const published: string[] = []
    const served: string[] = []
    const asked: string[] = []
    const scheduled: string[] = []
    const rejected: string[] = []
    const holders = names.map((name) => createHolder({ name }))
    const byName = new Map(holders.map((holder) => [holder.name, holder]))
    const isDropping = (_name: string) => false

    const send = (from: string) => (message: object) => {
      const plain = JSON.parse(JSON.stringify(message)) as RemoteReplayMessage
      if (plain.kind === REPLAY_MANIFEST_KIND) {
        published.push(`${from}:${plain.manifest.id}`)
        registry.note(plain.manifest.id)
      }
      for (const holder of holders) {
        if (holder.name === from) continue
        // 「中途缺局」的模拟：该参与者的收包在总线处被丢掉
        if (isDropping(holder.name) && (plain.kind === REPLAY_MANIFEST_KIND || plain.kind === REPLAY_SLICE_KIND)) continue
        messages.push({ from, message: JSON.parse(JSON.stringify(plain)) as RemoteReplayMessage })
      }
    }

    const later = (callback: () => void, delay: number) => { timers.push({ callback, delay, at: delay }) }
    const laterFor = (name: string) => (callback: () => void, delay: number) => {
      scheduled.push(`${name}@${delay}`)
      later(callback, delay)
    }

    const peers = new Map<string, ReturnType<typeof createRemoteReplayPeer>>()
    const servers = new Map<string, ReturnType<typeof createRemoteReplayServer>>()
    const hosts = new Map<string, ReturnType<typeof createRemoteReplayHost>>()

    for (const holder of holders) {
      peers.set(holder.name, createRemoteReplayPeer({
        send: send(holder.name),
        saveRound: (round) => { holder.withRound(round); holder.bumpSaved() },
        saveMatch: (match) => { holder.matches.set(match.id, match) },
        loadRounds: async (matchId) => holder.rounds.get(matchId) ?? [],
        loadMatch: async (matchId) => holder.matches.get(matchId) ?? null,
        getMySeat: () => names.indexOf(holder.name),
        later: laterFor(holder.name),
        ackDelayMs: 10,
        gapRetryMs: 50,
        onManifestSeen: (id) => registry.note(id),
        onRejected: (detail) => rejected.push(`${holder.name}: ${detail}`),
      }))
      servers.set(holder.name, createRemoteReplayServer({
        send: send(holder.name),
        loadRounds: async (matchId) => holder.rounds.get(matchId) ?? [],
        loadMatch: async (matchId) => holder.matches.get(matchId) ?? null,
        selfKey: () => holder.name,
        registry,
        later: laterFor(holder.name),
        jitterMs: 300,
        sliceChars: 200,
        onServed: (detail) => served.push(`${holder.name}:${detail.rounds.join('+') || '-'}${detail.match ? 'M' : ''}`),
        onServeError: (detail) => served.push(`ERR ${holder.name}:${detail}`),
      }))
      // 只有真正的房主建"发布/回执"中继；其他参与者只做补局应答（与 App 接线一致：
      // 请求 → 房主中继立即应答 + 每个参与者的 server 错峰应答，后者看到清单就取消）
      if (hostName !== null && holder.name === hostName) {
        hosts.set(holder.name, createRemoteReplayHost({
          send: send(holder.name),
          loadRounds: async (matchId) => holder.rounds.get(matchId) ?? [],
          loadMatch: async (matchId) => holder.matches.get(matchId) ?? null,
          registry,
          sliceChars: 200,
        }))
      }
    }

    /** 把队列跑空，并按延迟顺序驱动错峰调度器（模拟"谁先到"）。 */
    async function pump(steps = 200) {
      for (let step = 0; step < steps; step += 1) {
        while (messages.length) {
          const { from, message } = messages.shift()!
          if (message.kind === REPLAY_REQUEST_KIND) {
            asked.push(`${from}:${message.rounds.join('+') || '-'}${message.wantMatch ? 'M' : ''}`)
            for (const [name, server] of servers) {
              if (name !== from) await server.handleRequest(message)
            }
            for (const [name, host] of hosts) {
              if (name !== from) await host.handleRequest(message)
            }
            continue
          }
          for (const [name, peer] of peers) {
            if (name === from) continue
            await peer.handle(message)
          }
        }
        const due = timers.splice(0).sort((a, b) => a.delay - b.delay)
        if (due.length) for (const entry of due) entry.callback()
        // 错峰回调里的编码/发布是 fire-and-forget（gzip + 摘要流水线）：
        // 轮询到"发布数不再变化且队列已空"再判定收敛，否则会误判队列已空。
        let previousPublished = -1
        for (let turn = 0; turn < 12; turn += 1) {
          if (!messages.length && !timers.length && published.length === previousPublished) break
          previousPublished = published.length
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
        if (!messages.length && !timers.length) {
          await new Promise((resolve) => setTimeout(resolve, 2))
          if (!messages.length && !timers.length) return
        }
      }
    }

    return { holders, byName, peers, servers, hosts, pump, published, served, asked, scheduled, rejected, registry, timers, messages }
  }

  it('探针：server 单独应答能发出去', async () => {
    const sent: unknown[] = []
    const waiters: Array<() => void> = []
    const registry = createManifestRegistry()
    const server = createRemoteReplayServer({
      send: (message) => sent.push(message),
      loadRounds: async () => [makeRound('px', 1)],
      loadMatch: async () => null,
      selfKey: () => 'me',
      registry,
      later: (callback) => waiters.push(callback),
      jitterMs: 10,
      sliceChars: 200,
      onServeError: (detail) => sent.push(`ERR:${detail}`),
    })
    await server.handleRequest({ kind: REPLAY_REQUEST_KIND, matchId: 'px', rounds: [1], attempt: 1 })
    expect(waiters).toHaveLength(1)
    waiters.forEach((callback) => callback())
    // 补发是 fire-and-forget（gzip + 摘要流水线），轮询到真正发出去
    for (let turn = 0; turn < 40 && !sent.length; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sent.length).toBeGreaterThan(0)
    expect(JSON.stringify(sent[0])).toContain(REPLAY_MANIFEST_KIND)
  })

  it('房主清过库时，另一名玩家照样能把缺局补给他（核心能力）', async () => {
    const fabric = createFabric(['host', 'holder', 'late'])
    const match = makeMatch('m1', 4)
    const rounds = [1, 2, 3, 4].map((index) => makeRound('m1', index))

    // holder 手上有一整场；房主自己反而没有（清过库）；late 缺 1、2 局
    for (const round of rounds) fabric.byName.get('holder')!.withRound(round)
    fabric.byName.get('holder')!.matches.set(match.id, match)
    for (const round of rounds.slice(2)) fabric.byName.get('late')!.withRound(round)

    // late 只有 3、4 局，也没有场次记录；它广播请求（房主无法应答，holder 应答）
    expect(fabric.published).toEqual([])

    fabric.messages.push({ from: 'late', message: { kind: REPLAY_REQUEST_KIND, matchId: 'm1', rounds: [1, 2], attempt: 1 } })
    await fabric.pump()

    const late = fabric.byName.get('late')!
    expect(late.rounds.get('m1')?.map((round) => round.roundIndex),
      `published=${JSON.stringify(fabric.published)} served=${JSON.stringify(fabric.served)} scheduled=${JSON.stringify(fabric.scheduled)} asked=${JSON.stringify(fabric.asked)} timers=${fabric.timers.length}`).toEqual([1, 2, 3, 4])
    expect(late.saved).toBeGreaterThanOrEqual(2)
    expect(fabric.rejected).toEqual([])
  })

  it('多个持有者：同一次请求只补一份（错峰 + 看到清单就取消）', async () => {
    const populate = (fabric: ReturnType<typeof createFabric>, matchId: string, names: string[], indices: number[]) => {
      for (const name of names) {
        fabric.byName.get(name)!.matches.set(matchId, makeMatch(matchId, 4))
        for (const index of indices) fabric.byName.get(name)!.withRound(makeRound(matchId, index))
      }
    }

    // 场景 1：房主还在 ⇒ 房主中继立即应答，另一个持有者（server）看到清单后取消
    const withHost = createFabric(['host', 'holderB', 'late'], { hostName: 'host' })
    populate(withHost, 'm2', ['host', 'holderB'], [1, 2, 3, 4])
    populate(withHost, 'm2', ['late'], [3, 4])
    withHost.messages.push({ from: 'late', message: { kind: REPLAY_REQUEST_KIND, matchId: 'm2', rounds: [1, 2], attempt: 1 } })
    await withHost.pump()
    expect(withHost.byName.get('late')!.rounds.get('m2')?.map((round) => round.roundIndex)).toEqual([1, 2, 3, 4])
    expect(withHost.published.filter((entry) => entry.startsWith('host:'))).not.toEqual([])
    expect(withHost.published.filter((entry) => entry.startsWith('holderB:')),
      JSON.stringify(withHost.published)).toEqual([])

    // 场景 2：房主不在/清过库（房间里没有房主中继）⇒ 两个纯持有者之间也只发一份
    const peersOnly = createFabric(['holderA', 'holderB', 'late'], { hostName: null })
    populate(peersOnly, 'm5', ['holderA', 'holderB'], [1, 2, 3, 4])
    populate(peersOnly, 'm5', ['late'], [3, 4])
    peersOnly.messages.push({ from: 'late', message: { kind: REPLAY_REQUEST_KIND, matchId: 'm5', rounds: [1, 2], attempt: 1 } })
    await peersOnly.pump()
    expect(peersOnly.byName.get('late')!.rounds.get('m5')?.map((round) => round.roundIndex)).toEqual([1, 2, 3, 4])
    const lateAsks = peersOnly.asked.length
    expect(lateAsks).toBeGreaterThan(0)
    expect(peersOnly.scheduled.filter((entry) => entry.startsWith('holderA@') || entry.startsWith('holderB@')).length)
      .toBeGreaterThan(0)
    // 每一局只会有一个持有者真正补发（另一个在错峰窗口里看到清单就取消）
    for (const index of [1, 2]) {
      const byRound = peersOnly.published.filter((entry) => entry.endsWith(`:m5:${index}`))
      expect(byRound, JSON.stringify(peersOnly.published)).toHaveLength(1)
    }
    expect(peersOnly.rejected).toEqual([])
  })

  it('连场次记录都没有（场末掉线）也能要回来，并据此补齐缺局', async () => {
    const fabric = createFabric(['holder', 'late'])
    const match = makeMatch('m3', 4)
    fabric.byName.get('holder')!.matches.set(match.id, match)
    for (const index of [1, 2, 3, 4]) fabric.byName.get('holder')!.withRound(makeRound('m3', index))
    // late 只有第 4 局（前面全丢），也没有场次记录
    fabric.byName.get('late')!.withRound(makeRound('m3', 4))

    // late 收到某局 → 发现自己没有场次记录 → 立刻要场次记录
    await fabric.peers.get('late')!.handle({
      kind: REPLAY_INVENTORY_KIND, matchId: 'm3', rounds: [1, 2, 3, 4], roundCount: 4, hasMatch: true,
    })
    await fabric.pump()

    const late = fabric.byName.get('late')!
    expect(late.matches.get('m3')?.roundCount).toBe(4)
    expect(late.rounds.get('m3')?.map((round) => round.roundIndex)).toEqual([1, 2, 3, 4])
    expect(fabric.rejected).toEqual([])
  })

  it('没人持有就按上限放弃，不会无限互问', async () => {
    const fabric = createFabric(['nobody', 'late'])
    const match = makeMatch('m4', 4)
    fabric.byName.get('late')!.matches.set(match.id, match)
    fabric.byName.get('late')!.withRound(makeRound('m4', 3))

    // 有人宣称持有整场，但实际手上什么都没有 ⇒ 补不齐，只能按上限放弃
    await fabric.peers.get('late')!.handle({
      kind: REPLAY_INVENTORY_KIND, matchId: 'm4', rounds: [1, 2, 3, 4], roundCount: 4, hasMatch: true,
    })
    expect(fabric.rejected).toEqual([])
    // 反复驱动定时器（模拟长时间等待）
    for (let round = 0; round < 8; round += 1) {
      fabric.timers.splice(0).forEach((entry) => entry.callback())
      await fabric.peers.get('late')!.tick(Date.now() + round * 100)
      await fabric.pump()
    }
    expect(fabric.rejected.join(' | ')).toContain('放弃')
    expect(fabric.byName.get('late')!.rounds.get('m4')).toHaveLength(1)
  })

  it('错峰哈希稳定且能把持有者摊开', () => {
    const first = replayBackoffMs('peer-a', 'm5', 1, 300)
    expect(replayBackoffMs('peer-a', 'm5', 1, 300)).toBe(first)
    const spread = new Set(['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e'].map((key) => replayBackoffMs(key, 'm5', 1, 300)))
    expect(spread.size).toBeGreaterThan(1)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(300)
  })

  it('登记簿能抑制重复补发并会过期清理', () => {
    let clock = 1_000
    const registry = createManifestRegistry(() => clock)
    expect(registry.seenRecently('m1:1')).toBe(false)
    registry.note('m1:1')
    expect(registry.seenRecently('m1:1')).toBe(true)
    clock += 3_000
    expect(registry.seenRecently('m1:1')).toBe(false)
    registry.note('m1:2')
    clock += 120_000
    registry.prune()
    expect(registry.size()).toBe(0)
  })

  it('补局消息全部走回放协议类型（不会污染对局消息）', () => {
    expect(isRemoteReplayMessage({ kind: REPLAY_INVENTORY_KIND })).toBe(true)
    expect(isRemoteReplayMessage({ kind: 'state_snapshot' })).toBe(false)
    const slice = { kind: REPLAY_SLICE_KIND, slice: { id: 'x', index: 0, total: 1, data: 'AA' } }
    expect(isRemoteReplayMessage(slice)).toBe(true)
  })
})
