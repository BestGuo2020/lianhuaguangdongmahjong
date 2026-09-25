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
/**
 * 一条**内容完整**的血流口径复现数据（字段清单与 `openingFromReproduction` 对齐）。
 * P1 之后 `reproductionCapable` 按记录内容判定，所以"有 reproduction 记录"本身不再够用 ——
 * 这里的夹具必须真的带齐字段，否则测的就是"缺字段"那条分支。
 */
const reproduction = {
  roundIndex: 1, available: true,
  initialWall: ['m1'], initialHands: [[], [], [], []], dealer: 0, dealerDrawnIndex: 13,
  flipTiles: ['m1', 'm2'], jokers: ['m1', 'm2'], flipStack: 0, flipSeat: 0, wallBreakIndex: 0,
  openingScores: [2000, 2000, 2000, 2000], commands: [{ seat: 0, kind: 'discard', at: 0 }],
}
const parts: AnalysisBlockPart[] = [
  { tag: 'config', value: config },
  { tag: 'decisionState', value: { id: 'state/1' } },
  { tag: 'decision', value: { id: 'decision/1', configId: 'config/m-1/1' } },
  { tag: 'reproduction', value: reproduction },
]

function build(overrides: Partial<Parameters<typeof buildAnalysisExport>[0]> = {}) {
  return buildAnalysisExport({
    match, rounds: [round], parts, configurations: [config], status: 'complete' as AnalysisAreaStatus,
    exportedAt: 1_700_000_200_000, ...overrides,
  })
}

describe('分析包导出（§9.2、§9.3、§9.5）', () => {
  it('旧分析包再次导出时，两份场次元数据都修正点炮摘要', () => {
    const stale = {
      ...match,
      summary: '东4局 本家点炮（本家）',
      players: [{ seat: 0, name: '本家', avatar: '', startScore: 2000 }],
    }
    const last = {
      roundIndex: 9,
      roundLabel: '东4局',
      final: { draw: false, winSeat: 0, winType: 'discard' },
    } as ReplayRound
    const payload = build({ match: stale, rounds: [last] })
    expect(payload.match.summary).toBe('东4局 本家胡牌（本家）')
    expect(payload.replay.match.summary).toBe('东4局 本家胡牌（本家）')
    expect(stale.summary).toBe('东4局 本家点炮（本家）')
  })

  it('经典玩法的可复现不掩盖缺失的选择、来源和配置', () => {
    const classicMatch: ReplayMatch = { ...match, rulesetId: 'lotus-classic', analysisRecorded: false }
    const oldConfig = { ...config, rules: { id: 'lotus-classic' }, aiConfig: {}, seatControl: ['human', 'llm', 'llm', 'llm'] }
    const classicParts: AnalysisBlockPart[] = [
      { tag: 'config', value: oldConfig },
      { tag: 'decisionState', value: { id: '1/window/1/1', legalActions: [{ id: '1/window/1/0', kind: 'discard', tile: 'm1', handIndex: 0 }] } },
      { tag: 'decision', value: { id: 'decision/m-1/1/window/1/1', matchId: 'm-1', windowId: '1/window/1', seat: 1, configId: oldConfig.id, source: 'unknown', choice: { known: false } } },
      { tag: 'reproduction', value: {
        roundIndex: 1, available: true, variant: 'lotus-classic', ringWall: Array(136).fill('m1'),
        dice: { first: [1, 2] }, dealer: 0, openingScores: [1000, 1000, 1000, 1000],
        postDealHands: [[], [], [], []], wallBreakIndex: 0,
        commands: [{ seat: 1, kind: 'discard', at: 0, windowId: '1/window/1', legalActionId: '1/window/1/0', handIndex: 0 }],
      } },
      { tag: 'settlement', value: { roundIndex: 1, kind: 'score-flow' } },
      { tag: 'settlement', value: { roundIndex: 1, kind: 'self-draw' } },
    ]
    const payload = build({ match: classicMatch, parts: classicParts, configurations: [oldConfig] })
    expect(payload.reproductionCapable).toBe(true)
    expect(payload.completeness).toBe('partial')
    expect(payload.manifest.missing.join(' ')).toContain('实际选择未写入决策记录')
    expect(payload.manifest.missing.join(' ')).toContain('实际来源未知')
    expect(payload.manifest.missing.join(' ')).toContain('逐笔分数流水与整局净分汇总重叠')
  })

  it('翻精玩法的旧包即使可复现，也标出决策和逐笔账本缺口', () => {
    const legacyMatch: ReplayMatch = { ...match, rulesetId: 'lotus-legacy', analysisRecorded: false }
    const legacyConfig = { ...config, rules: { id: 'lotus-legacy' }, aiConfig: {}, seatControl: ['human', 'llm', 'llm', 'llm'] }
    const legacyParts: AnalysisBlockPart[] = [
      { tag: 'config', value: legacyConfig },
      { tag: 'decisionState', value: { id: 'round-1/window/1/1', fingerprint: '', legalActions: [{ id: 'round-1/window/1/0', kind: 'win' }] } },
      { tag: 'decision', value: { id: 'decision/m-1/round-1/window/1/1', matchId: 'm-1', windowId: 'round-1/window/1', seat: 1, configId: legacyConfig.id, source: 'unknown', choice: { known: false } } },
      { tag: 'llm', value: { id: 'attempt/1', outcome: 'timeout', answer: { known: true, value: { text: '' } } } },
      { tag: 'settlement', value: { roundIndex: 1, kind: 'win-discard', deltas: [-100, 300, -100, -100] } },
      { tag: 'reproduction', value: {
        roundIndex: 1, available: true, variant: 'lotus-legacy', ringWall: Array(136).fill('m1'),
        dice: { first: [1, 2], second: [3, 4] }, dealer: 0, openingScores: [2000, 2000, 2000, 2000],
        postDealHands: [[], [], [], []], jokers: ['m1', 'm2'], flipTile: 'm1', wallBreakIndex: 0,
        commands: [{ seat: 1, kind: 'win', at: 0, windowId: 'round-1/window/1', legalActionId: 'round-1/window/1/0' }],
      } },
    ]
    const payload = build({ match: legacyMatch, parts: legacyParts, configurations: [legacyConfig] })
    expect(payload.reproductionCapable).toBe(true)
    expect(payload.completeness).toBe('partial')
    const missing = payload.manifest.missing.join(' ')
    expect(missing).toContain('决策前态缺少内容指纹')
    expect(missing).toContain('缺少逐笔计分')
    expect(missing).toContain('失败的模型请求把空文本标为已知回答')
  })

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
    expect(payload.completeness).toBe('partial')
    expect(payload.reproductionCapable).toBe(false)
    expect(payload.manifest.missing.join(' ')).toContain('复现数据')
  })

  // P1（§2.4）：`reproductionCapable` 必须按**记录内容**判定，而不是"有 reproduction 记录就算齐"。
  // 两条分支都要有证据：字段齐 ⇒ true；缺字段 ⇒ false 且**点名缺什么、缺在第几局**。
  it('复现能力按记录内容判定：翻精癞子字段齐 ⇒ true（环状牌墙口径）', () => {
    const complete = {
      roundIndex: 2, available: true, variant: 'lotus-legacy',
      ringWall: Array.from({ length: 136 }, () => 'm1'),
      dice: { first: [1, 2], second: [3, 4] },
      dealer: 1, openingScores: [2000, 1900, 2100, 2000],
      postDealHands: [[], [], [], []], jokers: ['m1', 'm2'], flipTile: 'm1', wallBreakIndex: 0,
      commands: [{ seat: 1, kind: 'discard', at: 0, handIndex: 0, windowId: 'round-2/window/1' }],
    }
    const payload = build({ parts: [...parts.slice(0, 3), { tag: 'reproduction', value: complete }] })
    expect(payload.reproductionCapable, '环状牌墙口径的字段齐了就该算可复现').toBe(true)
    expect(payload.manifest.missing).toEqual([])
  })

  it('复现能力按记录内容判定：缺环状牌墙/骰子/命令 ⇒ false，并点名缺什么、第几局', () => {
    const incomplete = {
      roundIndex: 3, available: true, variant: 'lotus-legacy',
      ringWall: [], dice: {}, dealer: 0, openingScores: [],
      postDealHands: [], jokers: [], flipTile: null, commands: [],
    }
    const payload = build({ parts: [...parts.slice(0, 3), { tag: 'reproduction', value: incomplete }] })
    expect(payload.completeness).toBe('partial')
    expect(payload.reproductionCapable, '缺字段就不能声称可精确复现').toBe(false)
    const missing = payload.manifest.missing.join(' ')
    for (const field of ['ringWall', 'dice.first', 'dice.second', 'openingScores', 'commands', 'postDealHands']) {
      expect(missing, `缺失清单必须点名 ${field}`).toContain(field)
    }
    expect(missing, '必须说明缺在第几局').toContain('第 3 局')
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
