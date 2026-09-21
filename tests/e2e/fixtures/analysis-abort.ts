// 中途退出（未打完整场）的分析记录行为（§9.2、§9.5）：
// ① 已录到的数据必须**刷进分析区并如实标成不完整**（gap: match-aborted），不能静默丢；
// ② 会话必须随之结束 —— 否则 App 的 `analysis.active()` 守卫会跳过下一场的 start()，
//    于是新对局的记录挂到上一场的 matchId 上（错场归属）。
//
// 场景刻意照 App 的接线来：同一会话实例、同一守卫（`if (!session.active()) start(...)`）、
// 每场用展示回放录制器的 `ensureMatchId()` 当 matchId（与分析区共用一把钥匙）。
import { useBloodFlowGame } from '../../../src/game/variants/lotus/bloodFlow/useBloodFlowGame'
import { createAnalysisSession } from '../../../src/game/replay/analysis/session'
import { createAnalysisStorage } from '../../../src/game/replay/analysis/storage'
import { createReplayRecorder } from '../../../src/game/replay/recorder'
import { BLOOD_FLOW_CONFIG, BLOOD_FLOW_AI } from '../../../src/game/variants/lotus/bloodFlow/config'

interface AbortStatus {
  ready: boolean
  error: string | null
  errors: string[]
  /** 第一场（中途退出）与第二场的分析区实测结果。 */
  first: { matchId: string; status: string; parts: number; gapReasons: string[]; blocks: number } | null
  second: { matchId: string; status: string; parts: number; blocks: number } | null
  /** 会话在两个关键点的 active 状态。 */
  activeAfterAbort: boolean | null
  activeAfterSecondStart: boolean | null
  startedSecondMatch: boolean
  windowsBeforeAbort: number
  analysisUnavailable: boolean
}

const status: AbortStatus = {
  ready: false, error: null, errors: [], first: null, second: null,
  activeAfterAbort: null, activeAfterSecondStart: null, startedSecondMatch: false,
  windowsBeforeAbort: 0, analysisUnavailable: false,
}
;(window as unknown as { __analysisAbort: AbortStatus }).__analysisAbort = status

// 与其它 fixture 同一套节奏压缩：定时器 0ms，窗口推进得快
const realSetTimeout = window.setTimeout.bind(window)
const realSetInterval = window.setInterval.bind(window)
window.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetTimeout(handler as never, 0, ...args)
)) as typeof window.setTimeout
window.setInterval = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetInterval(handler as never, 0, ...args)
)) as typeof window.setInterval

const tick = (ms = 0) => new Promise<void>((resolve) => { realSetTimeout(() => resolve(), ms) })

function startOptions() {
  return {
    rulesetId: 'lotus-blood-flow',
    rules: BLOOD_FLOW_CONFIG,
    rulesVersion: BLOOD_FLOW_CONFIG.version,
    aiConfig: { local: BLOOD_FLOW_AI },
    aiStrategy: 'source-v2',
    seatControl: ['human', 'local-ai', 'local-ai', 'local-ai'],
    engineBuild: 'e2e-analysis-abort',
  }
}

void (async () => {
  try {
    const storage = createAnalysisStorage()
    status.analysisUnavailable = !storage.available()
    const session = createAnalysisSession({
      enabled: true, storage,
      onError: (detail) => status.errors.push(`分析记录：${detail}`),
    })
    const recorder = createReplayRecorder({
      sink: { saveMatch: () => {}, saveRound: () => {} },
      meta: () => ({ rulesetId: 'lotus-blood-flow', rulesetName: '莲花麻将·血流', themeName: 'jade', humanSeat: 0 }),
    })
    const game = useBloodFlowGame({
      playSound: () => {}, playSoundAndWait: async () => {},
      countdownEnabled: true, autoplay: true, paceMs: 0,
      recorder: recorder.hooks,
      analysis: session.port,
    }) as unknown as {
      phase: { value: string }
      matchFinished: { value: boolean }
      view: { value: { window?: { id: string } | null } | null }
      startGame(mode?: 'east' | 'hanchan'): Promise<unknown>
      returnToLobby(): void
    }

    const analyze = async (matchId: string) => {
      const read = await storage.read(matchId)
      const blocks = (await storage.read(matchId)).parts.length
      return {
        matchId,
        status: await storage.status(matchId),
        parts: blocks,
        gapReasons: (read.meta?.gaps ?? []).map(gap => gap.reason),
        blocks: read.meta?.blockCount ?? 0,
      }
    }

    /** 照 App 的接线开一场：matchId 给分析会话（与展示回放共用一把钥匙），且守 `active()` 只开一次。 */
    const startMatch = async () => {
      const matchId = recorder.ensureMatchId()
      if (!session.active()) session.start({ ...startOptions(), matchId })
      await game.startGame('east')
      return matchId
    }

    // ── 第一场：打十几个窗口后中途返回大厅 ──
    const firstId = await startMatch()
    const seen = new Set<string>()
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && seen.size < 12) {
      const id = game.view.value?.window?.id
      if (id) seen.add(id)
      await tick(20)
    }
    status.windowsBeforeAbort = seen.size
    game.returnToLobby()
    // 等异步的 flush + finish 落地（失败也算完成，后面按实测断言）
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await storage.status(firstId) === 'partial') break
      await tick(50)
    }
    status.activeAfterAbort = session.active()
    status.first = await analyze(firstId)

    // ── 第二场：必须以新的 matchId 落库（否则就是"记录挂到上一场"） ──
    recorder.finishAuto()
    const secondId = await startMatch()
    status.startedSecondMatch = secondId !== firstId
    status.activeAfterSecondStart = session.active()
    const seenSecond = new Set<string>()
    const secondDeadline = Date.now() + 30_000
    while (Date.now() < secondDeadline && seenSecond.size < 8) {
      const id = game.view.value?.window?.id
      if (id) seenSecond.add(id)
      await tick(20)
    }
    // 第二场按"打完整场"的收尾走（App 在 matchFinished 时就是这么做的）：刷队列 → 落库
    await session.finish()
    status.second = await analyze(secondId)
    status.ready = true
  } catch (error) {
    status.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }
})()
