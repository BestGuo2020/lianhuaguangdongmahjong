// 联机牌谱中继：房主把**全知牌谱**广播给房间里所有玩家，各自存本地。
//
// 协议（5 种应用层消息，均可走广播 —— 房间里每个人都可能持有别人的缺局）：
//   replay_manifest   产出方 → 全员：本局/本场牌谱的清单（片数、字节数、SHA、压缩方式）
//   replay_slice      产出方 → 全员：第 i 片数据（每片远小于传输层 4000 字节上限）
//   replay_ack        收方 → 产出方：我还缺这些片（空数组=收全了）
//   replay_request    缺局方 → **全员**：我这场还缺这几局/还缺场次记录（任意持有者都应答）
//   replay_inventory  持有者 → 全员：本机这场有哪几局、有没有场次记录（缺局方据此知道向谁要）
//
// 为什么需要它：传输层的分片是"任一片丢失即整包丢弃且无人知晓"（AGENTS.md 记录过线上实测）。
// 这里用清单 + 校验 + 回执补发把丢包变成可恢复，并且**收全或放弃都有明确终点**（上限次数）。
// 补局不依赖房主：P2P 里每个玩家本地都有一份全知牌谱，房主清过库/换过权威时，
// 缺局方仍能从**任意还在线且持有那几局**的玩家补齐（多个持有者用同一套哈希错峰，只发一份）。
// 纯逻辑：传输与存储都由外部注入，因此多端都能在单测里用"丢包开关"完整跑通。
import {
  REPLAY_MAX_RETRIES,
  acceptReplaySlice,
  createReceiveSession,
  decodeReplayPayload,
  encodeReplayPayload,
  isReceiveSessionExpired,
  sliceForManifest,
  type ReplayAckMessage,
  type ReplayManifest,
  type ReplayReceiveSession,
  type ReplaySliceMessage,
} from './transfer'
import type { ReplayMatch, ReplayRound } from './types'

export const REPLAY_MANIFEST_KIND = 'replay_manifest'
export const REPLAY_SLICE_KIND = 'replay_slice'
export const REPLAY_ACK_KIND = 'replay_ack'
export const REPLAY_REQUEST_KIND = 'replay_request'
export const REPLAY_INVENTORY_KIND = 'replay_inventory'

export interface RemoteReplayManifestMessage { kind: typeof REPLAY_MANIFEST_KIND; manifest: ReplayManifest }
export interface RemoteReplaySliceMessage { kind: typeof REPLAY_SLICE_KIND; slice: ReplaySliceMessage }
export interface RemoteReplayAckMessage { kind: typeof REPLAY_ACK_KIND; ack: ReplayAckMessage }
export interface RemoteReplayRequestMessage {
  kind: typeof REPLAY_REQUEST_KIND
  matchId: string
  /** 本机缺失的局号（1 起）。 */
  rounds: number[]
  /** 连场次记录也缺（收到场次记录才知道缺哪几局，所以场次记录本身也要能补）。 */
  wantMatch?: boolean
  /** 第几次请求（缺局方自增；持有者据此退避与放弃，避免无限互问）。 */
  attempt?: number
}
/** 持有清单：让缺局方知道"这场谁手上有哪几局"，不依赖房主。 */
export interface RemoteReplayInventoryMessage {
  kind: typeof REPLAY_INVENTORY_KIND
  matchId: string
  /** 本机已有的局号（1 起）。 */
  rounds: number[]
  /** 本场应有局数（来自场次记录；本机没有场次记录时省略）。 */
  roundCount?: number
  hasMatch: boolean
}

export type RemoteReplayMessage =
  | RemoteReplayManifestMessage
  | RemoteReplaySliceMessage
  | RemoteReplayAckMessage
  | RemoteReplayRequestMessage
  | RemoteReplayInventoryMessage

const REPLAY_KINDS = new Set<string>([
  REPLAY_MANIFEST_KIND, REPLAY_SLICE_KIND, REPLAY_ACK_KIND, REPLAY_REQUEST_KIND, REPLAY_INVENTORY_KIND,
])

export function isRemoteReplayMessage(message: unknown): message is RemoteReplayMessage {
  return Boolean(message && typeof message === 'object'
    && REPLAY_KINDS.has(String((message as { kind?: unknown }).kind)))
}

/** 客机把收到的牌谱改写成本机视角：座位排布与位次都按自己的座位算。 */
export function adaptReplayToSeat<T extends ReplayMatch>(match: T, mySeat: number): T {
  const seat = Number.isInteger(mySeat) && mySeat >= 0 && mySeat <= 3 ? mySeat : match.humanSeat
  const mine = match.finalStandings?.find((entry) => entry.seat === seat)
  return {
    ...match,
    humanSeat: seat,
    myRank: mine?.rank ?? match.myRank,
    myScore: mine?.score ?? match.myScore,
  }
}

/** 最近看到的牌谱清单登记簿：多持有者据此错峰，并做到「已经有人开始发了就不再重复发」。 */
export interface ManifestRegistry {
  note(manifestId: string): void
  seenRecently(manifestId: string, withinMs?: number): boolean
  prune(now?: number): void
  size(): number
}

export function createManifestRegistry(now: () => number = () => Date.now()): ManifestRegistry {
  const seen = new Map<string, number>()
  return {
    note(manifestId) { seen.set(manifestId, now()) },
    seenRecently(manifestId, withinMs = 2_000) {
      const at = seen.get(manifestId)
      return at != null && now() - at < withinMs
    },
    prune(at = now()) {
      for (const [id, seenAt] of seen) if (at - seenAt > 60_000) seen.delete(id)
    },
    size() { return seen.size },
  }
}

/** 错峰哈希：同一个 (本机标识, 场次, 局号) 在所有客户端算出同一个数。 */
export function replayBackoffMs(selfKey: string, matchId: string, roundIndex: number, jitterMs: number): number {
  let hash = 0x811c9dc5
  for (const char of `${selfKey}|${matchId}|${roundIndex}`) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % Math.max(1, jitterMs)
}

/** 房主侧：编码 → 广播清单与分片 → 按回执只补缺失片。 */
export interface RemoteReplayHostOptions {
  send(message: object): void
  /** 客机请求补局时读取本地已存的牌谱。 */
  loadRounds(matchId: string): Promise<ReplayRound[]>
  loadMatch(matchId: string): Promise<ReplayMatch | null>
  now?: () => number
  /** 分片大小（字符）：生产用默认值；测试用小值构造多片/丢片场景。 */
  sliceChars?: number
  /** 共享登记簿：广播时登记清单 id，供多持有者错峰去重。 */
  registry?: ManifestRegistry
  /** 补发次数用尽时的回调（诊断用，不抛错）。 */
  onGiveUp?: (manifestId: string, detail: string) => void
}

export interface RemoteReplayHost {
  /** 广播一局全知牌谱。 */
  broadcastRound(round: ReplayRound): Promise<ReplayManifest>
  /** 广播场次记录（很小；客机据此知道自己缺哪几局）。 */
  broadcastMatch(match: ReplayMatch): Promise<ReplayManifest>
  /** 客机回执：只补它缺的片；收全则清理。 */
  handleAck(ack: ReplayAckMessage): Promise<void>
  /** 客机请求补局：按局号重播。 */
  handleRequest(message: RemoteReplayRequestMessage): Promise<void>
  /** 仍在等待回执的牌谱数（诊断/测试用）。 */
  pending(): number
  /** 清理过期载荷（长时间没有回执的）。 */
  prune(now?: number): void
}

/** 广播一份牌谱：清单 + 全部切片（产出方与补局应答方共用）。 */
async function publishPayload(publisher: {
  send(message: object): void
  sliceChars?: number
  onManifest?(manifest: ReplayManifest): void
}, kind: 'round' | 'match', value: ReplayRound | ReplayMatch, identity: {
  id: string
  matchId: string
  roundIndex?: number
}): Promise<{ manifest: ReplayManifest; base64: string }> {
  const { manifest, base64 } = await encodeReplayPayload(kind, value, identity,
    publisher.sliceChars === undefined ? {} : { sliceChars: publisher.sliceChars })
  publisher.onManifest?.(manifest)
  publisher.send({ kind: REPLAY_MANIFEST_KIND, manifest } satisfies RemoteReplayManifestMessage)
  for (const slice of sliceForManifest(manifest, base64)) {
    publisher.send({ kind: REPLAY_SLICE_KIND, slice } satisfies RemoteReplaySliceMessage)
  }
  return { manifest, base64 }
}

/** 这场牌谱的清单 id 约定（补局方与应答方必须一致）。 */
export function roundManifestId(matchId: string, roundIndex: number): string {
  return `${matchId}:${roundIndex}`
}
export function matchManifestId(matchId: string): string {
  return `${matchId}:match`
}

export function createRemoteReplayHost(options: RemoteReplayHostOptions): RemoteReplayHost {
  const now = options.now ?? (() => Date.now())
  const pending = new Map<string, { manifest: ReplayManifest; base64: string; attempts: number; at: number }>()

  async function publish(kind: 'round' | 'match', value: ReplayRound | ReplayMatch, identity: {
    id: string
    matchId: string
    roundIndex?: number
  }): Promise<ReplayManifest> {
    const { manifest, base64 } = await publishPayload({
      send: options.send,
      sliceChars: options.sliceChars,
      onManifest: (published) => options.registry?.note(published.id),
    }, kind, value, identity)
    pending.set(manifest.id, { manifest, base64, attempts: 0, at: now() })
    return manifest
  }

  return {
    async broadcastRound(round) {
      return publish('round', round, { id: `${round.matchId}:${round.roundIndex}`, matchId: round.matchId, roundIndex: round.roundIndex })
    },
    async broadcastMatch(match) {
      return publish('match', match, { id: `${match.id}:match`, matchId: match.id })
    },
    async handleAck(ack) {
      const entry = pending.get(ack.id)
      if (!entry) return
      if (!ack.missing.length) {
        pending.delete(ack.id)
        return
      }
      if (ack.attempt >= REPLAY_MAX_RETRIES) {
        pending.delete(ack.id)
        options.onGiveUp?.(ack.id, `客机回执仍缺 ${ack.missing.join(',')}（第 ${ack.attempt} 次）`)
        return
      }
      entry.attempts += 1
      entry.at = now()
      const slices = sliceForManifest(entry.manifest, entry.base64)
      for (const index of ack.missing) {
        const slice = slices[index]
        if (slice) options.send({ kind: REPLAY_SLICE_KIND, slice } satisfies RemoteReplaySliceMessage)
      }
    },
    async handleRequest(message) {
      const match = await options.loadMatch(message.matchId)
      if (match) await publish('match', match, { id: `${match.id}:match`, matchId: match.id })
      const rounds = await options.loadRounds(message.matchId)
      for (const roundIndex of message.rounds) {
        const round = rounds.find((item) => item.roundIndex === roundIndex)
        if (round) {
          await publish('round', round, {
            id: `${round.matchId}:${round.roundIndex}`,
            matchId: round.matchId,
            roundIndex: round.roundIndex,
          })
        }
      }
    },
    pending() {
      return pending.size
    },
    prune(at = now()) {
      for (const [id, entry] of pending) {
        if (at - entry.at > 120_000) {
          pending.delete(id)
          options.onGiveUp?.(id, '长时间没有收到回执')
        }
      }
    },
  }
}

/**
 * 补局应答服务器：**每个参与者都有**。谁手上还留着对方缺的那几局，谁就把它们补发出去；
 * 多个持有者按同一个哈希错峰，先到者发、其余看到清单就取消（只补一份，不刷屏）。
 */
export interface RemoteReplayServerOptions {
  send(message: object): void
  loadRounds(matchId: string): Promise<ReplayRound[]>
  loadMatch(matchId: string): Promise<ReplayMatch | null>
  /** 本机标识：多个持有者按同一套哈希错峰。 */
  selfKey(): string
  registry: ManifestRegistry
  now?: () => number
  /** 注入定时器便于测试；默认 setTimeout。 */
  later?: (callback: () => void, delay: number) => void
  /** 错峰窗口上限（毫秒）。 */
  jitterMs?: number
  sliceChars?: number
  onServed?(detail: { matchId: string; rounds: number[]; match: boolean }): void
  /** 补发失败（编码/发送异常）：不抛给调用方，但要能看见，否则"静默不补"无法排查。 */
  onServeError?(detail: string): void
}

export interface RemoteReplayServer {
  /** 应答补局请求（任意持有者都可应答；本机没有的局直接跳过）。 */
  handleRequest(message: RemoteReplayRequestMessage): Promise<void>
  /** 广播本机持有清单（让缺局方知道向谁要）。 */
  announce(matchId: string): Promise<void>
  /** 等待错峰窗口的应答数（诊断/测试用）。 */
  pending(): number
  prune(now?: number): void
}

export function createRemoteReplayServer(options: RemoteReplayServerOptions): RemoteReplayServer {
  const now = options.now ?? (() => Date.now())
  const later = options.later ?? ((callback, delay) => { globalThis.setTimeout(callback, delay) })
  const jitterMs = options.jitterMs ?? 600
  const waiting = new Map<string, number>()

  /** 错峰补发：窗口内看到别人已经发了同一份清单就取消。 */
  function scheduleServe(manifestId: string, run: () => Promise<void>) {
    if (options.registry.seenRecently(manifestId)) return
    const delay = replayBackoffMs(options.selfKey(), manifestId, 0, jitterMs)
    waiting.set(manifestId, now())
    later(() => {
      waiting.delete(manifestId)
      if (options.registry.seenRecently(manifestId)) return
      options.registry.note(manifestId)
      void run().catch((error) => {
        options.onServeError?.(`补发 ${manifestId} 失败：${String(error).slice(0, 160)}`)
      })
    }, delay)
  }

  return {
    async handleRequest(message) {
      const rounds = await options.loadRounds(message.matchId)
      const have = new Set(rounds.map((round) => round.roundIndex))
      const wanted = [...new Set(message.rounds)].filter((index) => have.has(index))
      const match = message.wantMatch ? await options.loadMatch(message.matchId) : null
      if (!wanted.length && !match) return
      if (match) {
        const manifestId = matchManifestId(message.matchId)
        const value = match
        scheduleServe(manifestId, async () => {
          await publishPayload({ send: options.send, sliceChars: options.sliceChars }, 'match', value, {
            id: manifestId, matchId: message.matchId,
          })
        })
      }
      for (const roundIndex of wanted) {
        const round = rounds.find((item) => item.roundIndex === roundIndex)!
        const manifestId = roundManifestId(message.matchId, roundIndex)
        scheduleServe(manifestId, async () => {
          await publishPayload({ send: options.send, sliceChars: options.sliceChars }, 'round', round, {
            id: manifestId, matchId: message.matchId, roundIndex,
          })
        })
      }
      options.onServed?.({ matchId: message.matchId, rounds: wanted, match: Boolean(match) })
    },
    async announce(matchId) {
      const rounds = await options.loadRounds(matchId)
      const match = await options.loadMatch(matchId)
      options.send({
        kind: REPLAY_INVENTORY_KIND,
        matchId,
        rounds: rounds.map((round) => round.roundIndex).sort((a, b) => a - b),
        ...(match ? { roundCount: match.roundCount } : {}),
        hasMatch: Boolean(match),
      } satisfies RemoteReplayInventoryMessage)
    },
    pending() { return waiting.size },
    prune(at = now()) {
      for (const [id, at0] of waiting) if (at - at0 > 30_000) waiting.delete(id)
    },
  }
}

/** 客机侧：收片 → 校验 → 存本地；缺片就回执催补；缺局就向**任意持有者**要（不依赖房主）。 */
export interface RemoteReplayPeerOptions {
  send(message: object): void
  saveRound(round: ReplayRound): Promise<void> | void
  saveMatch(match: ReplayMatch): Promise<void> | void
  loadRounds(matchId: string): Promise<ReplayRound[]>
  /** 本机是否已有这场场次记录（缺局方据此决定要不要连场次记录一起要）。 */
  loadMatch(matchId: string): Promise<ReplayMatch | null>
  /** 本机座位：牌谱由房主生成，收到的记录要按本机座位重排/重算位次。 */
  getMySeat(): number
  now?: () => number
  /** 等待多久后第一次回执（给分片留出到达时间）。 */
  ackDelayMs?: number
  /** 注入定时器便于测试；默认 setTimeout。 */
  later?: (callback: () => void, delay: number) => void
  onRejected?: (detail: string) => void
  /** 收到清单时登记（供多持有者错峰去重）。 */
  onManifestSeen?: (manifestId: string) => void
  /** 缺局重试间隔（毫秒）；默认 4s，最多重试 REPLAY_MAX_RETRIES 次。 */
  gapRetryMs?: number
  /** 补局落地后的回调（诊断/测试用）。 */
  onGapFilled?: (detail: { matchId: string; roundIndex: number }) => void
  /** 落库回调：宿主据此广播"本机持有清单"，让别人知道缺局可以找谁要。 */
  onSaved?: (detail: { kind: 'round' | 'match'; matchId: string; roundIndex?: number }) => void
}

export interface RemoteReplayPeer {
  /** 处理一条消息；返回 true 表示是回放消息。 */
  handle(message: unknown): Promise<boolean>
  /** 到期的半截会话：回执催补或放弃（也可由定时器驱动）。 */
  tick(now?: number): void
  /**
   * 复核本机这场是否齐了（落库后调用）。
   * 缺局判断不能只挂在"收到牌谱"上：房主是自己录制、不接收任何东西，
   * 它本地缺失时也必须主动去要（否则"由非房主补局"只做了一半）。
   */
  review(matchId: string): Promise<void>
  /** 已收全并落库的局数（诊断/测试用）。 */
  saved(): number
}

export function createRemoteReplayPeer(options: RemoteReplayPeerOptions): RemoteReplayPeer {
  const now = options.now ?? (() => Date.now())
  const ackDelayMs = options.ackDelayMs ?? 900
  const later = options.later ?? ((callback, delay) => { globalThis.setTimeout(callback, delay) })
  const sessions = new Map<string, {
    manifest: ReplayManifest
    session: ReplayReceiveSession
    attempts: number
    lastAckAt: number
    armed: boolean
  }>()
  let savedCount = 0
  /**
   * 缺局追踪：本机这场还差哪几局（或连场次记录都没有）。
   * 不依赖房主 —— 请求走广播，房间里**任意持有者**都可以补发（见 createRemoteReplayServer）。
   */
  const gaps = new Map<string, { attempts: number; askedAt: number; wantMatch: boolean; sentKey: string }>()
  let reconciling = false

  function requestRounds(matchId: string, rounds: number[], wantMatch: boolean, attempt: number) {
    options.send({
      kind: REPLAY_REQUEST_KIND, matchId, rounds, ...(wantMatch ? { wantMatch: true } : {}), attempt,
    } satisfies RemoteReplayRequestMessage)
  }

  /** 按本机存储重算缺口并请求；收齐了就清掉追踪。force 用于"收到场次记录/持有清单"后的立即追问。 */
  async function reconcile(at = now(), force = false): Promise<void> {
    if (reconciling) return
    reconciling = true
    try {
      for (const [matchId, gap] of [...gaps]) {
        const [rounds, match] = await Promise.all([options.loadRounds(matchId), options.loadMatch(matchId)])
        const have = new Set(rounds.map((round) => round.roundIndex))
        const wantMatch = gap.wantMatch && !match
        const missing = match
          ? Array.from({ length: match.roundCount }, (_, index) => index + 1).filter((index) => !have.has(index))
          : []
        if (!missing.length && !wantMatch) { gaps.delete(matchId); continue }
        const key = wantMatch ? `match+${missing.join(',')}` : missing.join(',')
        if (force) {
          // 信息驱动（收到场次记录/持有清单）：同样的缺口刚要过就不再要 ——
          // 否则"应答方重播场次记录 → 又追问"会形成反馈并把重试预算烧光（实测回归）。
          if (key === gap.sentKey) continue
        } else {
          if (at - gap.askedAt < (options.gapRetryMs ?? 4_000)) continue
          if (gap.attempts >= REPLAY_MAX_RETRIES) {
            gaps.delete(matchId)
            options.onRejected?.(`牌谱 ${matchId} 仍缺 ${wantMatch ? '场次记录' : missing.join(',')}，放弃`)
            continue
          }
          gap.attempts += 1
        }
        gap.sentKey = key
        gap.askedAt = at
        gap.wantMatch = wantMatch
        requestRounds(matchId, missing, wantMatch, gap.attempts)
      }
    } finally {
      reconciling = false
    }
  }

  /** 登记/刷新一场的缺口（由接收到场次记录或某局触发）。 */
  function noteGap(matchId: string, wantMatch: boolean) {
    const existing = gaps.get(matchId)
    if (existing) {
      existing.wantMatch = existing.wantMatch || wantMatch
      return existing
    }
    const created = { attempts: 0, askedAt: 0, wantMatch, sentKey: '' }
    gaps.set(matchId, created)
    return created
  }

  function ack(id: string, missing: number[], attempts: number) {
    options.send({ kind: REPLAY_ACK_KIND, ack: { id, missing, attempt: attempts } } satisfies RemoteReplayAckMessage)
  }

  function armAck(id: string) {
    const entry = sessions.get(id)
    if (!entry || entry.armed) return
    entry.armed = true
    later(() => {
      const current = sessions.get(id)
      if (!current) return
      current.armed = false
      const missing = current.session.parts
        .map((part, index) => (part == null ? index : -1))
        .filter((index) => index >= 0)
      if (!missing.length) return
      if (current.attempts >= REPLAY_MAX_RETRIES) {
        sessions.delete(id)
        options.onRejected?.(`牌谱 ${id} 仍缺 ${missing.join(',')}，放弃`)
        return
      }
      current.attempts += 1
      current.lastAckAt = now()
      ack(id, missing, current.attempts)
      armAck(id)
    }, ackDelayMs)
  }

  async function acceptPayload(manifest: ReplayManifest, base64: string): Promise<void> {
    const decoded = await decodeReplayPayload(manifest, base64)
    if (decoded.error) {
      // 校验不过视为"没收到"：请求整份重发（上限由回执次数兜住）
      const entry = sessions.get(manifest.id)
      if (entry && entry.attempts < REPLAY_MAX_RETRIES) {
        entry.attempts += 1
        entry.session = createReceiveSession(manifest, now())
        ack(manifest.id, Array.from({ length: manifest.total }, (_, index) => index), entry.attempts)
        armAck(manifest.id)
        return
      }
      sessions.delete(manifest.id)
      options.onRejected?.(`牌谱 ${manifest.id} 校验失败（${decoded.error}）`)
      return
    }
    sessions.delete(manifest.id)
    if (manifest.payloadKind === 'match') {
      const match = adaptReplayToSeat(decoded.value as ReplayMatch, options.getMySeat())
      await options.saveMatch(match)
      ack(manifest.id, [], 0)
      // 自愈：场次记录告诉我们应有几局，缺的主动向**任意持有者**要（房主没有也能补）
      noteGap(match.id, false)
      options.onSaved?.({ kind: 'match', matchId: match.id })
      await reconcile(now(), true)
      return
    }
    const round = decoded.value as ReplayRound
    await options.saveRound({ ...round, matchId: round.matchId })
    savedCount += 1
    ack(manifest.id, [], 0)
    // 场末掉线等情况：连场次记录都没收到（否则列表里这场根本不会出现），也要能把它要回来
    if (!await options.loadMatch(round.matchId)) noteGap(round.matchId, true)
    options.onSaved?.({ kind: 'round', matchId: round.matchId, roundIndex: round.roundIndex })
    options.onGapFilled?.({ matchId: round.matchId, roundIndex: round.roundIndex })
    await reconcile(now(), true)
  }

  return {
    async handle(message) {
      if (!isRemoteReplayMessage(message)) return false
      if (message.kind === REPLAY_MANIFEST_KIND) {
        options.onManifestSeen?.(message.manifest.id)
        const existing = sessions.get(message.manifest.id)
        if (!existing) {
          sessions.set(message.manifest.id, {
            manifest: message.manifest,
            session: createReceiveSession(message.manifest, now()),
            attempts: 0,
            lastAckAt: now(),
            armed: false,
          })
          armAck(message.manifest.id)
        }
        return true
      }
      if (message.kind === REPLAY_SLICE_KIND) {
        const entry = sessions.get(message.slice.id)
        if (!entry) return true
        const result = acceptReplaySlice(entry.session, message.slice)
        if (result.complete && result.base64) await acceptPayload(entry.manifest, result.base64)
        return true
      }
      if (message.kind === REPLAY_INVENTORY_KIND) {
        // 有人报持有：它手上有我缺的局（或它有场次记录而我没有）就立刻去要。
        // 这样即使房主清过库/换过权威，也能从**任意还在线的持有者**补齐。
        const [stored, match] = await Promise.all([
          options.loadRounds(message.matchId), options.loadMatch(message.matchId),
        ])
        const have = new Set(stored.map((round) => round.roundIndex))
        const lacking = [...new Set(message.rounds)].filter((index) => !have.has(index))
        const wantMatch = message.hasMatch && !match
        if (lacking.length || wantMatch) {
          noteGap(message.matchId, wantMatch)
          requestRounds(message.matchId, lacking, wantMatch, gaps.get(message.matchId)?.attempts ?? 0)
        }
        return true
      }
      // ack / request 由房主与持有者处理；客机收到就忽略（消息走广播，人人可见）
      return true
    },
    tick(at = now()) {
      void reconcile(at)
      for (const [id, entry] of sessions) {
        if (isReceiveSessionExpired(entry.session, at)) {
          sessions.delete(id)
          options.onRejected?.(`牌谱 ${id} 等待超时`)
          continue
        }
        const missing = entry.session.parts
          .map((part, index) => (part == null ? index : -1))
          .filter((index) => index >= 0)
        if (!missing.length || at - entry.lastAckAt < ackDelayMs) continue
        if (entry.attempts >= REPLAY_MAX_RETRIES) {
          sessions.delete(id)
          options.onRejected?.(`牌谱 ${id} 仍缺 ${missing.join(',')}，放弃`)
          continue
        }
        entry.attempts += 1
        entry.lastAckAt = at
        ack(id, missing, entry.attempts)
      }
    },
    saved() {
      return savedCount
    },
    async review(matchId) {
      // 本机这场是否齐了：没有场次记录就把它也一起要（缺局判断的本地侧入口）
      noteGap(matchId, !(await options.loadMatch(matchId)))
      await reconcile(now(), true)
    },
  }
}
