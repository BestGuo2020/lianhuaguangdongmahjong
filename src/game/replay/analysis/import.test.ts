import { describe, expect, it } from 'vitest'
import { importAnalysisFile, importedAreaStatus, parseAnalysisImport } from './import'
import { analysisExportFilename, buildAnalysisExport } from './export'
import { createAnalysisStorage } from './storage'
import { createAnalysisMemoryDriver } from './idb'
import { createReplayStorage } from '../storage'
import { createMemoryDriver } from '../idb'
import { REPLAY_SCHEMA_VERSION, type ReplayMatch, type ReplayRound } from '../types'
import { ANALYSIS_FORMAT_VERSION } from './types'
import type { AnalysisBlockPart } from './codec'

// 分析包导入（§9.2、§9.3、§9.5、§10.7）：这条路径让"自包含导出"从声明变成可验证的行为 ——
// 导出 → 删库 → 导入 → 记录与配置都回来（引用闭合），且不完整包仍标 partial。

const match: ReplayMatch = {
  id: 'm-1', schemaVersion: REPLAY_SCHEMA_VERSION, rulesetId: 'lotus-blood-flow', rulesetName: '莲花麻将·血流',
  matchType: 'east', matchName: '东风场', gameMode: 'local', themeName: 'jade',
  players: [
    { seat: 0, name: 'P0', avatar: '', score: 1000, rank: 1 },
    { seat: 1, name: 'P1', avatar: '', score: 900, rank: 2 },
    { seat: 2, name: 'P2', avatar: '', score: 800, rank: 3 },
    { seat: 3, name: 'P3', avatar: '', score: 700, rank: 4 },
  ],
  humanSeat: 0, startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
  status: 'finished', roundCount: 1, summary: '',
} as unknown as ReplayMatch

const rounds = [{ id: 'm-1:1', matchId: 'm-1', roundIndex: 1, steps: [{ t: 'draw', seat: 0, tile: 'm1' }] } as unknown as ReplayRound]

const config = { id: 'config/m-1/1', formatVersion: ANALYSIS_FORMAT_VERSION, rulesVersion: 'v1' }
const parts: AnalysisBlockPart[] = [
  { tag: 'config', value: config },
  { tag: 'decisionState', value: { id: 'state/1' } },
  { tag: 'decision', value: { id: 'decision/1', configId: 'config/m-1/1' } },
  { tag: 'reproduction', value: {
    roundIndex: 1, available: true, initialWall: ['m1'], initialHands: [[], [], [], []],
    dealer: 0, dealerDrawnIndex: 13, flipTiles: ['m1', 'm2'], jokers: ['m1', 'm2'],
    flipStack: 0, flipSeat: 0, wallBreakIndex: 0, openingScores: [2000, 2000, 2000, 2000],
    commands: [{ seat: 0, kind: 'discard', at: 0, handIndex: 0 }],
  } },
]

function pack(overrides: { parts?: AnalysisBlockPart[]; configurations?: unknown[]; rounds?: ReplayRound[]; status?: 'complete' | 'partial' | 'deleted' } = {}) {
  return buildAnalysisExport({
    match,
    rounds: overrides.rounds ?? rounds,
    parts: overrides.parts ?? parts,
    configurations: overrides.configurations ?? [config],
    status: overrides.status ?? 'complete',
    exportedAt: 1_700_000_200_000,
  })
}

const memoryStores = () => ({
  replay: createReplayStorage({ driver: createMemoryDriver(), maxMatches: 50 }),
  analysis: createAnalysisStorage({ driver: createAnalysisMemoryDriver() }),
})

describe('分析包导入（§9.2、§9.3、§10.7）', () => {
  it('导出 → 导入往返：记录与配置都回来，且能按记录取到配置（引用闭合）', async () => {
    const stores = memoryStores()
    const outcome = await importAnalysisFile({ ...stores, text: JSON.stringify(pack()) })
    expect(outcome.reason).toBeNull()
    expect(outcome.ok).toBe(true)
    expect(outcome.importedId).toBe('m-1')
    expect(outcome.wroteReplay, '本地没有这场，应连展示回放一起补上').toBe(true)
    expect(outcome.writtenRecords).toBe(parts.length)

    const read = await stores.analysis.read('m-1')
    expect(read.complete).toBe(true)
    expect(read.parts.map(part => part.tag)).toEqual(parts.map(part => part.tag))
    expect(await stores.analysis.readConfigs('m-1')).toEqual([config])
    expect(await stores.analysis.status('m-1')).toBe('complete')
    // 展示回放也补上了（§9.2：分析区不得比它引用的展示回放活得更久）
    expect(await stores.replay.loadMatch('m-1')).toBeTruthy()
    expect((await stores.replay.loadRounds('m-1')).length).toBe(1)
  })

  it('本地已有同 id 场次 ⇒ 以本地牌谱为准，只补分析记录（不覆盖用户的牌谱）', async () => {
    const stores = memoryStores()
    const localMatch = { ...match, summary: '本地已有' }
    await stores.replay.saveMatch(localMatch)
    await stores.replay.saveRound(rounds[0])
    const outcome = await importAnalysisFile({ ...stores, text: JSON.stringify(pack()) })
    expect(outcome.ok).toBe(true)
    expect(outcome.wroteReplay).toBe(false)
    expect((await stores.replay.loadMatch('m-1'))?.summary).toBe('本地已有')
    expect((await stores.analysis.read('m-1')).parts.length).toBe(parts.length)
  })

  it('缺展示回放的包 ⇒ 拒绝（不算自包含，公开字段无处还原）', () => {
    const payload = JSON.parse(JSON.stringify(pack()))
    delete payload.replay
    const result = parseAnalysisImport(payload)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不含展示回放')
  })

  it('配置正文缺失（引用不闭合）⇒ 拒绝并列明缺哪个', () => {
    const payload = JSON.parse(JSON.stringify(pack({ configurations: [] })))
    const result = parseAnalysisImport(payload)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('config/m-1/1')
  })

  it('更高版本 ⇒ 拒绝（不拿旧解析器硬解）', () => {
    const payload = JSON.parse(JSON.stringify(pack()))
    payload.records[0].value.formatVersion = ANALYSIS_FORMAT_VERSION + 1
    const result = parseAnalysisImport(payload)
    expect(result.ok).toBe(false)
    expect(result.version.readable).toBe(false)
  })

  it('不是分析包 ⇒ 拒绝并说清 kind', () => {
    const result = parseAnalysisImport({ kind: 'lianhua-replay', schemaVersion: 1 })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('lianhua-analysis')
  })

  it('不带记录的空壳包 ⇒ 拒绝', () => {
    const payload = JSON.parse(JSON.stringify(pack()))
    payload.records = []
    const result = parseAnalysisImport(payload)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('没有任何记录')
  })

  it('包本身标 partial ⇒ 导入后仍是「部分缺失」，不冒充完整（§9.5）', async () => {
    const stores = memoryStores()
    const partial = buildAnalysisExport({
      match, rounds, parts, configurations: [config], status: 'partial',
      gaps: [{ scope: 'decisions', from: 3, to: 5, reason: '分析区不可用' }],
      exportedAt: 1_700_000_200_000,
    })
    const outcome = await importAnalysisFile({ ...stores, text: JSON.stringify(partial) })
    expect(outcome.ok).toBe(true)
    expect(outcome.completeness).toBe('partial')
    expect(importedAreaStatus(outcome)).toBe('partial')
    const read = await stores.analysis.read('m-1')
    expect(read.complete).toBe(false)
    expect(read.meta?.status).toBe('partial')
    expect(read.meta?.gaps.map(gap => gap.scope)).toContain('decisions')
  })

  it('分析区不可用 ⇒ 拒绝，不假装导入成功', async () => {
    const stores = memoryStores()
    stores.analysis.close()
    const outcome = await importAnalysisFile({ ...stores, text: JSON.stringify(pack()) })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('分析区不可用')
  })

  it('文件名与牌谱导出可区分（analysis- 前缀）', () => {
    expect(analysisExportFilename(match, 1_700_000_200_000)).toMatch(/^analysis-lotus-blood-flow-/)
  })
})
