// 承诺洗牌（Phase 4 反作弊威慑）：多方先提交「种子承诺」、再揭晓种子，共同确定性派生
// 牌墙与骰点，防止房主单方面控制洗牌/骰点。诚实说明：这防「做牌/控骰」，不防「看牌」——
// 房主最终要拿整副墙发牌，发完即全知，这是 P2P 暗牌博弈的物理上限。
//
// 协议：
// 1. 每家生成种子 sᵢ，广播承诺 cᵢ = hash(seat: sᵢ)
// 2. 收齐所有承诺后各自揭晓 sᵢ
// 3. 校验每个 hash 与承诺一致，用 combineSeeds 派生墙与骰点
import type { TileType } from '../../core/contracts/types'

export interface ShuffleCommitMessage { type: 'shuffle_commit'; roundId: string; seat: number; commitment: string; authorityEpoch?: string }
export interface ShuffleRevealMessage { type: 'shuffle_reveal'; roundId: string; seat: number; seed: string; authorityEpoch?: string }
export interface ShuffleParticipant {
  seat: number
  peerId: string
}

export interface ShuffleStartMessage {
  type: 'round_shuffle_start'
  roomId: string
  round: number
  /** 连庄时 round 不变，必须用 honba 区分合法新手与旧洗牌消息。 */
  honba: number
  roundId: string
  /** 本轮实际参与承诺的座位；掉线并已由 AI 接管的座位不在其中。 */
  seats: number[]
  /** 房主在本轮开始时锁定的实际 peer → seat 映射；客户端不得用旧 roster 反推。 */
  participants: ShuffleParticipant[]
  seatCount: number
  /** 后续局绑定当前房主引擎生命周期；首局大厅消息可不带。 */
  authorityEpoch?: string
}

function isCommit(message: unknown): message is ShuffleCommitMessage {
  return typeof message === 'object' && message !== null
    && (message as { type?: unknown }).type === 'shuffle_commit'
    && typeof (message as { roundId?: unknown }).roundId === 'string'
    && (message as { roundId: string }).roundId.length > 0
    && Number.isInteger((message as { seat?: unknown }).seat)
    && typeof (message as { commitment?: unknown }).commitment === 'string'
    && (message as { commitment: string }).commitment.length > 0
    && ((message as { authorityEpoch?: unknown }).authorityEpoch === undefined
      || (typeof (message as { authorityEpoch?: unknown }).authorityEpoch === 'string'
        && (message as { authorityEpoch: string }).authorityEpoch.length > 0))
}

function isReveal(message: unknown): message is ShuffleRevealMessage {
  return typeof message === 'object' && message !== null
    && (message as { type?: unknown }).type === 'shuffle_reveal'
    && typeof (message as { roundId?: unknown }).roundId === 'string'
    && (message as { roundId: string }).roundId.length > 0
    && Number.isInteger((message as { seat?: unknown }).seat)
    && typeof (message as { seed?: unknown }).seed === 'string'
    && (message as { seed: string }).seed.length > 0
    && ((message as { authorityEpoch?: unknown }).authorityEpoch === undefined
      || (typeof (message as { authorityEpoch?: unknown }).authorityEpoch === 'string'
        && (message as { authorityEpoch: string }).authorityEpoch.length > 0))
}

// ── 纯函数（可独立测试） ──────────────────────────────────

export async function hashSeed(input: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const data = new TextEncoder().encode(input)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  // 非安全上下文回退：FNV-1a（仅威慑用途，非密码学强度）
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** mulberry32：由字符串种子派生确定性 PRNG。 */
function createRng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let a = h >>> 0
  return function () {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffleTiles<T>(tiles: readonly T[], seed: string): T[] {
  const rng = createRng(seed)
  const result = [...tiles]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = result[i]
    result[i] = result[j]
    result[j] = tmp
  }
  return result
}

export function deriveDice(seed: string): [number, number] {
  const rng = createRng(`${seed}:dice`)
  return [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)]
}

/** 合并各家种子（排序后拼接），保证与座位顺序无关、各家派生一致。 */
export function combineSeeds(seeds: string[]): string {
  return [...seeds].sort().join('|')
}

// ── 协调层（经 SDK Room 的 P2P 消息交换） ────────────────

export interface CommittedShuffleOptions {
  room: VibeHubSDK.Room
  roundId: string
  seatCount: number
  mySeat: number
  /** 后续局必须绑定当前房主代次；首局大厅洗牌可省略。 */
  authorityEpoch?: string
  /** peerId → seat，必须包含房主和所有实际参与承诺的玩家。 */
  seatByPeer: Map<string, number>
  tiles: readonly TileType[]
  onComplete: (wall: TileType[], dice: [number, number], secondDice: [number, number]) => void
  onError?: (reason: string) => void
  /** 承诺超时时告知协调层哪些参与者没有提交，允许掉线座位切 AI 后重试本轮。 */
  onTimeout?: (missingSeats: number[]) => void
  randomSeed?: () => string
  timeoutMs?: number
}

function defaultRandomSeed(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function runCommittedShuffle(options: CommittedShuffleOptions): void {
  const {
    room,
    roundId,
    seatCount,
    mySeat,
    authorityEpoch,
    seatByPeer,
    tiles,
    onComplete,
    onError,
    onTimeout,
    randomSeed = defaultRandomSeed,
    timeoutMs = 15000,
  } = options
  const commitments = new Map<number, string>()
  const seeds = new Map<number, string>()
  let revealed = false
  let finished = false

  const expectedSeats = new Set([...seatByPeer.values()])
  const participantCount = expectedSeats.size

  // 参与者映射本身也是房主锁定的协议输入。重复座位、越界座位或空轮次不能
  // 被当成“少一个人”的正常洗牌，否则会把错误映射静默降级成不完整的牌局。
  if (
    !roundId
    || !Number.isInteger(seatCount) || seatCount < 1 || seatCount > 4
    || !Number.isInteger(mySeat) || mySeat < 0 || mySeat >= seatCount
    || participantCount < 1
    || [...expectedSeats].some((seat) => !Number.isInteger(seat) || seat < 0 || seat >= seatCount)
    || expectedSeats.size !== seatByPeer.size
    || (authorityEpoch !== undefined && !authorityEpoch)
  ) {
    onError?.('洗牌参与者映射无效')
    return
  }

  function validSeat(seat: number): boolean {
    return Number.isInteger(seat) && seat >= 0 && seat < seatCount && expectedSeats.has(seat)
  }

  function fail(reason: string) {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    onError?.(reason)
  }

  function checkCommitPhase() {
    if (commitments.size < participantCount || revealed || finished) return
    revealed = true
    room.send({
      type: 'shuffle_reveal',
      roundId,
      seat: mySeat,
      seed: seeds.get(mySeat) ?? '',
      ...(authorityEpoch ? { authorityEpoch } : {}),
    } satisfies ShuffleRevealMessage)
    checkRevealPhase()
  }

  async function checkRevealPhase() {
    if (seeds.size < participantCount || finished) return
    // 校验所有承诺
    const entries = [...commitments.entries()].sort((a, b) => a[0] - b[0])
    for (const [seat, commitment] of entries) {
      const seed = seeds.get(seat) ?? ''
      if ((await hashSeed(`${seat}:${seed}`)) !== commitment) {
        fail(`洗牌校验失败（seat ${seat} 承诺不一致）`)
        return
      }
    }
    const combined = combineSeeds(entries.map(([seat, seed]) => `${seat}:${seed}`))
    finished = true
    onComplete(shuffleTiles(tiles, combined), deriveDice(`${combined}:first`), deriveDice(`${combined}:second`))
  }

  const timeout = setTimeout(() => {
    // 本地承诺可能仍在异步 hash 中；超时恢复只针对远端参与者，不能把
    // 自己也报告成“掉线座位”，否则房主会得到误导性的缺席名单。
    onTimeout?.([...expectedSeats].filter((seat) => seat !== mySeat && !commitments.has(seat)))
    fail(`洗牌承诺超时（${timeoutMs}ms 内未完成）`)
  }, timeoutMs)

  room.onMessage((message, fromPeerId) => {
    if (finished || typeof fromPeerId !== 'string') return
    if (isCommit(message)) {
      if (message.roundId !== roundId || !validSeat(message.seat)) return
      // 首局没有房主引擎代次时，也不能接受带着其它代次的迟到消息；
      // 后续局则必须精确匹配当前代次。否则旧 Room 的承诺可能混入新屏障。
      if (authorityEpoch ? message.authorityEpoch !== authorityEpoch : message.authorityEpoch !== undefined) return
      if (seatByPeer.get(fromPeerId) !== message.seat) {
        fail(`洗牌承诺来源与座位不匹配（peer ${fromPeerId}）`)
        return
      }
      const previous = commitments.get(message.seat)
      if (previous && previous !== message.commitment) {
        fail(`洗牌承诺重复且内容冲突（seat ${message.seat}）`)
        return
      }
      commitments.set(message.seat, message.commitment)
      checkCommitPhase()
    } else if (isReveal(message)) {
      if (message.roundId !== roundId || !validSeat(message.seat)) return
      if (authorityEpoch ? message.authorityEpoch !== authorityEpoch : message.authorityEpoch !== undefined) return
      if (seatByPeer.get(fromPeerId) !== message.seat) {
        fail(`洗牌揭晓来源与座位不匹配（peer ${fromPeerId}）`)
        return
      }
      const previous = seeds.get(message.seat)
      if (previous && previous !== message.seed) {
        fail(`洗牌揭晓重复且内容冲突（seat ${message.seat}）`)
        return
      }
      seeds.set(message.seat, message.seed)
      void checkRevealPhase()
    }
  })

  void (async () => {
    const mySeed = randomSeed()
    if (!mySeed || !validSeat(mySeat) || seatByPeer.get(room.peerId) !== mySeat) {
      fail('洗牌本地座位映射无效')
      return
    }
    seeds.set(mySeat, mySeed)
    const myCommitment = await hashSeed(`${mySeat}:${mySeed}`)
    if (finished) return
    commitments.set(mySeat, myCommitment)
    room.send({
      type: 'shuffle_commit',
      roundId,
      seat: mySeat,
      commitment: myCommitment,
      ...(authorityEpoch ? { authorityEpoch } : {}),
    } satisfies ShuffleCommitMessage)
    checkCommitPhase()
  })()
}
