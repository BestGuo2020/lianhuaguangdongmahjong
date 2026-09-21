// 容量基线（方案 §9.1、§10.11）：把一场对局的各类字节**分开**报出来，供上线前定预算。
//
// 设计对这份报告的要求（逐条落实，避免混口径）：
// - 无缩进 JSON 的**字符串长度**要注明是 JavaScript UTF-16 码元数，并同时给出 UTF-8 字节（§9.1）；
// - 展示回放、分析块、索引／元数据分别列出，不把不同来源乘同一个压缩率；
// - 各分析块 gzip 后字节及汇总、应用落库字节账本、导出包实际字节都要有；
// - 浏览器 `estimate()` 的读数标注为**同源估算**，不能冒充本应用的逐块账本；
// - 没有数据库级实测接口的项填「不可得」，不编数字（例：IDB 索引与页开销）。
//
// 纯函数 + 一个格式化函数；浏览器侧的数据采集由 e2e（analysis-probe）负责。

import type { AnalysisBlockPart } from './codec'
import { utf8Bytes } from './codec'

export interface CapacityBlockMeta {
  sequence: number
  codec: 'gzip' | 'raw'
  /** 未压缩字节。 */
  rawBytes: number
  /** 实际落库字节。 */
  storedBytes: number
  parts: number
}

export interface CapacityInput {
  /** 分析记录（已解码）。 */
  parts: readonly AnalysisBlockPart[]
  /** 分析区落库的分块元数据（不含 payload）。 */
  blocks: readonly CapacityBlockMeta[]
  /** 应用账本：分析区的字节与场次数（storage.usage() 或 matches 表汇总）。 */
  ledger: { bytes: number; matches: number }
  /** 这场有几局（东 4／半庄 8）。 */
  rounds: number
  /** 场次元数据（用于估算索引／元数据字节）；没有就填 null。 */
  metas?: readonly unknown[] | null
  /** 导出自包含分析包后的实际字节（JSON 文本的 UTF-8 字节）。 */
  exportBytes?: number | null
  /** 展示回放的字节（各局 JSON 之和）；没有就填 null。 */
  replayBytes?: number | null
  /** `navigator.storage.estimate()` 的读数（同源估算）。 */
  estimate?: { usage: number; quota: number } | null
  /** 存储持久化状态文案（§9.4）。 */
  persistence?: string | null
}

export interface CapacityReport {
  rounds: number
  analysis: {
    parts: number
    byTag: Record<string, number>
    /** 无缩进 JSON 的 JavaScript UTF-16 码元数（`String.length`）。 */
    jsonUtf16Units: number
    /** 同一份 JSON 的 UTF-8 字节。 */
    jsonUtf8Bytes: number
    blocks: number
    rawBytes: number
    storedBytes: number
    /** 压缩比（stored/raw）；无 gzip 块时为 null。 */
    gzipRatio: number | null
    codecs: string[]
  }
  /** 分析区应用账本（逐块累计，不是浏览器物理占用）。 */
  ledger: { bytes: number; matches: number; perMatchBytes: number }
  /** 索引／元数据：只有元数据 JSON 能测，IDB 索引与页开销标记为不可得。 */
  metadata: { jsonUtf8Bytes: number | null; idbIndexOverhead: 'not-measurable' }
  replay: { bytes: number | null }
  export: { bytes: number | null; ratioToAnalysisStored: number | null }
  browserEstimate: { usage: number; quota: number; note: string } | null
  persistence: string | null
  /** 按本场线性推算的规模（**推算**，不是保证；见 §9.4 的说明）。 */
  projections: { fiftyMatchesBytes: number; twoHundredMatchesBytes: number }
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

export function buildCapacityReport(input: CapacityInput): CapacityReport {
  const byTag: Record<string, number> = {}
  for (const part of input.parts) byTag[part.tag] = (byTag[part.tag] ?? 0) + 1
  // 无缩进 JSON：与分析区落库前的分块口径一致（§9.1 要求注明是 UTF-16 码元数）
  const json = JSON.stringify(input.parts)
  const rawBytes = sum(input.blocks.map(block => block.rawBytes))
  const storedBytes = sum(input.blocks.map(block => block.storedBytes))
  const gzipBlocks = input.blocks.filter(block => block.codec === 'gzip')
  const metadataBytes = input.metas ? utf8Bytes(JSON.stringify(input.metas)) : null
  const perMatchBytes = input.ledger.matches > 0 ? input.ledger.bytes / input.ledger.matches : input.ledger.bytes
  return {
    rounds: input.rounds,
    analysis: {
      parts: input.parts.length,
      byTag,
      jsonUtf16Units: json.length,
      jsonUtf8Bytes: utf8Bytes(json),
      blocks: input.blocks.length,
      rawBytes,
      storedBytes,
      gzipRatio: gzipBlocks.length && rawBytes > 0 ? storedBytes / rawBytes : null,
      codecs: [...new Set(input.blocks.map(block => block.codec))],
    },
    ledger: { bytes: input.ledger.bytes, matches: input.ledger.matches, perMatchBytes },
    metadata: { jsonUtf8Bytes: metadataBytes, idbIndexOverhead: 'not-measurable' },
    replay: { bytes: input.replayBytes ?? null },
    export: {
      bytes: input.exportBytes ?? null,
      ratioToAnalysisStored: input.exportBytes && storedBytes > 0 ? input.exportBytes / storedBytes : null,
    },
    browserEstimate: input.estimate
      ? { usage: input.estimate.usage, quota: input.estimate.quota, note: '同源估算（不是本应用账本）' }
      : null,
    persistence: input.persistence ?? null,
    projections: {
      fiftyMatchesBytes: Math.round(perMatchBytes * 50),
      twoHundredMatchesBytes: Math.round(perMatchBytes * 200),
    },
  }
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)}MB`

/** 人读报告（e2e/离线工具直接打印；每行都标清口径）。 */
export function formatCapacityReport(report: CapacityReport): string {
  const lines = [
    `容量基线（${report.rounds} 局）：`,
    `  分析记录 ${report.analysis.parts} 条：${Object.entries(report.analysis.byTag).map(([tag, count]) => `${tag} ${count}`).join('、')}`,
    `  无缩进 JSON：${report.analysis.jsonUtf16Units} 个 UTF-16 码元 / ${report.analysis.jsonUtf8Bytes} 字节（UTF-8）`,
    `  分块：${report.analysis.blocks} 块（${report.analysis.codecs.join('+')}）；原始 ${kb(report.analysis.rawBytes)} → 落库 ${kb(report.analysis.storedBytes)}`
      + (report.analysis.gzipRatio !== null ? `（压缩比 ${(report.analysis.gzipRatio * 100).toFixed(1)}%）` : '（未压缩块）'),
    `  应用账本：${kb(report.ledger.bytes)} / ${report.ledger.matches} 场 ⇒ 单场 ${kb(report.ledger.perMatchBytes)}`,
    `  元数据 JSON：${report.metadata.jsonUtf8Bytes === null ? '不可得' : kb(report.metadata.jsonUtf8Bytes)}；IDB 索引与页开销：不可得（无数据库级接口）`,
    `  展示回放：${report.replay.bytes === null ? '未采集' : kb(report.replay.bytes)}`,
    `  自包含导出包：${report.export.bytes === null ? '未采集' : `${kb(report.export.bytes)}（相对落库 ${(report.export.ratioToAnalysisStored ?? 0).toFixed(2)}×；导出文件带 2 空格缩进，落库分块是无缩进 JSON，两者不可混比）`}`,
    report.browserEstimate
      ? `  浏览器估算：usage ${mb(report.browserEstimate.usage)} / quota ${mb(report.browserEstimate.quota)}（${report.browserEstimate.note}）`
      : '  浏览器估算：不可得',
    report.persistence ? `  持久化状态：${report.persistence}` : '  持久化状态：未知',
    `  线性推算（不是保证）：50 场 ${mb(report.projections.fiftyMatchesBytes)}；200 场 ${mb(report.projections.twoHundredMatchesBytes)}`,
  ]
  return lines.join('\n')
}
