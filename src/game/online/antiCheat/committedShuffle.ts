// 承诺洗牌（Phase 4 反作弊威慑）：多方先提交「种子承诺」、再揭晓种子，共同确定性派生
// 牌墙与骰点，防止房主单方面控制洗牌/骰点。诚实说明：这防「做牌/控骰」，不防「看牌」——
// 房主最终要拿整副墙发牌，发完即全知，这是 P2P 暗牌博弈的物理上限。
//
// 协议：
// 1. 每家生成种子 sᵢ，广播承诺 cᵢ = hash(seat: sᵢ)
// 2. 收齐所有承诺后各自揭晓 sᵢ
// 3. 校验每个 hash 与承诺一致，用 combineSeeds 派生墙与骰点
import type { TileType } from '../../core/contracts/types'

export interface ShuffleCommitMessage { type: 'shuffle_commit'; seat: number; commitment: string }
export interface ShuffleRevealMessage { type: 'shuffle_reveal'; seat: number; seed: string }

function isCommit(message: unknown): message is ShuffleCommitMessage {
  return typeof message === 'object' && message !== null
    && (message as { type?: unknown }).type === 'shuffle_commit'
}

function isReveal(message: unknown): message is ShuffleRevealMessage {
  return typeof message === 'object' && message !== null
    && (message as { type?: unknown }).type === 'shuffle_reveal'
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
  seatCount: number
  mySeat: number
  tiles: readonly TileType[]
  onComplete: (wall: TileType[], dice: [number, number]) => void
  onError?: (reason: string) => void
  randomSeed?: () => string
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
  const { room, seatCount, mySeat, tiles, onComplete, onError, randomSeed = defaultRandomSeed } = options
  const commitments = new Map<number, string>()
  const seeds = new Map<number, string>()
  let revealed = false

  function fail(reason: string) {
    onError?.(reason)
  }

  function checkCommitPhase() {
    if (commitments.size < seatCount || revealed) return
    revealed = true
    room.send({ type: 'shuffle_reveal', seat: mySeat, seed: seeds.get(mySeat) ?? '' } satisfies ShuffleRevealMessage)
    checkRevealPhase()
  }

  async function checkRevealPhase() {
    if (seeds.size < seatCount) return
    // 校验所有承诺
    const entries = [...commitments.entries()].sort((a, b) => a[0] - b[0])
    for (const [seat, commitment] of entries) {
      const seed = seeds.get(seat) ?? ''
      if ((await hashSeed(`${seat}:${seed}`)) !== commitment) {
        fail(`洗牌校验失败（seat ${seat} 承诺不一致）`)
        return
      }
    }
    const combined = combineSeeds(entries.map(([, seed]) => seed))
    onComplete(shuffleTiles(tiles, combined), deriveDice(combined))
  }

  room.onMessage((message) => {
    if (isCommit(message)) {
      commitments.set(message.seat, message.commitment)
      checkCommitPhase()
    } else if (isReveal(message)) {
      seeds.set(message.seat, message.seed)
      void checkRevealPhase()
    }
  })

  void (async () => {
    const mySeed = randomSeed()
    seeds.set(mySeat, mySeed)
    const myCommitment = await hashSeed(`${mySeat}:${mySeed}`)
    commitments.set(mySeat, myCommitment)
    room.send({ type: 'shuffle_commit', seat: mySeat, commitment: myCommitment } satisfies ShuffleCommitMessage)
    checkCommitPhase()
  })()
}
