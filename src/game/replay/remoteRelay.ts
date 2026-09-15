// 联机牌谱中继：房主把**全知牌谱**广播给房间里所有玩家，各自存本地。
//
// 协议（4 种应用层消息，均可走广播；只有回执/补发是"谁需要谁说话"）：
//   replay_manifest  房主 → 全员：本局/本场牌谱的清单（片数、字节数、SHA、压缩方式）
//   replay_slice     房主 → 全员：第 i 片数据（每片远小于传输层 4000 字节上限）
//   replay_ack       客机 → 房主：我还缺这些片（空数组=收全了）
//   replay_request   客机 → 房主：我这场还缺这几局（自愈：清单本身丢了也能补）
//
// 为什么需要它：传输层的分片是"任一片丢失即整包丢弃且无人知晓"（AGENTS.md 记录过线上实测）。
// 这里用清单 + 校验 + 回执补发把丢包变成可恢复，并且**收全或放弃都有明确终点**（上限次数）。
// 纯逻辑：传输与存储都由外部注入，因此两端都能在单测里用"丢包开关"完整跑通。
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

export interface RemoteReplayManifestMessage { kind: typeof REPLAY_MANIFEST_KIND; manifest: ReplayManifest }
export interface RemoteReplaySliceMessage { kind: typeof REPLAY_SLICE_KIND; slice: ReplaySliceMessage }
export interface RemoteReplayAckMessage { kind: typeof REPLAY_ACK_KIND; ack: ReplayAckMessage }
export interface RemoteReplayRequestMessage {
  kind: typeof REPLAY_REQUEST_KIND
  matchId: string
  /** 本机缺失的局号（1 起）。 */
  rounds: number[]
}

export type RemoteReplayMessage =
  | RemoteReplayManifestMessage
  | RemoteReplaySliceMessage
  | RemoteReplayAckMessage
  | RemoteReplayRequestMessage

const REPLAY_KINDS = new Set<string>([
  REPLAY_MANIFEST_KIND, REPLAY_SLICE_KIND, REPLAY_ACK_KIND, REPLAY_REQUEST_KIND,
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

/** 房主侧：编码 → 广播清单与分片 → 按回执只补缺失片。 */
export interface RemoteReplayHostOptions {
  send(message: object): void
  /** 客机请求补局时读取本地已存的牌谱。 */
  loadRounds(matchId: string): Promise<ReplayRound[]>
  loadMatch(matchId: string): Promise<ReplayMatch | null>
  now?: () => number
  /** 分片大小（字符）：生产用默认值；测试用小值构造多片/丢片场景。 */
  sliceChars?: number
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

export function createRemoteReplayHost(options: RemoteReplayHostOptions): RemoteReplayHost {
  const now = options.now ?? (() => Date.now())
  const pending = new Map<string, { manifest: ReplayManifest; base64: string; attempts: number; at: number }>()

  async function publish(kind: 'round' | 'match', value: ReplayRound | ReplayMatch, identity: {
    id: string
    matchId: string
    roundIndex?: number
  }): Promise<ReplayManifest> {
    const { manifest, base64 } = await encodeReplayPayload(kind, value, identity,
      options.sliceChars === undefined ? {} : { sliceChars: options.sliceChars })
    pending.set(manifest.id, { manifest, base64, attempts: 0, at: now() })
    options.send({ kind: REPLAY_MANIFEST_KIND, manifest } satisfies RemoteReplayManifestMessage)
    for (const slice of sliceForManifest(manifest, base64)) {
      options.send({ kind: REPLAY_SLICE_KIND, slice } satisfies RemoteReplaySliceMessage)
    }
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

/** 客机侧：收片 → 校验 → 存本地；缺片就回执催补；场次记录到达时补齐缺失的局。 */
export interface RemoteReplayPeerOptions {
  send(message: object): void
  saveRound(round: ReplayRound): Promise<void> | void
  saveMatch(match: ReplayMatch): Promise<void> | void
  loadRounds(matchId: string): Promise<ReplayRound[]>
  /** 本机座位：牌谱由房主生成，收到的记录要按本机座位重排/重算位次。 */
  getMySeat(): number
  now?: () => number
  /** 等待多久后第一次回执（给分片留出到达时间）。 */
  ackDelayMs?: number
  /** 注入定时器便于测试；默认 setTimeout。 */
  later?: (callback: () => void, delay: number) => void
  onRejected?: (detail: string) => void
}

export interface RemoteReplayPeer {
  /** 处理一条消息；返回 true 表示是回放消息。 */
  handle(message: unknown): Promise<boolean>
  /** 到期的半截会话：回执催补或放弃（也可由定时器驱动）。 */
  tick(now?: number): void
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
      // 自愈：场次记录告诉我们应有几局，缺的主动向房主要
      const stored = await options.loadRounds(match.id)
      const have = new Set(stored.map((round) => round.roundIndex))
      const missing = Array.from({ length: match.roundCount }, (_, index) => index + 1)
        .filter((roundIndex) => !have.has(roundIndex))
      if (missing.length) {
        options.send({ kind: REPLAY_REQUEST_KIND, matchId: match.id, rounds: missing } satisfies RemoteReplayRequestMessage)
      }
      return
    }
    const round = decoded.value as ReplayRound
    await options.saveRound({ ...round, matchId: round.matchId })
    savedCount += 1
    ack(manifest.id, [], 0)
  }

  return {
    async handle(message) {
      if (!isRemoteReplayMessage(message)) return false
      if (message.kind === REPLAY_MANIFEST_KIND) {
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
      // ack / request 只由房主处理；客机收到就忽略（消息走广播，人人可见）
      return true
    },
    tick(at = now()) {
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
  }
}
