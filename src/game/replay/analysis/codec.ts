// 分析区的落库编码（方案 §9.3）：
// - 落库载荷统一用 Uint8Array，不 base64、不保存为 Blob（压缩流程内部临时用 Blob 无妨）。
// - 按未压缩 UTF-8 字节累计到目标（32–64KiB）再压缩，不逐条 gzip；局末允许写不足目标的小尾块。
// - 压缩在写事务之前完成：本模块只产出"已经准备好的块"，不碰 IndexedDB。
// - 记录编码、压缩前后字节数、校验值与序号：序号用于识别中断（§9.5），校验值用于读取时自检。
// - 解压设输出大小上限，避免畸形块把内存打爆。

/** 首版批量目标：32–64KiB 区间取中值（需按压缩比与峰值内存实测再定，见 §9.3、§9.5）。 */
export const ANALYSIS_BLOCK_TARGET_BYTES = 48 * 1024
/** 单块原始字节上限；超大回答由调用方切成多个片段，保持原文完整。 */
export const ANALYSIS_BLOCK_MAX_RAW_BYTES = 256 * 1024
/** 解压输出上限（防畸形／压缩炸弹）。 */
export const ANALYSIS_DECOMPRESS_LIMIT_BYTES = 8 * 1024 * 1024
/** 单块解压后允许的最大原始字节：超过即视为块本身不可信。 */
export const ANALYSIS_MAX_RAW_BYTES = 16 * 1024 * 1024

export type AnalysisBlockCodec = 'gzip' | 'raw'

/** 块里的记录：tag 用于读取侧分流（config／decisionState／decision／llm／settlement／reproduction）。 */
export interface AnalysisBlockPart { tag: string; value: unknown }

export interface AnalysisBlock {
  /** 块序号：同一分析流内递增，用于识别中断与缺块。 */
  sequence: number
  codec: AnalysisBlockCodec
  /** 未压缩 UTF-8 字节数（不是 JS 字符串长度）。 */
  rawBytes: number
  /** 实际落库字节数。 */
  storedBytes: number
  /** 存储字节的校验值（FNV-1a；表内自检足够，不做密码学用途）。 */
  checksum: string
  /** 块内记录条数。 */
  parts: number
  payload: Uint8Array
}

/** UTF-8 字节长度：容量记账必须用它，不能用字符串长度（§9.1）。 */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`
}

function compressionAvailable(): boolean {
  return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function'
    && typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === 'function'
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!compressionAvailable()) return null
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream()
      .pipeThrough(new CompressionStream('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

async function gunzipBytes(bytes: Uint8Array, limitBytes: number): Promise<Uint8Array | null> {
  if (!compressionAvailable()) return null
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream()
      .pipeThrough(new DecompressionStream('gzip'))
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limitBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
    return out
  } catch {
    return null
  }
}

/** 配置指纹：同一份配置恒等，内容变化即变化（用于 §3.1 的 rules/ai 指纹）。 */
export function fingerprintOf(value: unknown): string {
  return fnv1a(new TextEncoder().encode(JSON.stringify(value ?? null)))
}

export interface AnalysisBlockWriter {
  /** 追加一条记录；达到目标后 shouldFlush() 为真，由调用方在合适时机刷盘。 */
  push(part: AnalysisBlockPart): void
  shouldFlush(): boolean
  /** 未达目标也可刷尾块；没有待写记录时返回 null。 */
  flush(sequence: number): Promise<AnalysisBlock | null>
  /** 待写记录的未压缩字节数（用于队列与预算判断）。 */
  pendingBytes(): number
  pendingParts(): number
}

/**
 * 按目标字节数分批的写入器。
 * 刻意不自动压缩：压缩是异步且可能失败，必须发生在写事务之前、由调用方决定时机（§9.3）。
 */
export function createAnalysisBlockWriter(options: { targetBytes?: number } = {}): AnalysisBlockWriter {
  const target = Math.max(1, options.targetBytes ?? ANALYSIS_BLOCK_TARGET_BYTES)
  let parts: AnalysisBlockPart[] = []
  let bytes = 0

  return {
    push(part) {
      parts.push(part)
      bytes += utf8Bytes(JSON.stringify(part))
    },
    shouldFlush() {
      return bytes >= target
    },
    async flush(sequence) {
      if (!parts.length) return null
      const json = JSON.stringify(parts)
      const raw = new TextEncoder().encode(json)
      const compressed = await gzipBytes(raw)
      const payload = compressed ?? raw
      const block: AnalysisBlock = {
        sequence,
        codec: compressed ? 'gzip' : 'raw',
        rawBytes: raw.byteLength,
        storedBytes: payload.byteLength,
        checksum: fnv1a(payload),
        parts: parts.length,
        payload,
      }
      parts = []
      bytes = 0
      return block
    },
    pendingBytes() { return bytes },
    pendingParts() { return parts.length },
  }
}

/** 解码失败原因。 */
export type AnalysisDecodeError = 'checksum-mismatch' | 'codec-unsupported' | 'too-large' | 'parse-failed'

/**
 * 解码结果：成功时 parts 有效、error 为 null；失败时相反。
 * 刻意不用判别联合：本工具链对 `await` 之后的联合收窄不可靠（仓库里 transfer.ts 同此约定）。
 */
export interface AnalysisDecodeResult {
  parts: AnalysisBlockPart[] | null
  error: AnalysisDecodeError | null
}

export function verifyAnalysisBlock(block: AnalysisBlock): boolean {
  return block.payload.byteLength === block.storedBytes && fnv1a(block.payload) === block.checksum
}

/**
 * 读取侧：先校验再解压，解压限长；返回块内记录。
 * `limitBytes` 可供调用方收紧（例如列表页只读元数据时用小上限）。
 * 不做"部分可用"的容错——记录不完整时必须由调用方标记缺失，而不是悄悄少几条（§9.5）。
 */
export async function decodeAnalysisBlock(
  block: AnalysisBlock,
  options: { limitBytes?: number } = {},
): Promise<AnalysisDecodeResult> {
  const limit = Math.max(1, options.limitBytes ?? ANALYSIS_DECOMPRESS_LIMIT_BYTES)
  if (!verifyAnalysisBlock(block)) return { parts: null, error: 'checksum-mismatch' }
  // raw 块本来就要读进内存，超限直接拒绝；gzip 块在流式解压时按 limit 截断。
  if (block.rawBytes > ANALYSIS_MAX_RAW_BYTES) return { parts: null, error: 'too-large' }
  if (block.codec === 'raw' && block.payload.byteLength > limit) return { parts: null, error: 'too-large' }
  let raw: Uint8Array | null = block.payload
  if (block.codec === 'gzip') {
    raw = await gunzipBytes(block.payload, limit)
    if (!raw) return { parts: null, error: compressionAvailable() ? 'too-large' : 'codec-unsupported' }
  }
  if (raw.byteLength !== block.rawBytes) return { parts: null, error: 'checksum-mismatch' }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown
    if (!Array.isArray(parsed)) return { parts: null, error: 'parse-failed' }
    return { parts: parsed as AnalysisBlockPart[], error: null }
  } catch {
    return { parts: null, error: 'parse-failed' }
  }
}

/** 压缩不可用或失败时的降级判定：原始块只在预算与队列限制内才允许保存（§9.3）。 */
export function mayStoreRawBlock(block: AnalysisBlock, options: { rawBudgetBytes: number }): boolean {
  return block.codec === 'raw' && block.storedBytes <= Math.max(0, options.rawBudgetBytes)
}
