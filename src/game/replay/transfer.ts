// 联机牌谱传输核心（纯逻辑，不碰 SDK）：
// 房主把一局/一场的**全知牌谱**发给所有玩家，各自存本地。
//
// 为什么不用传输层自带的 `sendChunked`：它只负责"大包切分"，任一分片丢失就整包丢弃，
// 且发送方无从得知（AGENTS.md 记录过 45KB 快照被切成 12 片后在订阅者处静默丢弃）。
// 因此这里在它之上做三层保险：
//   1) 发送方按固定大小**自己切片**（每片消息远小于传输层 4000 字节上限，不触发自动分片）；
//   2) 收到完整切片后校验**字节数与 SHA-256**，不合规就当作没收全；
//   3) 收方按缺失索引**回执**，发送方只补发缺失片（有限次重试）。
import { REPLAY_SCHEMA_VERSION } from './types'

/** 每片携带的 base64 字符数：加上协议头后仍远小于传输层 4000 字节上限。 */
export const REPLAY_SLICE_CHARS = 2_400
/** 发送方补发上限（超过就放弃该局，不无限重试）。 */
export const REPLAY_MAX_RETRIES = 3

export type ReplayPayloadKind = 'round' | 'match' | 'analysis'
export type ReplayPayloadCodec = 'gzip' | 'raw'

/** 清单：先广播这个小包，收方据此知道要收多少片、校验什么。 */
export interface ReplayManifest {
  /** 本次传输的稳定 id（同一份牌谱重复发送时相同，收方据此去重）。 */
  id: string
  payloadKind: ReplayPayloadKind
  matchId: string
  roundIndex?: number
  codec: ReplayPayloadCodec
  /** 原始载荷字节数（压缩前）。 */
  bytes: number
  /** 压缩后数据的 SHA-256 十六进制（无 subtle 时退化为 FNV-1a 标记）。 */
  sha: string
  /** 分片总数。 */
  total: number
  /** 生成该清单时使用的片长：发送方必须按它切片（避免"清单说 N 片、实际切成 M 片"）。 */
  sliceChars: number
  /** 载荷格式版本，供收方判定兼容性。 */
  schemaVersion: number
}

export interface EncodedReplayPayload {
  manifest: ReplayManifest
  /** 完整载荷的 base64（切片前）。 */
  base64: string
}

export interface ReplaySliceMessage {
  id: string
  index: number
  total: number
  data: string
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** FNV-1a：无 SubtleCrypto 环境（老浏览器/受限上下文）下的退化校验。 */
function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`
}

async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return fnv1a(bytes)
  try {
    const buffer = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
    return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return fnv1a(bytes)
  }
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream
  if (!Compression) return null
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new Compression('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream
  if (!Decompression) return null
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new Decompression('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

/** 打包一份牌谱：JSON →（可选 gzip）→ base64 与清单。 */
export async function encodeReplayPayload(
  payloadKind: ReplayPayloadKind,
  value: unknown,
  identity: { id: string; matchId: string; roundIndex?: number },
  options: { sliceChars?: number; schemaVersion?: number } = {},
): Promise<EncodedReplayPayload> {
  const raw = encodeText(JSON.stringify(value))
  const compressed = await gzip(raw)
  const body = compressed ?? raw
  const base64 = toBase64(body)
  const sliceChars = Math.max(1, Math.floor(options.sliceChars ?? REPLAY_SLICE_CHARS))
  return {
    manifest: {
      id: identity.id,
      payloadKind,
      matchId: identity.matchId,
      roundIndex: identity.roundIndex,
      codec: compressed ? 'gzip' : 'raw',
      bytes: raw.length,
      sha: await digest(body),
      total: Math.max(1, Math.ceil(base64.length / sliceChars)),
      sliceChars,
      // 载荷格式版本由调用方给出：分析复现数据与展示牌谱的版本线各自独立（§6、§9.3）
      schemaVersion: options.schemaVersion ?? REPLAY_SCHEMA_VERSION,
    },
    base64,
  }
}

/** 解码失败原因。 */
export type DecodeFailureReason = 'sha-mismatch' | 'codec-unsupported' | 'parse-failed' | 'length-mismatch'

/** 解码结果：成功时 value 有效、error 为 null；失败时相反。 */
export interface DecodeResult {
  value: unknown
  error: DecodeFailureReason | null
}

/** 校验并解码完整载荷；任何校验不过都返回失败原因，由调用方决定是否回执补发。 */
export async function decodeReplayPayload(manifest: ReplayManifest, base64: string): Promise<DecodeResult> {
  let body: Uint8Array
  try {
    body = fromBase64(base64)
  } catch {
    return { value: undefined, error: 'parse-failed' }
  }
  if (await digest(body) !== manifest.sha) return { value: undefined, error: 'sha-mismatch' }
  let raw: Uint8Array | null = body
  if (manifest.codec === 'gzip') {
    raw = await gunzip(body)
    if (!raw) return { value: undefined, error: 'codec-unsupported' }
  }
  if (raw.length !== manifest.bytes) return { value: undefined, error: 'length-mismatch' }
  try {
    return { value: JSON.parse(decodeText(raw)), error: null }
  } catch {
    return { value: undefined, error: 'parse-failed' }
  }
}

/** 按清单切片：发送方一律用它，保证片数与清单一致（生产走默认片长，测试用清单自带片长）。 */
export function sliceForManifest(manifest: ReplayManifest, base64: string): ReplaySliceMessage[] {
  return sliceReplayPayload(base64, manifest.sliceChars).map((slice) => ({ ...slice, id: manifest.id }))
}

/** 按清单切片（发送方每次补发都从同一份 base64 重新切片，保证片内容稳定）。
 *  片长可显式指定：生产用默认值（避开传输层 4000 字节分片），测试用它构造多片/丢片场景。 */
export function sliceReplayPayload(base64: string, sliceChars: number = REPLAY_SLICE_CHARS): ReplaySliceMessage[] {
  const size = Math.max(1, Math.floor(sliceChars))
  const total = Math.max(1, Math.ceil(base64.length / size))
  const slices: ReplaySliceMessage[] = []
  for (let index = 0; index < total; index += 1) {
    slices.push({
      index,
      total,
      id: '',
      data: base64.slice(index * size, (index + 1) * size),
    })
  }
  return slices
}

/** 收方会话：记录已收分片，给出缺失索引；同 id 重复投递幂等。 */
export interface ReplayReceiveSession {
  manifestId: string
  total: number
  parts: Array<string | null>
  receivedAt: number
}

export function createReceiveSession(manifest: ReplayManifest, receivedAt: number): ReplayReceiveSession {
  return { manifestId: manifest.id, total: manifest.total, parts: new Array(manifest.total).fill(null), receivedAt }
}

export interface AcceptSliceResult {
  /** 本次是否收全。 */
  complete: boolean
  /** 尚未收到的分片索引。 */
  missing: number[]
  /** 收全时的完整 base64。 */
  base64?: string
}

export function acceptReplaySlice(session: ReplayReceiveSession, slice: ReplaySliceMessage): AcceptSliceResult {
  if (slice.total === session.total && slice.index >= 0 && slice.index < session.total) {
    session.parts[slice.index] = slice.data
  }
  const missing: number[] = []
  for (let index = 0; index < session.total; index += 1) {
    if (session.parts[index] == null) missing.push(index)
  }
  return {
    complete: missing.length === 0,
    missing,
    base64: missing.length === 0 ? session.parts.join('') : undefined,
  }
}

/** 收方回执：告诉房主还缺哪些片（空数组表示已收全）。 */
export interface ReplayAckMessage {
  id: string
  missing: number[]
  /** 第几次回执（房主据此限制补发次数）。 */
  attempt: number
}

/** 会话过期判定（收方清理半截会话，避免内存泄漏）。 */
export function isReceiveSessionExpired(session: ReplayReceiveSession, now: number, ttlMs = 120_000): boolean {
  return now - session.receivedAt > ttlMs
}
