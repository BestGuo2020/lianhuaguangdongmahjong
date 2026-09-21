import { describe, expect, it } from 'vitest'
import { buildCapacityReport, formatCapacityReport } from './capacity'
import type { AnalysisBlockPart } from './codec'

// 容量基线工具（§9.1、§10.11）的验收点：口径必须分开、标注必须诚实。
// - UTF-16 码元数与 UTF-8 字节分开报（前者是 String.length，后者是落库口径）；
// - 压缩比只对 gzip 块算；没有 gzip 块时不编一个数出来；
// - 展示回放／分析块／元数据分开列；IDB 索引与页开销明确「不可得」；
// - 浏览器 estimate() 标注为同源估算；线性推算标注为推算。

const parts: AnalysisBlockPart[] = [
  { tag: 'config', value: { id: 'config/m/1', rulesVersion: 'v1' } },
  { tag: 'decisionState', value: { id: 'state/1', hand: ['m1', 'm2'] } },
  { tag: 'decision', value: { id: 'decision/1', configId: 'config/m/1' } },
  { tag: 'decision', value: { id: 'decision/2', configId: 'config/m/1' } },
  { tag: 'reproduction', value: { roundIndex: 1, commands: [] } },
]

const blocks = [
  { sequence: 1, codec: 'gzip' as const, rawBytes: 40_000, storedBytes: 8_000, parts: 3 },
  { sequence: 2, codec: 'gzip' as const, rawBytes: 10_000, storedBytes: 2_500, parts: 2 },
]

function report(overrides: Partial<Parameters<typeof buildCapacityReport>[0]> = {}) {
  return buildCapacityReport({
    parts, blocks, ledger: { bytes: 85_000, matches: 1 }, rounds: 4,
    metas: [{ matchId: 'm', parts: 5 }], exportBytes: 120_000, replayBytes: 220_000,
    estimate: { usage: 40 * 1024 * 1024, quota: 200 * 1024 * 1024 }, persistence: '未持久化（申请被拒绝，可能被浏览器回收）',
    ...overrides,
  })
}

describe('容量基线工具（§9.1、§10.11）', () => {
  it('分别报告记录条数、UTF-16 码元数、UTF-8 字节与分块压缩结果', () => {
    const built = report()
    expect(built.analysis.parts).toBe(5)
    expect(built.analysis.byTag).toEqual({ config: 1, decisionState: 1, decision: 2, reproduction: 1 })
    expect(built.analysis.jsonUtf16Units).toBe(JSON.stringify(parts).length)
    expect(built.analysis.jsonUtf8Bytes).toBeGreaterThan(0)
    expect(built.analysis.blocks).toBe(2)
    expect(built.analysis.rawBytes).toBe(50_000)
    expect(built.analysis.storedBytes).toBe(10_500)
    expect(built.analysis.gzipRatio).toBeCloseTo(10_500 / 50_000, 5)
  })

  it('没有 gzip 块时不编压缩比（填 null），并如实列出 codec', () => {
    const built = report({ blocks: [{ sequence: 1, codec: 'raw', rawBytes: 1_000, storedBytes: 1_000, parts: 5 }] })
    expect(built.analysis.gzipRatio).toBeNull()
    expect(built.analysis.codecs).toEqual(['raw'])
  })

  it('账本与元数据分开：单场字节按场次均摊，索引开销标记不可得', () => {
    const built = report({ ledger: { bytes: 170_000, matches: 2 } })
    expect(built.ledger.perMatchBytes).toBe(85_000)
    expect(built.metadata.jsonUtf8Bytes).toBeGreaterThan(0)
    expect(built.metadata.idbIndexOverhead).toBe('not-measurable')
    expect(report({ metas: null }).metadata.jsonUtf8Bytes).toBeNull()
  })

  it('浏览器估算标注为同源估算；缺失时整段为 null 而不是填 0', () => {
    expect(report().browserEstimate?.note).toContain('同源估算')
    expect(report({ estimate: null }).browserEstimate).toBeNull()
  })

  it('导出包与落库字节的关系单独给出（引用闭合的代价可量化）', () => {
    const built = report()
    expect(built.export.bytes).toBe(120_000)
    expect(built.export.ratioToAnalysisStored).toBeCloseTo(120_000 / 10_500, 4)
    expect(report({ exportBytes: null }).export.bytes).toBeNull()
  })

  it('线性推算按单场账本推算，并在文本里说明是推算', () => {
    const built = report()
    expect(built.projections.fiftyMatchesBytes).toBe(85_000 * 50)
    expect(built.projections.twoHundredMatchesBytes).toBe(85_000 * 200)
    expect(formatCapacityReport(built)).toContain('线性推算（不是保证）')
  })

  it('文本报告把每个口径都点明（UTF-16／UTF-8／压缩比／不可得）', () => {
    const text = formatCapacityReport(report())
    expect(text).toContain('UTF-16 码元')
    expect(text).toContain('UTF-8')
    expect(text).toContain('压缩比')
    expect(text).toContain('不可得')
    expect(text).toContain('同源估算')
  })

  it('空记录也能出报告（不崩、不编数字）', () => {
    const built = buildCapacityReport({ parts: [], blocks: [], ledger: { bytes: 0, matches: 0 }, rounds: 0 })
    expect(built.analysis.parts).toBe(0)
    expect(built.analysis.gzipRatio).toBeNull()
    expect(built.ledger.perMatchBytes).toBe(0)
    expect(built.export.bytes).toBeNull()
    expect(formatCapacityReport(built)).toContain('未采集')
  })
})
