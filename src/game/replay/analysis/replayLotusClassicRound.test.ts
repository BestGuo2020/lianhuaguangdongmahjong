import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGame } from '../../core/local/useGame'
import { createWall } from '../../core/rules/tiles'
import type { AnalysisRecorder, AnalysisWindowInput } from './recorder'
import type { AnalysisReproduction } from './types'
import { replayLotusClassicRound } from './reproduceLotusClassic'

// 广麻 P1 的决定性重跑**快速回归网**：真跑一局（真实引擎 + 固定牌墙/骰子）→ 拿它自己落下的
// 复现数据重跑 → 必须到达同一结束状态（方案 §2.3：不许拿"跑通"当"复现"）。
//
// 与浏览器夹具（`tests/e2e/analysis-lotus-classic.spec.ts` 的 P1 用例）的关系：那边是端到端权威
// （真实 IndexedDB 读回 + 真实浏览器定时器），一次几分钟；这里几秒钟就能把"重跑与记录分叉"卡住，
// 定位也快得多 —— 翻精癞子那份同类文件第一次跑就抓出了"端口少了 flipSeat ⇒ 观测桩抛异常 ⇒
// 窗口编号错乱"这条链。
//
// 为什么 `useGame` 在这里跑得动：它本身不依赖 DOM（`useGame.sim.test.ts` 就是整套模拟），
// 只要把 `window` 的定时器接上、推进假时钟把对局跑完即可。0 号座位是 `HumanController`，
// 由回合倒计时自动出牌（`useGame.sim.test.ts` 的驱动方式），所以整局不需要人工介入。

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

/**
 * 重跑推进一拍。
 * 假时钟把 `Date.now()` 也接管了，所以重跑的上限要放大（见下面的 `deadlineMs`）——
 * 校验器默认 120s 的墙钟上限在假时钟下几十拍就会到。
 */
const tick = async () => { await vi.advanceTimersByTimeAsync(50) }

interface DebugPort {
  phase: { value: string }
  result: { value: unknown }
  players: Array<{ score: number; hand: string[] }>
}

/** 真跑一局的摘要（只取这一局）。 */
async function playOneRound(seed: number) {
  const played = await playRounds(seed, 1)
  const first = played.rounds[0]!
  return {
    record: first.record,
    endScores: first.endScores,
    firstRing: played.firstRing,
    recordedGaps: played.recordedGaps,
  }
}

interface PlayedRound {
  record: AnalysisReproduction
  endScores: number[]
}

/**
 * 真跑若干局（0 号座位由倒计时自动出牌），逐局返回"它自己落下的复现数据"与那一局的结束分数。
 *
 * 为什么必须能跑**多局**：第 2 局起的**庄家不是 0**（`advanceMatchState` 按谁和牌推进），
 * 而庄家决定发牌起点。只测第 1 局会把"重跑忘了带庄家"这类缺陷整个漏掉
 * （实测：e2e 里第 2 局就是这么红的 —— 记录里 13 张的那一家，重跑发到 14 张）。
 */
async function playRounds(seed: number, rounds: number) {
  const captured: Captured = { reproduction: [], gaps: [] }
  const game = useGame({
    playSound: () => {}, playSoundAndWait: async () => {},
    countdownEnabled: true,
    analysis: capturePort(captured),
  }) as unknown as DebugPort & {
    startGame(mode?: string, options?: Record<string, unknown>): unknown
    nextRound(options?: Record<string, unknown>): void
  }

  let startError: string | null = null
  const started = Promise.resolve(game.startGame('east', {
    initialWall: shuffleWithSeed(seed),
    openingDice: [2, 3],
  })).catch((error) => { startError = error instanceof Error ? error.message : String(error) })

  const endScores: number[][] = []
  let settled = 0
  let steps = 0
  while (settled < rounds && steps < 40_000 && !startError) {
    steps += 1
    if (game.result.value) {
      endScores.push(game.players.map((player) => player.score))
      settled += 1
      if (settled >= rounds) break
      // 推进到下一局：洗牌顺序固定（同一 seed 下每次运行都一样），所以重跑输入也是确定的。
      game.nextRound({ initialWall: shuffleWithSeed(seed + settled * 7919), openingDice: [1, 4] })
      continue
    }
    if (game.phase.value === 'finished' || game.phase.value === 'lobby') break
    await vi.advanceTimersByTimeAsync(1000)
  }
  await started
  expect(startError, '原始对局不该开局失败').toBeNull()
  const records = captured.reproduction
  expect(records.length, `应当落下 ${rounds} 局的复现数据（实为 ${records.length}）`).toBeGreaterThanOrEqual(rounds)
  return {
    records,
    rounds: records.slice(0, rounds).map((record, index): PlayedRound => ({
      record,
      endScores: endScores[index]!,
    })),
    endScoresForFirst: endScores[0]!,
    firstRing: shuffleWithSeed(seed),
    recordedGaps: captured.gaps,
  }
}

/** 确定性洗牌：与引擎默认的 `shuffle(createWall())` 同一个多重集合，只是顺序由 seed 决定。 */
function shuffleWithSeed(seed: number): string[] {
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
  const wall = createWall() as string[]
  for (let i = wall.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const left = wall[i]!
    wall[i] = wall[j]!
    wall[j] = left
  }
  return wall
}

const replay = (reproduction: AnalysisReproduction, expectedScores: number[] | null) => replayLotusClassicRound({
  reproduction,
  // 原样交出命令日志（不预过滤 `resolution`）：跳过哪些条目必须由校验器自己计数并报出来。
  commands: reproduction.commands ?? [],
  expectedScores,
  tick,
  // 假时钟下 `Date.now()` 跟着跳：上限放大（真实浏览器里 120s 绰绰有余）。
  deadlineMs: 3_600_000,
})

describe('广麻 P1：重跑一局（§2.2、§2.3、§3.3）', () => {
  it('用记录里的复现数据重跑 ⇒ 逐条消费命令、到达同一结束状态', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const record = played.record

    // 记录本身先立住：环状牌墙 136 张（与开局用的那一副逐位相同）、骰子两粒、庄家、四家开局分、
    // 发牌后手牌、命令日志非空
    expect(record.variant).toBe('lotus-classic')
    expect(record.ringWall).toHaveLength(136)
    expect(record.ringWall, '快照里的牌墙必须是开局真正用的那一副（逐位相同）').toEqual(played.firstRing)
    expect(record.dice?.first, '开局掷骰（两粒）').toHaveLength(2)
    expect(record.dealer, '第 1 局的庄家').toBe(0)
    expect(record.openingScores, '四家开局分').toEqual([1000, 1000, 1000, 1000])
    expect(record.postDealHands, '四家发牌后手牌').toHaveLength(4)
    expect(record.commands?.length ?? 0, '命令日志不能是空的').toBeGreaterThan(0)
    // 命令条目的 `windowKind` 与决策记录**同一口径**（`AnalysisWindowKind`，不是引擎内部的 `turn`）
    expect(record.commands?.map((entry) => entry.windowKind)).toContain('draw-turn')
    expect(played.recordedGaps, '录制期间不该留缝').toEqual([])
    // 广麻没有翻精 ⇒ 这几项在记录里**不存在**（不是空值）
    expect(record.flipTile).toBeUndefined()
    expect(record.jokers).toBeUndefined()
    expect(record.dice?.second).toBeUndefined()

    const run = await replay(record, played.endScores)
    expect(run.ok, `重跑失败：${run.reason}`).toBe(true)
    expect(run.postDealCheck.checked, '必须真的做了发牌后手牌的交叉校验').toBe(true)
    expect(run.postDealCheck.ok).toBe(true)
    expect(run.openingCheck.checked, '必须校验开牌断点').toBe(true)
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
    // §4「被拒动作不出现」：日志里没有非命令口径的条目，且每条命令在记录时都落在当时的合法动作里
    expect(run.metrics.nonCommandEntries, '不该有 expire/auto 这类非命令口径的条目').toBe(0)
    expect(run.metrics.commandsNotLegalAtRecordTime, '不该把当时不合法的动作记进来').toBe(0)
    expect(run.metrics.windowsOpened, '重跑开出的窗口数应当与命令条数一致').toBe(run.metrics.commandsRecorded)
    expect(run.gaps, '重跑期间不该留缝').toEqual([])
  }, 300_000)

  it('把 postDealHands 动一张（只改顺序）⇒ 报「发牌算法变了或记录与引擎不一致」并**一条命令都不喂**', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const first = played.record.postDealHands![0]
    expect(first!.length, '庄家起手 14 张，够做"只改顺序"的篡改').toBeGreaterThan(1)
    const tampered: AnalysisReproduction = {
      ...played.record,
      // 把首张挪到末尾：**牌的多重集合没变、只有顺序变了** —— 这道闸必须是按位置比的
      postDealHands: played.record.postDealHands!.map((hand, seat) => (
        seat === 0 ? [...hand.slice(0, -1), hand[0]!] : [...hand]
      )),
    }

    const run = await replay(tampered, played.endScores)
    expect(run.ok, '记录被动过就不能再声称复现成功').toBe(false)
    expect(run.reason, '失败原因必须点明是发牌算法/记录与引擎不一致').toContain('发牌算法变了或记录与引擎不一致')
    expect(run.postDealCheck.checked).toBe(true)
    expect(run.postDealCheck.ok).toBe(false)
    expect(run.metrics.commandsConsumed, '发现不一致之后不许再喂任何命令（更不许跳过它把这一局跑完）').toBe(0)
  }, 300_000)

  it('记录里没有开局分数 ⇒ 如实报「不可比对」，不拿跑出来的数字硬比', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const { openingScores: _dropped, ...withoutScores } = played.record

    const run = await replay(withoutScores as AnalysisReproduction, played.endScores)
    expect(run.ok).toBe(false)
    expect(run.reason, '缺开局分要报"不可比对"，而不是报"牌流复现失败"').toContain('不可比对')
    expect(run.metrics.commandsConsumed, '压根不该开始跑').toBe(0)
  }, 300_000)

  it('记录里没有可比的结束分数 ⇒ 同样不宣称复现成功（不许拿"跑通"当"复现"）', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const run = await replay(played.record, null)
    expect(run.ok).toBe(false)
    expect(run.reason, '没有结束分数就要说清"无从比对"').toContain('结束状态')
  }, 300_000)

  it('命令日志里混进非命令口径的条目（expire/auto）⇒ 如实报错，不静默过滤、也不开跑', async () => {
    stubWindow()
    const played = await playOneRound(20_260_921)
    const withExpire: AnalysisReproduction = {
      ...played.record,
      // `expire`/`auto` 是血流权威端的推进口径（`expireEntry`、`resolution:'auto'`）：
      // 广麻没有靠超时推进的窗口，掺进来必须被指出来，而不是过滤掉之后"跑绿"。
      commands: [
        ...(played.record.commands ?? []),
        { seat: -1, kind: 'expire', at: 1, resolution: 'expire' as const, windowId: '1/window/99' },
      ],
    }
    const run = await replay(withExpire, played.endScores)
    expect(run.ok, '记录口径不对就不能声称复现成功').toBe(false)
    expect(run.reason, '必须点明是哪一类条目').toContain('expire')
    expect(run.reason, '必须说清为什么不能重放').toContain('无法重放')
    expect(run.metrics.nonCommandEntries, '跳过了多少条要计数').toBe(1)
    expect(run.metrics.commandsConsumed, '一条都不该喂').toBe(0)
  }, 300_000)

  it('翻精癞子/血流口径的记录不硬套：如实报"不适用"', async () => {
    stubWindow()
    // 翻精癞子的记录**也**带 ringWall（两个玩法的重跑起点同为环状牌墙），所以判据必须看 variant：
    // 只看"有没有 ringWall"会把这份记录硬套进来，然后因为它多带了精牌字段而跑出另一副牌。
    const run = await replay({
      roundIndex: 1, available: true, variant: 'lotus-legacy',
      ringWall: playOneRoundRing(), dice: { first: [1, 2], second: [3, 4] },
      dealer: 0, openingScores: [2000, 2000, 2000, 2000], postDealHands: [[], [], [], []],
      jokers: ['m1'], flipTile: 'm1', wallBreakIndex: 0, commands: [],
    }, [2000, 2000, 2000, 2000])
    expect(run.ok).toBe(false)
    expect(run.reason).toContain('不是莲花广麻的口径')
    expect(run.metrics.commandsConsumed, '路径不对就一条都不该喂').toBe(0)

    const bloodFlow = await replay({ roundIndex: 1, available: true, initialWall: ['m1'], initialHands: [[], [], [], []] }, null)
    expect(bloodFlow.ok).toBe(false)
    expect(bloodFlow.reason).toContain('不是莲花广麻的口径')
  }, 60_000)

  it('整场每一局都能重跑（含**庄家不是 0** 的那些局）⇒ 逐局到达同一结束状态', async () => {
    // 这条用例专治"重跑忘了带庄家"：`advanceMatchState` 会让庄家随和牌者推进，所以第 2 局起
    // 庄家往往不是 0。庄家决定发牌起点 —— 沿用默认 0 就会让记录里 13 张的那一家在重跑里发到
    // 14 张（实测 e2e 第 2 局就是这么红的）。
    stubWindow()
    const played = await playRounds(20_260_921, 3)
    expect(played.rounds.length, '至少要跑到 3 局').toBeGreaterThanOrEqual(3)
    // 前提成立才说明这条用例有证据力：这几局的庄家里必须出现**非 0** 的那一个
    const dealers = played.rounds.map((round) => round.record.dealer)
    expect(dealers.some((dealer) => dealer !== 0), `庄家序列 [${dealers.join('/')}] 里必须出现非 0`).toBe(true)
    // 每局的开局分必须是"上一局的结束分"，不是初始分 —— 否则第 2 局以后的结束分数根本不可比
    expect(played.rounds[1]!.record.openingScores, '第 2 局的开局分是第 1 局的结束分')
      .toEqual(played.rounds[0]!.endScores)

    for (const round of played.rounds) {
      const where = `第 ${round.record.roundIndex} 局（庄家 ${round.record.dealer}）`
      const run = await replay(round.record, round.endScores)
      expect(run.ok, `${where}重跑未到达同一结束状态：${run.reason ?? '（没给原因）'}`).toBe(true)
      expect(run.postDealCheck.ok, `${where}发牌后手牌必须与记录一致`).toBe(true)
      expect(run.openingCheck.ok, `${where}开牌断点必须与记录一致`).toBe(true)
      expect(run.scoresMatch, `${where}结束分数必须与记录一致`).toBe(true)
      expect(run.metrics.commandsConsumed, `${where}命令必须全部被消费`).toBe(run.metrics.commandsRecorded)
      expect(run.metrics.unusedCommands, `${where}不许有没被消费的命令`).toBe(0)
      expect(run.kindMismatches, `${where}窗口类型必须逐窗口对上`).toBe(0)
      expect(run.gaps, `${where}重跑期间不该留缝：${run.gaps.join(' | ')}`).toEqual([])
    }
  }, 600_000)
})

/** 一副合法的环状牌墙（判据分派用例只关心 `variant`，牌墙内容不重要）。 */
function playOneRoundRing(): string[] {
  return createWall() as string[]
}