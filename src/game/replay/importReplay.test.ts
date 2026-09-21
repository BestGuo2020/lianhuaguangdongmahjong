import { describe, expect, it } from 'vitest'
import { importReplayFile, parseReplayImport } from './importReplay'
import { createReplayStorage } from './storage'
import { createMemoryDriver } from './idb'
import { buildReplayExport } from './export'
import { REPLAY_SCHEMA_VERSION, type ReplayMatch, type ReplayRound } from './types'

// 牌谱导入（§9.5、§10.7）的验收点：
// 1. 导出 → 导入往返不丢引用（局与场次的 id 关系、局数一致）；
// 2. 缺字段/悬空引用/版本不认识 ⇒ 明确拒绝，不用默认值硬顶；
// 3. 旧格式可导入并标注；同 id 已存在时拒绝覆盖。

const match: ReplayMatch = {
  id: 'm-1', schemaVersion: REPLAY_SCHEMA_VERSION, rulesetId: 'lotus-classic', rulesetName: '莲花广麻',
  matchType: 'east', matchName: '东风场', gameMode: 'local', themeName: 'jade',
  players: [
    { seat: 0, name: 'P0', avatar: '', score: 1000, rank: 1 },
    { seat: 1, name: 'P1', avatar: '', score: 900, rank: 2 },
    { seat: 2, name: 'P2', avatar: '', score: 800, rank: 3 },
    { seat: 3, name: 'P3', avatar: '', score: 700, rank: 4 },
  ],
  humanSeat: 0, startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
  status: 'finished', roundCount: 2, myRank: 1, myScore: 1000, summary: '东1局 P0自摸（本家）',
} as unknown as ReplayMatch

const rounds: ReplayRound[] = [
  { id: 'm-1:1', matchId: 'm-1', roundIndex: 1, round: 1, roundLabel: '东1局', dealer: 0, honba: 0,
    matchType: 'east', steps: [{ t: 'draw', seat: 0, tile: 'm1' }], final: null } as unknown as ReplayRound,
  { id: 'm-1:2', matchId: 'm-1', roundIndex: 2, round: 2, roundLabel: '东2局', dealer: 1, honba: 0,
    matchType: 'east', steps: [{ t: 'discard', seat: 1, tile: 'p2' }], final: null } as unknown as ReplayRound,
]

const exported = () => JSON.parse(JSON.stringify(buildReplayExport(match, rounds, 1_700_000_200_000)))

function memoryStorage() {
  return createReplayStorage({ driver: createMemoryDriver(), maxMatches: 50 })
}

describe('牌谱导入（§9.5、§10.7）', () => {
  it('导出 → 导入往返：场次与各局完整回来，不丢引用', async () => {
    const storage = memoryStorage()
    const outcome = await importReplayFile(storage, JSON.stringify(exported()))
    expect(outcome.reason).toBeNull()
    expect(outcome.importedId).toBe('m-1')
    const restored = await storage.loadMatch('m-1')
    expect(restored?.rulesetName).toBe('莲花广麻')
    const restoredRounds = await storage.loadRounds('m-1')
    expect(restoredRounds.map(round => round.id)).toEqual(['m-1:1', 'm-1:2'])
    expect(restoredRounds.every(round => round.matchId === 'm-1')).toBe(true)
    // 事件流也在：不是只有空壳
    expect(restoredRounds[0].steps.length).toBe(1)
  })

  it('导入的场次没有分析记录 ⇒ 列表要能标成「缺少决策分析记录」（不写 analysisRecorded）', async () => {
    const storage = memoryStorage()
    await importReplayFile(storage, JSON.stringify(exported()))
    const restored = await storage.loadMatch('m-1')
    expect(restored?.analysisRecorded).toBeUndefined()
  })

  it('同 id 已存在 ⇒ 拒绝，不静默覆盖', async () => {
    const storage = memoryStorage()
    await importReplayFile(storage, JSON.stringify(exported()))
    const again = await importReplayFile(storage, JSON.stringify(exported()))
    expect(again.ok).toBe(false)
    expect(again.reason).toContain('已存在同一场次')
  })

  it('更高版本 ⇒ 明确拒绝（不拿旧解析器硬解新格式）', () => {
    const payload = exported()
    payload.schemaVersion = REPLAY_SCHEMA_VERSION + 1
    const result = parseReplayImport(payload)
    expect(result.ok).toBe(false)
    expect(result.version.readable).toBe(false)
    expect(result.reason).toContain('高于本程序能识别')
  })

  it('旧格式（版本更低或未标注）⇒ 可导入并标注', () => {
    const payload = exported()
    payload.schemaVersion = REPLAY_SCHEMA_VERSION - 1
    const legacy = parseReplayImport(payload)
    expect(legacy.ok).toBe(true)
    expect(legacy.version.legacy).toBe(true)
    expect(legacy.notes.join(' ')).toContain('旧格式牌谱')
    delete payload.schemaVersion
    const unlabeled = parseReplayImport(payload)
    expect(unlabeled.ok).toBe(true)
    expect(unlabeled.version.legacy, '没有版本字段按旧格式对待').toBe(true)
  })

  it('不是牌谱文件 ⇒ 拒绝并说清 kind', () => {
    const result = parseReplayImport({ kind: 'lianhua-analysis', schemaVersion: 1 })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('lianhua-replay')
  })

  it('缺必需字段 ⇒ 逐项列出缺了什么，不用默认值顶替', () => {
    const payload = exported()
    delete payload.match.themeName
    delete payload.match.startedAt
    const result = parseReplayImport(payload)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('match.themeName')
    expect(result.reason).toContain('match.startedAt')
  })

  it('局的 matchId 与场次不一致 ⇒ 拒绝（否则导入的是悬空引用）', () => {
    const payload = exported()
    payload.rounds[1].matchId = 'other-match'
    const result = parseReplayImport(payload)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不一致')
  })

  it('局数与场次记录不一致 ⇒ 拒绝（残档不能当完整牌谱）', () => {
    const payload = exported()
    payload.match.roundCount = 3
    const result = parseReplayImport(payload)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('局数与场次记录不一致')
  })

  it('局里缺 steps ⇒ 拒绝', () => {
    const payload = exported()
    delete payload.rounds[0].steps
    const result = parseReplayImport(payload)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('steps')
  })

  it('文件不是 JSON ⇒ 给出可读原因，不抛异常', async () => {
    const storage = memoryStorage()
    const outcome = await importReplayFile(storage, '{ 这不是 json')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('不是合法 JSON')
  })

  it('存储不可用 ⇒ 明确拒绝，不假装导入成功', async () => {
    const storage = createReplayStorage({ driver: null })
    const outcome = await importReplayFile(storage, JSON.stringify(exported()))
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('存储不可用')
  })
})
