// 莲花广麻的分析记录接线（约定 §9 的 P0 判据里"记录不得影响对局"这条硬护栏）。
//
// 两条断言：
// ① 开/关分析记录各跑同一场（同一随机序列 ⇒ 同一牌墙、同一骰子、同一 AI 选择）：
//    展示回放事件轨迹与结束分数必须**逐项相同** —— 记录是纯旁路，不能改变任何决策。
// ② 开着记录时写入的内容自身要自洽：窗口 ID 本局内唯一、选择的 ID 一定在合法动作里、
//    前态去重、结算四家变化之和为 0。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from './useGame'
import type { AnalysisRecorder } from '../../replay/analysis/recorder'
import type {
  AnalysisChoiceInput, AnalysisReceiptInput, AnalysisWindowInput,
} from '../../replay/analysis/recorder'
import type { AnalysisSettlement } from '../../replay/analysis/types'
import type { ReplayRecorderHooks } from '../../replay/types'

function stubWindow() {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  })
}

/** 确定性伪随机：同一 seed 下两次跑出完全一样的牌墙、骰子与 AI 选择。 */
function seedRandom(seed = 987_654_321) {
  let state = seed >>> 0
  vi.spyOn(Math, 'random').mockImplementation(() => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 展示回放事件轨迹：用它当"对局动作序列"的指纹（与分析记录完全独立）。 */
function replayTrace() {
  const events: string[] = []
  const hooks: ReplayRecorderHooks = {
    roundStart: (frame) => events.push(`round:${frame.round}`),
    draw: (event) => events.push(`draw:${event.seat}:${event.tile}`),
    discard: (event) => events.push(`discard:${event.seat}:${event.tile}`),
    tableAction: (event) => events.push(`action:${event.type}:${event.actorIndex}:${event.tile}`),
    roundEnd: (result) => events.push(`end:${result.draw ? 'draw' : result.winnerIndex}`),
  }
  return { hooks, events }
}

/** 只监听的假录制器：把调用原样收下来，不落库（本用例关心的是"记了什么"）。 */
function spyRecorder() {
  const windows: AnalysisWindowInput[] = []
  const choices: AnalysisChoiceInput[] = []
  const receipts: AnalysisReceiptInput[] = []
  const settlements: Array<Omit<AnalysisSettlement, 'id'> & { id?: string }> = []
  const gaps: Array<{ scope: string; reason: string }> = []
  const recorder: AnalysisRecorder = {
    enabled: true,
    paused: () => false,
    beginMatch: () => 'config/1',
    windowOpened: (input) => { windows.push(input) },
    candidates: () => {},
    promptTemplate: () => {},
    chosen: (input) => { choices.push(input) },
    source: () => {},
    receipt: (input) => { receipts.push(input) },
    attemptStarted: () => '',
    attemptFinished: () => {},
    settlement: (input) => { settlements.push(input) },
    reproduction: () => {},
    noteGap: (gap) => { gaps.push({ scope: gap.scope, reason: gap.reason }) },
    flush: async () => {},
    finish: async () => ({ status: 'complete', bytes: 0 }),
    diagnostics: () => ({ decisions: choices.length, attempts: 0, pendingParts: 0, pendingBytes: 0, paused: false }),
  }
  return { recorder, windows, choices, receipts, settlements, gaps }
}

/** 打满一整场「东风场」（与分析记录无关的驱动逻辑照抄 useGame.sim.test.ts）。 */
async function playMatch(options: { analysis?: AnalysisRecorder | null } = {}) {
  seedRandom()
  const trace = replayTrace()
  const game = useGame({
    playSound: () => {}, playSoundAndWait: async () => {},
    countdownEnabled: true,
    recorder: trace.hooks,
    analysis: options.analysis ?? null,
  })
  const startPromise = game.startGame('east')
  const settledRounds: string[] = []
  let steps = 0
  while (steps < 8000) {
    steps += 1
    if (game.matchFinished.value || game.phase.value === 'finished') break
    if (game.phase.value === 'settled') {
      settledRounds.push(String(game.round.value))
      game.nextRound()
      continue
    }
    if (game.phase.value === 'lobby') break
    await vi.advanceTimersByTimeAsync(1000)
  }
  await startPromise
  return {
    finished: game.matchFinished.value || game.phase.value === 'finished',
    settledRounds,
    scores: game.players.map((player) => player.score),
    events: trace.events,
  }
}

describe('记录不得影响对局（硬护栏）', () => {
  it('开/关分析记录跑同一场：动作序列与结束分数逐项相同', async () => {
    stubWindow()
    const without = await playMatch()
    const spy = spyRecorder()
    const withAnalysis = await playMatch({ analysis: spy.recorder })

    expect(without.finished).toBe(true)
    expect(withAnalysis.finished).toBe(true)
    expect(withAnalysis.settledRounds).toEqual(without.settledRounds)
    // 牌墙/骰子/AI 都由同一随机序列决定 ⇒ 动作轨迹必须一模一样
    expect(withAnalysis.events).toEqual(without.events)
    expect(withAnalysis.scores).toEqual(without.scores)
    // 而分析记录确实写了东西（不是"因为没记所以没影响"）
    expect(spy.windows.length).toBeGreaterThan(0)
    expect(spy.choices.length).toBe(spy.windows.length)
  }, 120_000)

  it('不传 analysis 时行为与旧路径一致（同 seed 两次都没记录 ⇒ 也逐项相同）', async () => {
    stubWindow()
    const first = await playMatch()
    const second = await playMatch()
    expect(second.events).toEqual(first.events)
    expect(second.scores).toEqual(first.scores)
  }, 120_000)
})

describe('记录内容自洽（§3.1／§3.2／§5）', () => {
  it('窗口 ID 本局内唯一、合法动作齐备、结算四家变化之和为 0', async () => {
    stubWindow()
    const spy = spyRecorder()
    await playMatch({ analysis: spy.recorder })

    // 窗口 ID 不重复（`roundId/window/N`，N 每局自增 ⇒ 本局内唯一）
    const windowIds = spy.windows.map((window) => window.windowId)
    expect(new Set(windowIds).size).toBe(windowIds.length)
    for (const windowId of windowIds) expect(windowId).toMatch(/^\d+\/window\/\d+$/)

    // 每个窗口的前态都有合法动作，且前态按 id 去重（同一份前态不重复落库）
    const stateIds = spy.windows.map((window) => window.state.id)
    expect(new Set(stateIds).size).toBe(stateIds.length)
    for (const window of spy.windows) expect(window.state.legalActions?.length ?? 0).toBeGreaterThan(0)

    // 每个窗口恰好一条选择；选中的 ID 必须在该窗口的合法动作里（或明确为 null）
    const byWindow = new Map(spy.windows.map((window) => [`${window.windowId}#${window.seat}`, window]))
    for (const choice of spy.choices) {
      const window = byWindow.get(`${choice.windowId}#${choice.seat}`)
      expect(window, `选择找不到对应窗口 ${choice.windowId}`).toBeDefined()
      if (choice.legalActionId === null) continue
      expect(window!.state.legalActions!.map((action) => action.id)).toContain(choice.legalActionId)
    }

    // 回执只在观察/判定得到时写，且不重复写同一个窗口
    const receiptKeys = spy.receipts.map((receipt) => `${receipt.windowId}#${receipt.seat}`)
    expect(new Set(receiptKeys).size).toBe(receiptKeys.length)
    expect(spy.receipts.every((receipt) => (
      receipt.status === 'executed' || receipt.status === 'state-changed'
    ))).toBe(true)

    // 结算：四家变化之和恒为 0；相邻两条流水必须首尾相接（没有漏记的分数变化）
    expect(spy.settlements.length).toBeGreaterThan(0)
    for (const settlement of spy.settlements) {
      expect(settlement.deltas.reduce((sum, delta) => sum + delta, 0)).toBe(0)
      expect(settlement.scoresAfter).toHaveLength(4)
    }
    for (let index = 1; index < spy.settlements.length; index += 1) {
      const previous = spy.settlements[index - 1]!
      const next = spy.settlements[index]!
      next.deltas.forEach((delta, seat) => {
        expect(next.scoresAfter[seat]).toBe((previous.scoresAfter[seat] ?? 0) + delta)
      })
    }
    // 分数守恒：四条流水从头到尾总和不变
    const total = spy.settlements[0]!.scoresAfter.reduce((sum, score) => sum + score, 0)
    const last = spy.settlements[spy.settlements.length - 1]!
    expect(last.scoresAfter.reduce((sum, score) => sum + score, 0)).toBe(total)
  }, 120_000)

  it('座位控制方式：本家记 human、默认启发式 AI 记为本地来源', async () => {
    stubWindow()
    const spy = spyRecorder()
    await playMatch({ analysis: spy.recorder })
    const sources = new Set(spy.choices.map((choice) => choice.source))
    expect(sources.has('human')).toBe(true)
    expect(sources.has('local-strategy') || sources.has('rule-auto')).toBe(true)
    // 本用例没有 LLM 座位
    expect(sources.has('model')).toBe(false)
  }, 120_000)
})
