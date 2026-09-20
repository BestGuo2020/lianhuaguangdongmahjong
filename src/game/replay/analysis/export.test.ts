import { describe, expect, it } from 'vitest'
import {
  analysisExportFilename, analysisFormatReadable, analysisFormatVersionOf, buildAnalysisExport,
} from './export'
import { ANALYSIS_FORMAT_VERSION, type AnalysisAreaStatus } from './types'
import type { AnalysisBlockPart } from './codec'
import type { ReplayMatch, ReplayRound } from '../types'

// 分析包导出（§9.2、§9.3、§9.5、§10.7）的验收点：
// 1. 自包含：分析记录 + 被引用的配置 + 展示回放（公开字段的唯一来源）三者缺一不可；
// 2. 引用闭合可机器判定（记录引用到的配置都能在包里找到）；
// 3. 不谎称完整：缺记录／缺复现数据时 reproductionCapable 为 false，并如实列出缺什么；
// 4. 格式版本可读性：更高版本明确报"无法识别"，不按当前格式硬解。

const match: ReplayMatch = {
  id: 'm-1', rulesetId: 'lotus-blood-flow', rulesetName: '莲花麻将·血流', matchName: '东风场',
  themeName: 'jade', gameMode: 'local', humanSeat: 0, roundCount: 1, status: 'finished',
  myRank: 1, startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
} as ReplayMatch

const round = { roundIndex: 0, steps: [] } as unknown as ReplayRound

const config = { id: 'config/m-1/1', formatVersion: ANALYSIS_FORMAT_VERSION, rulesVersion: 'v1' }
const parts: AnalysisBlockPart[] = [
  { tag: 'config', value: config },
  { tag: 'decisionState', value: { id: 'state/1' } },
  { tag: 'decision', value: { id: 'decision/1', configId: 'config/m-1/1' } },
  { tag: 'reproduction', value: { roundIndex: 1, available: true } },
]

function build(overrides: Partial<Parameters<typeof buildAnalysisExport>[0]> = {}) {
  return buildAnalysisExport({
    match, rounds: [round], parts, configurations: [config], status: 'complete' as AnalysisAreaStatus,
    exportedAt: 1_700_000_200_000, ...overrides,
  })
}

describe('分析包导出（§9.2、§9.3、§9.5）', () => {
  it('自包含：记录、被引用的配置、展示回放三者都在包里，且引用判定为闭合', () => {
    const payload = build()
    expect(payload.kind).toBe('lianhua-analysis')
    expect(payload.schemaVersion).toBe(ANALYSIS_FORMAT_VERSION)
    expect(payload.records).toHaveLength(4)
    expect(payload.configurations).toEqual([config])
    // §9.3：公开字段的唯一来源是展示回放 —— 包里必须带上它，否则读方无法还原公开局面
    expect(payload.manifest.includesReplay).toBe(true)
    expect(payload.replay.rounds).toHaveLength(1)
    expect(payload.replay.match.id).toBe('m-1')
    expect(payload.manifest.configReferencesClosed).toBe(true)
    expect(payload.manifest.records).toEqual({ config: 1, decisionState: 1, decision: 1, reproduction: 1 })
    expect(payload.reproductionCapable).toBe(true)
    expect(payload.manifest.missing).toEqual([])
  })

  it('配置没带进包 ⇒ 引用不闭合，且明确列为缺失（不能只有 id 没有正文）', () => {
    const payload = build({ configurations: [] })
    expect(payload.manifest.configReferencesClosed).toBe(false)
    expect(payload.manifest.missing.join(' ')).toContain('config/m-1/1')
    expect(payload.reproductionCapable, '引用不闭合时不得声称可精确复现').toBe(false)
  })

  it('这场没有分析记录（未开启或已删除）⇒ 如实标注，不产出空壳包还说是完整的', () => {
    const deleted = build({ parts: [], configurations: [], status: 'deleted' })
    expect(deleted.manifest.recordsTotal).toBe(0)
    expect(deleted.completeness).toBe('missing')
    expect(deleted.reproductionCapable).toBe(false)
    expect(deleted.manifest.missing.join(' ')).toContain('分析记录')
  })

  it('完整但没有复现数据 ⇒ 不能声称可精确复现（§10.6 的前提是记录足够）', () => {
    const payload = build({ parts: parts.filter(part => part.tag !== 'reproduction') })
    expect(payload.completeness).toBe('complete')
    expect(payload.reproductionCapable).toBe(false)
    expect(payload.manifest.missing.join(' ')).toContain('复现数据')
  })

  it('部分缺失：状态与缺失范围随包带走，读完知道哪一段不可信', () => {
    const payload = build({
      status: 'partial',
      gaps: [{ scope: 'decisions', from: 10, to: 12, reason: '分析区不可用' }],
    })
    expect(payload.status).toBe('partial')
    expect(payload.completeness).toBe('partial')
    expect(payload.gaps).toEqual([{ scope: 'decisions', from: 10, to: 12, reason: '分析区不可用' }])
    expect(payload.reproductionCapable).toBe(false)
  })

  it('局按 roundIndex 升序，文件内容稳定可比对', () => {
    const later = { roundIndex: 2, steps: [] } as unknown as ReplayRound
    const earlier = { roundIndex: 1, steps: [] } as unknown as ReplayRound
    const payload = build({ rounds: [later, earlier] })
    expect(payload.replay.rounds.map(item => item.roundIndex)).toEqual([1, 2])
  })

  it('文件名与牌谱导出同风格且可区分（analysis- 前缀）', () => {
    const name = analysisExportFilename(match, 1_700_000_200_000)
    expect(name).toMatch(/^analysis-lotus-blood-flow-\d{8}-\d{4}-[0-9a-z]{0,8}\.json$/)
  })

  it('格式版本：认当前版本；更高版本明确报无法识别而不是硬解（§9.5）', () => {
    expect(analysisFormatVersionOf(parts)).toBe(ANALYSIS_FORMAT_VERSION)
    expect(analysisFormatReadable(parts).readable).toBe(true)
    const future = [{ tag: 'config', value: { id: 'config/m-1/1', formatVersion: ANALYSIS_FORMAT_VERSION + 1 } }]
    const verdict = analysisFormatReadable(future)
    expect(verdict.readable).toBe(false)
    expect(verdict.reason).toContain('高于本程序识别的')
    // 没有 config 记录（例如只剩复现数据）时不阻断读取：交给 completeness 判定
    expect(analysisFormatReadable([{ tag: 'reproduction', value: {} }])).toEqual({ readable: true, version: null, reason: null })
  })
})
