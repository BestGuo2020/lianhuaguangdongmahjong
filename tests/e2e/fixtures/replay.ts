// 回放 fixture：用真实引擎在浏览器里自动打完整场东风场，并由真实录制器落库到 IndexedDB。
// tests/e2e/replay.spec.ts 随后在同一浏览器上下文里打开真实 App，从大厅「对局回放」查看它们 ——
// 覆盖「真实引擎录制 → IndexedDB → 大厅列表 → 3D 回放视图」整条链路。
// 依次录制莲花广麻（默认墨玉）与莲花麻将（红木金丝），同时验证「按记录主题回放」。
import { useGame } from '../../../src/game/core/local/useGame'
import { useLotusGame } from '../../../src/game/variants/lotus/lotusGame'
import { useBloodFlowGame } from '../../../src/game/variants/lotus/bloodFlow/useBloodFlowGame'
import { getRuleVariant, type RuleVariant } from '../../../src/game/core/rules/ruleVariants'
import { createReplayStorage } from '../../../src/game/replay/storage'
import { useReplayRecorder } from '../../../src/game/replay/useReplayRecorder'
import type { ReplayRecorderHooks } from '../../../src/game/replay/types'
import type { TableThemeName } from '../../../src/theme/themeIdentity'

export interface ReplayFixtureMatch {
  rulesetId: string
  rulesetName: string
  themeName: string
  rounds: number
  status: string
  rank: number | null
  flipTile: string | null
  jokers: number
  steps: number
  /** 和牌事件数：血流一局可多次胡牌。 */
  wins: number
  /** 各局标签与局数（诊断用）。 */
  labels: string[]
  roundNumbers: number[]
  /** 录制钩子调用轨迹（诊断用，截断）。 */
  hooksLog: string[]
}

export interface ReplayFixtureStatus {
  matches: ReplayFixtureMatch[]
  errors: string[]
}

const status: ReplayFixtureStatus = { matches: [], errors: [] }
;(window as unknown as { __replayFixture: ReplayFixtureStatus }).__replayFixture = status

// 把引擎的表现节奏压到 0（含回合倒计时），整场东风场几秒跑完；tick 用真实定时器避免饿死宏任务。
const realSetTimeout = window.setTimeout.bind(window)
const realSetInterval = window.setInterval.bind(window)
window.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetTimeout(handler as never, 0, ...args)
)) as typeof window.setTimeout
window.setInterval = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => (
  realSetInterval(handler as never, 0, ...args)
)) as typeof window.setInterval

const tick = (ms = 0) => new Promise<void>((resolve) => { realSetTimeout(() => resolve(), ms) })

/** 引擎端口的录制所需最小面（广麻/莲花麻将都满足）。 */
interface PlayablePort {
  phase: { value: string }
  matchFinished: { value: boolean }
  round: { value: number }
  standings: { value: Array<{ playerIndex: number; name: string; score: number; rank: number }> }
  nextRound(): void
  startGame(mode?: 'east' | 'hanchan'): unknown
}

/** 录制器快照（诊断用）：局数与计数能直接暴露被吃掉的结算。 */
function recorderStats(replay: ReturnType<typeof useReplayRecorder>) {
  const stats = replay.snapshot().stats
  return `starts=${stats.roundStarts} ends=${stats.roundEnds} skipped=${stats.roundEndsSkipped} finals=${stats.matchesFinalized}`
}

const storage = createReplayStorage({
  // 存储异常必须暴露给测试，否则「静默降级」会把落库失败伪装成空列表。
  onError: (error) => { status.errors.push(`storage: ${String(error)}`) },
})

async function playMatch(port: PlayablePort) {
  await port.startGame('east')
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (port.matchFinished.value || port.phase.value === 'finished') return true
    if (port.phase.value === 'settled') {
      port.nextRound()
      await tick()
      continue
    }
    if (port.phase.value === 'lobby') return false
    await tick()
  }
  return false
}

async function record(rulesetId: RuleVariant, themeName: TableThemeName) {
  const replay = useReplayRecorder({
    meta: () => ({
      rulesetId,
      rulesetName: getRuleVariant(rulesetId).name,
      themeName,
      humanSeat: 0,
    }),
    storage,
  })
  const hooksLog: string[] = []
  let hookCalls = 0
  const tracedHooks: ReplayRecorderHooks = {
    roundStart: (frame) => { hooksLog.push(`start r=${frame.round} h=${frame.honba}`); replay.hooks.roundStart(frame) },
    draw: (event, frame) => replay.hooks.draw(event, frame),
    discard: (event, frame) => replay.hooks.discard(event, frame),
    tableAction: (event, frame) => replay.hooks.tableAction(event, frame),
    roundEnd: (result, frame) => {
      hookCalls += 1
      hooksLog.push(`end r=${frame.round} draw=${result.draw}`)
      replay.hooks.roundEnd(result, frame)
    },
  }
  const common = {
    playSound: () => {},
    playSoundAndWait: async () => {},
    // 倒计时开启：本家座位自动出牌/过牌，整场无需人工操作。
    countdownEnabled: true,
    recorder: tracedHooks,
  }
  const game = rulesetId === 'lotus-legacy'
    ? useLotusGame(common)
    : rulesetId === 'lotus-blood-flow'
      // 血流权威引擎跑在 worker 里（真实 worker + 真实规则引擎），autoplay 让本家座位也自动打。
      ? useBloodFlowGame({ ...common, autoplay: true, paceMs: 0 })
      : useGame(common)
  const finished = await playMatch(game as unknown as PlayablePort)
  if (!finished) status.errors.push(`${rulesetId} 对局未打完：phase=${game.phase.value} round=${game.round.value}`)
  const match = replay.finishAuto(game.standings.value.map((entry) => ({
    seat: entry.playerIndex,
    name: entry.name,
    score: entry.score,
    rank: entry.rank,
  })))
  if (!match) {
    status.errors.push(`${rulesetId} 回放未落库：active=${replay.active()} phase=${game.phase.value} round=${game.round.value}`)
    return
  }
  const rounds = await storage.loadRounds(match.id)
  if (rounds.length !== match.roundCount) status.errors.push(`${rulesetId} 局数不一致：${rounds.length} != ${match.roundCount}（${recorderStats(replay)}）`)
  if (!rounds.every((round) => round.final)) status.errors.push(`${rulesetId} 存在没有结算快照的局`)
  status.matches.push({
    rulesetId: match.rulesetId,
    rulesetName: match.rulesetName,
    themeName: match.themeName,
    rounds: match.roundCount,
    status: match.status,
    rank: match.myRank ?? null,
    flipTile: rounds[0]?.flipTile ?? null,
    jokers: rounds[0]?.jokerTiles.length ?? 0,
    steps: rounds.reduce((sum, round) => sum + round.steps.length, 0),
    wins: rounds.reduce((sum, round) => sum + round.steps.filter((step) => step.t === 'win').length, 0),
    labels: rounds.map((round) => round.roundLabel),
    roundNumbers: rounds.map((round) => round.round),
    hooksLog: [...hooksLog.slice(0, 32), recorderStats(replay)],
  })
  if (hookCalls < 4) {
    status.errors.push(`${rulesetId} 结算钩子只触发 ${hookCalls} 次（${recorderStats(replay)}）trace=[${hooksLog.join(' ; ')}]`)
  }
}

void (async () => {
  try {
    await record('lotus-classic', 'jade')
    await record('lotus-legacy', 'rosewood')
    await record('lotus-blood-flow', 'llm')
    // 等 IndexedDB 写入提交，再让外面的测试读到。
    await tick(150)
    const stored = await storage.list()
    if (stored.length !== 3) status.errors.push(`IndexedDB 记录数异常：${stored.length}`)
    document.body.dataset.replayFixture = 'ready'
  } catch (error) {
    status.errors.push(error instanceof Error ? error.message : String(error))
    document.body.dataset.replayFixture = 'error'
  }
})()
