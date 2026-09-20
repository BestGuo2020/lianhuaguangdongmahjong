import { describe, expect, it } from 'vitest'
import { createAnalysisSession, reconcileAnalysisWithReplay } from './session'
import { createAnalysisMemoryStorage } from './storage'
import { fingerprintOf } from './codec'
import type { AnalysisBlockPart } from './codec'
import type { AnalysisDecision, AnalysisConfigRecord } from './types'

// 分析会话（§3.1、§9.2、§9.3）：
// 每场一个新录制器但引擎只持稳定代理、场末落库并回收悬空分析区、关闭时零成本。

function setup(options: { enabled?: boolean; storage?: ReturnType<typeof createAnalysisMemoryStorage> | null } = {}) {
  const storage = options.storage === undefined ? createAnalysisMemoryStorage() : options.storage
  const session = createAnalysisSession({
    enabled: options.enabled ?? true,
    storage,
    now: () => 1_700_000_000_000,
    monotonic: () => 1_000,
    createId: (() => { let n = 0; return () => `match-${++n}` })(),
  })
  return { session, storage }
}

const config = {
  rulesetId: 'lotus-blood-flow', rules: { rounds: 4 }, rulesVersion: 'lotus-blood-flow-v1',
  aiConfig: { bigHandRoute: true }, aiStrategy: 'source-v2',
  seatControl: ['human', 'llm', 'llm', 'local-ai'] as const,   // 座位控制词表：human/local-ai/llm
}

describe('分析录制会话', () => {
  it('开一场会写入配置（含规则/AI 指纹），决策落到该场名下', async () => {
    const { session, storage } = setup()
    const matchId = session.start({ ...config, seatControl: [...config.seatControl] })
    expect(matchId).toBe('match-1')
    expect(session.matchId()).toBe('match-1')
    expect(session.active()).toBe(true)

    session.port!.windowOpened({
      windowId: 'w1', seat: 1, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1,
      state: { id: 's1', legalActions: [{ id: 'w1/0', kind: 'discard' }] },
    })
    session.port!.candidates({ windowId: 'w1', seat: 1, legalActions: [{ id: 'w1/0', kind: 'discard' }], candidates: [] })
    session.port!.chosen({ windowId: 'w1', seat: 1, legalActionId: 'w1/0', source: 'local-strategy' })
    const finished = await session.finish()
    expect(finished).toMatchObject({ matchId: 'match-1', status: 'complete' })

    const read = await storage.read('match-1')
    expect(read.complete).toBe(true)
    const configs = read.parts.filter((part: AnalysisBlockPart) => part.tag === 'config').map((part) => part.value as AnalysisConfigRecord)
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({
      rulesVersion: 'lotus-blood-flow-v1', seatControl: ['human', 'llm', 'llm', 'local-ai'],
      rulesFingerprint: fingerprintOf(config.rules), aiFingerprint: fingerprintOf(config.aiConfig),
    })
    const decisions = read.parts.filter((part: AnalysisBlockPart) => part.tag === 'decision').map((part) => part.value as AnalysisDecision)
    expect(decisions.at(-1)).toMatchObject({ matchId: 'match-1', source: 'local-strategy', windowId: 'w1' })
  })

  it('换场只换内部目标：旧场的记录不会混进新场', async () => {
    const { session, storage } = setup()
    session.start({ ...config, seatControl: [...config.seatControl] })
    session.port!.windowOpened({ windowId: 'wA', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 'sA' } })
    await session.finish()

    const second = session.start({ ...config, seatControl: [...config.seatControl] })
    expect(second).toBe('match-2')
    session.port!.windowOpened({ windowId: 'wB', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e2', stateVersion: 1, state: { id: 'sB' } })
    await session.finish()

    const first = await storage.read('match-1')
    const next = await storage.read('match-2')
    expect(first.parts.some((part: AnalysisBlockPart) => part.tag === 'decisionState' && (part.value as { id: string }).id === 'sA')).toBe(true)
    expect(first.parts.some((part: AnalysisBlockPart) => JSON.stringify(part.value).includes('wB'))).toBe(false)
    expect(next.parts.some((part: AnalysisBlockPart) => (part.value as { id?: string }).id === 'sB')).toBe(true)
  })

  it('场末收尾后代理仍在但不误写新场（finish 幂等、未开新场时写入安全空转）', async () => {
    const { session, storage } = setup()
    session.start({ ...config, seatControl: [...config.seatControl] })
    session.port!.windowOpened({ windowId: 'w1', seat: 0, windowKind: 'draw-turn', roundIndex: 1, authorityEpoch: 'e1', stateVersion: 1, state: { id: 's1' } })
    const first = await session.finish()
    // 收尾之后再调用（例如迟到的回执）：不应写入任何场次
    session.port!.receipt({ windowId: 'w1', seat: 0, status: 'executed' })
    await session.port!.flush()
    expect(session.active()).toBe(false)
    const again = await session.finish()
    expect(again.bytes).toBe(0)
    expect(again.status).toBe(first.status)
    const usage = await storage.usage()
    expect(usage.matches).toBe(1)
  })

  it('分析关闭时：代理为 null，开一场也不产生任何写入（§9.2、§10.7）', async () => {
    const storage = createAnalysisMemoryStorage()
    const session = createAnalysisSession({ enabled: false, storage })
    expect(session.port).toBeNull()
    expect(session.start({ ...config, seatControl: [...config.seatControl] })).toBe('')
    const finished = await session.finish()
    expect(finished).toMatchObject({ status: 'disabled', bytes: 0 })
    expect(await storage.usage()).toEqual({ bytes: 0, matches: 0 })
  })

  it('配置指纹对内容敏感：同一配置恒等，改一个字段就变', () => {
    expect(fingerprintOf({ a: 1, b: [1, 2] })).toBe(fingerprintOf({ a: 1, b: [1, 2] }))
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }))
  })

  it('按展示回放清单回收悬空分析区（§9.2）', async () => {
    const { session, storage } = setup()
    session.start({ ...config, seatControl: [...config.seatControl] })
    const kept = session.matchId()
    await session.finish()
    session.start({ ...config, seatControl: [...config.seatControl] })
    const dangling = session.matchId()
    await session.finish()

    const removed = await reconcileAnalysisWithReplay(storage, [{ matchId: kept }])
    expect(removed).toEqual([dangling])
    expect(await storage.status(kept)).toBe('complete')
    expect(await storage.status(dangling)).toBe('disabled')
    // 没有存储时安全空转
    expect(await reconcileAnalysisWithReplay(null, [])).toEqual([])
  })
})
