import { afterEach, describe, expect, it } from 'vitest'
import {
  ANALYSIS_BLOCK_TARGET_BYTES,
  createAnalysisBlockWriter,
  decodeAnalysisBlock,
  mayStoreRawBlock,
  utf8Bytes,
  verifyAnalysisBlock,
  type AnalysisBlock,
} from './codec'

// 分析区的落库编码（方案 §9.3）：分批目标、压缩、字节记账、校验、解压限长、降级判定。
// 这些断言都要能在 Node 下确定性跑通（CompressionStream 在 Node 20+ 可用；用临时摘除模拟不可用）。

const originalCompression = (globalThis as { CompressionStream?: unknown }).CompressionStream
const originalDecompression = (globalThis as { DecompressionStream?: unknown }).DecompressionStream

afterEach(() => {
  ;(globalThis as { CompressionStream?: unknown }).CompressionStream = originalCompression
  ;(globalThis as { DecompressionStream?: unknown }).DecompressionStream = originalDecompression
})

function withoutCompression() {
  ;(globalThis as { CompressionStream?: unknown }).CompressionStream = undefined
  ;(globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined
}

const decisionPart = (index: number) => ({
  tag: 'decision',
  value: {
    id: `d${index}`, seat: index % 4, windowKind: 'draw-turn',
    candidates: Array.from({ length: 8 }, (_, k) => ({ legalActionId: `a${k}`, action: { id: `a${k}`, kind: 'discard', tile: 'm5', handIndex: k } })),
  },
})

describe('分析块编码', () => {
  it('按 UTF-8 字节累计到目标后提示刷盘，并保留未达目标的尾块', async () => {
    const writer = createAnalysisBlockWriter({ targetBytes: 2_000 })
    expect(writer.shouldFlush()).toBe(false)
    let pushed = 0
    while (!writer.shouldFlush() && pushed < 200) { writer.push(decisionPart(pushed)); pushed += 1 }
    expect(writer.shouldFlush()).toBe(true)
    expect(writer.pendingBytes()).toBeGreaterThanOrEqual(2_000)
    const block = await writer.flush(1)
    expect(block).not.toBeNull()
    expect(block!.sequence).toBe(1)
    expect(block!.parts).toBe(pushed)
    expect(block!.rawBytes).toBeGreaterThanOrEqual(2_000)
    // 刷盘后清空
    expect(writer.pendingParts()).toBe(0)
    expect(writer.pendingBytes()).toBe(0)
    expect(await writer.flush(2)).toBeNull()
  })

  it('默认目标落在文档要求的 32–64KiB 区间', () => {
    expect(ANALYSIS_BLOCK_TARGET_BYTES).toBeGreaterThanOrEqual(32 * 1024)
    expect(ANALYSIS_BLOCK_TARGET_BYTES).toBeLessThanOrEqual(64 * 1024)
  })

  it('往返一致：记录顺序与内容不变，且 compressed 不大于原始字节', async () => {
    const writer = createAnalysisBlockWriter()
    for (let index = 0; index < 40; index += 1) writer.push(decisionPart(index))
    writer.push({ tag: 'config', value: { id: 'c1', rulesVersion: 'lotus-blood-flow-v1', seatControl: ['human', 'llm', 'llm', 'local-ai'] } })
    const block = await writer.flush(7) as AnalysisBlock
    expect(['gzip', 'raw']).toContain(block.codec)
    expect(block.storedBytes).toBeLessThanOrEqual(block.rawBytes)
    const decoded = await decodeAnalysisBlock(block)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.parts).toHaveLength(41)
    expect(decoded.parts[0]).toMatchObject({ tag: 'decision' })
    expect(decoded.parts[40]).toMatchObject({ tag: 'config' })
    expect((decoded.parts[39].value as { id: string }).id).toBe('d39')
  })

  it('字节记账用 UTF-8 字节数，不是字符串长度（中文/表情）', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect('中文'.length).toBe(2)
    expect(utf8Bytes('中文')).toBe(6)
    expect(utf8Bytes('🀄')).toBe(4)
  })

  it('校验值能发现被篡改或截断的块', async () => {
    const writer = createAnalysisBlockWriter()
    writer.push(decisionPart(1))
    const block = await writer.flush(1) as AnalysisBlock
    expect(verifyAnalysisBlock(block)).toBe(true)

    const tampered: AnalysisBlock = { ...block, payload: Uint8Array.from([...block.payload].map((byte, index) => index === 2 ? byte ^ 0xff : byte)) }
    expect(verifyAnalysisBlock(tampered)).toBe(false)
    expect(await decodeAnalysisBlock(tampered)).toEqual({ ok: false, reason: 'checksum-mismatch' })

    const truncated: AnalysisBlock = { ...block, payload: block.payload.subarray(0, Math.max(1, block.payload.byteLength - 3)) }
    expect(verifyAnalysisBlock(truncated)).toBe(false)
    expect(await decodeAnalysisBlock(truncated)).toEqual({ ok: false, reason: 'checksum-mismatch' })
  })

  it('压缩不可用时退化为 raw 块，且只在预算内才允许保存', async () => {
    withoutCompression()
    const writer = createAnalysisBlockWriter()
    writer.push(decisionPart(1))
    const block = await writer.flush(3) as AnalysisBlock
    expect(block.codec).toBe('raw')
    expect(block.rawBytes).toBe(block.storedBytes)
    const decoded = await decodeAnalysisBlock(block)
    expect(decoded.ok).toBe(true)
    // raw 块只在字节预算内允许保存：超预算时必须由调用方暂停分析录制（§9.3）
    expect(mayStoreRawBlock(block, { rawBudgetBytes: block.storedBytes + 10 })).toBe(true)
    expect(mayStoreRawBlock(block, { rawBudgetBytes: block.storedBytes - 1 })).toBe(false)
    // gzip 块不受 raw 预算判定约束（它已经是压缩后的落库字节）
    expect(mayStoreRawBlock({ ...block, codec: 'gzip' }, { rawBudgetBytes: 0 })).toBe(false)
  })

  it('压缩块在解压能力缺失时明确报 codec-unsupported，不静默返回空', async () => {
    const writer = createAnalysisBlockWriter()
    writer.push(decisionPart(1))
    const block = await writer.flush(1) as AnalysisBlock
    if (block.codec !== 'gzip') return   // 环境本就没有压缩能力时该用例不适用
    ;(globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined
    expect(await decodeAnalysisBlock(block)).toEqual({ ok: false, reason: 'codec-unsupported' })
  })

  it('解压输出超限时拒绝，不把内存打爆', async () => {
    const writer = createAnalysisBlockWriter()
    // 重复内容使 gzip 后很小，但解压后很大
    for (let index = 0; index < 60; index += 1) writer.push({ tag: 'llm', value: { text: '胡'.repeat(4_000) } })
    const block = await writer.flush(1) as AnalysisBlock
    expect(block.rawBytes).toBeGreaterThan(100_000)
    // 正常上限下可读
    expect((await decodeAnalysisBlock(block)).ok).toBe(true)
    // 收紧上限到远小于解压长度：必须拒绝，且原因明确（不是静默返回空记录）
    expect(await decodeAnalysisBlock(block, { limitBytes: 10_000 })).toEqual({ ok: false, reason: 'too-large' })
    if (block.codec === 'raw') return
    // 上限刚好等于原始长度时仍可读（边界）
    expect((await decodeAnalysisBlock(block, { limitBytes: block.rawBytes })).ok).toBe(true)
  })
})
