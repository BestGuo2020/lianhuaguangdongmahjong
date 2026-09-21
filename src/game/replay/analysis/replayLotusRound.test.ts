import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLotusGame } from '../../variants/lotus/lotusGame'
import { buildRingWall } from '../../variants/lotus/lotusWall'
import { seededRandom } from '../../variants/lotus/bloodFlow/simulation'
import type { AnalysisRecorder, AnalysisWindowInput } from './recorder'
import type { AnalysisReproduction } from './types'
import { replayLotusLegacyRound } from './reproduceLotusLegacy'

// 决定性重跑的快速回归网：**真跑一局**（真实引擎 + 固定牌墙/骰子）→ 拿它自己落下的复现数据重跑 →
// 必须到达同一结束状态（方案 §2.3：不许拿"跑通"当"复现"）。
//
// 与浏览器夹具（`tests/e2e/analysis-lotus-legacy.spec.ts` 的 P1 用例）的关系：那边是端到端权威
// （真实 IndexedDB 读回 + 真实浏览器定时器），一次几分钟；这里几秒钟就能把"重跑与记录分叉"卡住，
// 定位也快得多 —— 本文件第一次跑就抓出了"端口少了 `flipSeat` ⇒ 观测桩抛异常 ⇒ 窗口编号错乱"这条链。
//
// 为什么 `useLotusGame` 在这里跑得动：它本身不依赖 DOM（`lotusGame.sim.test.ts` 就是整套模拟），
// 只要把 `window` 的定时器接上、推进假时钟把对局跑完即可。

function stubWindow() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

interface Captured {
  reproduction: AnalysisReproduction[]
  gaps: string[]
}

function capturePort(captured: Captured): AnalysisRecorder {
  return {
    enabled: true,
    paused: () => false,
    beginMatch: () => 'replay-test-match',
    windowOpened: (_window: AnalysisWindowInput) => {},
    candidates: () => {},
    promptTemplate: () => {},
    chosen: () => {},
    source: () => {},
    receipt: () => {},
    attemptStarted: () => '',
    attemptFinished: () => {},
    settlement: () => {},
    reproduction: (input: AnalysisReproduction) => { captured.reproduction.push(input) },
    noteGap: (gap: { scope: string; reason: string }) => { captured.gaps.push(`${gap.scope}:${gap.reason}`) },
    flush: async () => {},
    finish: async () => ({ status: 'partial' as const, bytes: 0 }),
    diagnostics: () => ({ decisions: 0, attempts: 0, pendingParts: 0, pendingBytes: 0, paused: false }),
  }
}

/** 推进假时钟一拍。假时钟把 `Date.now()` 也接管了，所以重跑的上限要放大（见下面的 `deadlineMs`）。 */
const tick = async () => { await vi.advanceTimersByTimeAsync(50) }

interface DebugPort {
  phase: { value: string }
  result: { value: unknown }
  players: Array<{ score: number; hand: string[] }>
}

/** 真跑一局（人类座位由倒计时自动出牌），返回它落下的复现数据与结束分数。 */
async function playOneRound(seed: number) {
  const captured: Captured = { reproduction: [], gaps: [] }
  const game = useLotusGame({
    playSound: () => {}, playSoundAndWait: async () => {},
    analysis: capturePort(captured),
  }) as unknown as DebugPort & { startGame(mode?: string, options?: Record<string, unknown>): unknown }

  let startError: string | null = null
  const started = Promise.resolve(game.startGame('east', {
    initialWall: buildRingWall(seededRandom(seed)),
    openingDice: [2, 3], openingSecondDice: [1, 4],
  })).catch((error) => { startError = error instanceof Error ? error.message : String(error) })

  // 只按步数收敛（不能用墙钟：假时钟一推就是一秒，几步就把墙钟上限耗光）。
  let steps = 0
  while (!game.result.value && steps < 4000 && !startError) {
    steps += 1
    await vi.advanceTimersByTimeAsync(1000)
  }
  await started
  expect(startError, '原始对局不该开局失败').toBeNull()
  expect(game.result.value, `原始对局没跑完（steps=${steps}、phase=${game.phase.value}）`).toBeTruthy()
  const record = captured.reproduction[0]
  expect(record, '这一局必须落下复现数据（没落说明开局快照或命令日志没接上）').toBeTruthy()
  return {
    record,
    endScores: game.players.map((player) => player.score),
    recordedGaps: captured.gaps,
  }
}

const replay = (reproduction: AnalysisReproduction, expectedScores: number[] | null) => replayLotusLegacyRound({
  reproduction,
  commands: (reproduction.commands ?? []).filter((entry) => (entry.resolution ?? 'command') === 'command'),
  expectedScores,
  tick,
  // 假时钟下 `Date.now()` 跟着跳：上限放大（真实浏览器里 120s 绰绰有余）。
  deadlineMs: 3_600_000,
})

describe('翻精癞子 P1：重跑一局（§2.2、§2.3、§3.3）', () => {
  it('用记录里的复现数据重跑 ⇒ 逐条消费命令、到达同一结束状态', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const record = played.record

    // 记录本身先立住：环状牌墙 136 张、两对骰子、庄家、四家开局分、发牌后手牌、命令日志非空
    expect(record.ringWall, '环状牌墙必须是 136 张').toHaveLength(136)
    expect(record.dice?.first, '第一颗骰子（两粒）').toHaveLength(2)
    expect(record.dice?.second, '第二颗骰子（两粒）').toHaveLength(2)
    expect(record.openingScores, '四家开局分').toEqual([2000, 2000, 2000, 2000])
    expect(record.postDealHands, '四家发牌后手牌').toHaveLength(4)
    expect(record.commands?.length ?? 0, '命令日志不能是空的').toBeGreaterThan(0)
    expect(played.recordedGaps, '录制期间不该留缝').toEqual([])

    const run = await replay(record, played.endScores)
    expect(run.ok, `重跑失败：${run.reason}`).toBe(true)
    expect(run.postDealCheck.checked, '必须真的做了发牌后手牌的交叉校验').toBe(true)
    expect(run.postDealCheck.ok).toBe(true)
    expect(run.openingCheck.checked, '必须校验翻精/精牌/开牌断点').toBe(true)
    expect(run.openingCheck.ok).toBe(true)
    expect(run.scoresMatch, '结束分数必须与记录一致').toBe(true)
    expect(run.finalScores).toEqual(played.endScores)
    // 命令日志**逐条被消费**：少跑一条会被 `unusedCommands` 抓到，多跑一条会被 `extraWindows` 抓到
    expect(run.metrics.commandsRecorded).toBeGreaterThan(1)
    expect(run.metrics.commandsConsumed).toBe(run.metrics.commandsRecorded)
    expect(run.metrics.unusedCommands).toBe(0)
    expect(run.metrics.extraWindows).toBe(0)
    expect(run.metrics.withoutWindowId).toBe(0)
    expect(run.kindMismatches, '窗口类型/座位必须逐窗口对上').toBe(0)
    expect(run.metrics.windowsOpened, '重跑开出的窗口数应当与命令条数一致').toBe(run.metrics.commandsRecorded)
    expect(run.gaps, '重跑期间不该留缝').toEqual([])
  }, 120_000)

  it('把 postDealHands 动一张（只改顺序）⇒ 报「发牌算法变了或记录与引擎不一致」并**一条命令都不喂**', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const first = played.record.postDealHands![0]
    expect(first.length, '庄家起手 14 张，够做"只改顺序"的篡改').toBeGreaterThan(1)
    const tampered: AnalysisReproduction = {
      ...played.record,
      // 把首张挪到末尾：**牌的多重集合没变、只有顺序变了** —— 这道闸必须是按位置比的
      postDealHands: played.record.postDealHands!.map((hand, seat) => (seat === 0 ? [...hand.slice(0, -1), hand[0]] : [...hand])),
    }

    const run = await replay(tampered, played.endScores)
    expect(run.ok, '记录被动过就不能再声称复现成功').toBe(false)
    expect(run.reason, '失败原因必须点明是发牌算法/记录与引擎不一致').toContain('发牌算法变了或记录与引擎不一致')
    expect(run.postDealCheck.checked).toBe(true)
    expect(run.postDealCheck.ok).toBe(false)
    expect(run.metrics.commandsConsumed, '发现不一致之后不许再喂任何命令（更不许跳过它把这一局跑完）').toBe(0)
  }, 120_000)

  it('记录里没有开局分数 ⇒ 如实报「不可比对」，不拿跑出来的数字硬比', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const { openingScores: _dropped, ...withoutScores } = played.record

    const run = await replay(withoutScores as AnalysisReproduction, played.endScores)
    expect(run.ok).toBe(false)
    expect(run.reason, '缺开局分要报"不可比对"，而不是报"牌流复现失败"').toContain('不可比对')
    expect(run.metrics.commandsConsumed, '压根不该开始跑').toBe(0)
  }, 120_000)

  it('记录里没有可比的结束分数 ⇒ 同样不宣称复现成功（不许拿"跑通"当"复现"）', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const run = await replay(played.record, null)
    expect(run.ok).toBe(false)
    expect(run.reason, '没有结束分数就要说清"无从比对"').toContain('结束状态')
  }, 120_000)

  it('血流口径的记录不硬套：如实报"不适用"', async () => {
    stubWindow()
    const run = await replay({ roundIndex: 1, available: true, initialWall: ['m1'], initialHands: [[], [], [], []] }, [2000, 2000, 2000, 2000])
    expect(run.ok).toBe(false)
    expect(run.reason).toContain('不是翻精癞子的口径')
  }, 30_000)
})