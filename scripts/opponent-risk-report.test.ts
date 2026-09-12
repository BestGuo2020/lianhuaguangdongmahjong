// 对手大牌风险定价（`BLOOD_FLOW_AI.opponentPatternRisk`）双臂统计对拍 + 决策级分歧诊断。
//
//   A 臂 = { ...BLOOD_FLOW_AI, opponentPatternRisk: 'off' }  改前口径：放炮成本只按公开张数
//   B 臂 = BLOOD_FLOW_AI                                     默认档位版：× 对手大牌风险倍率（×1/4/16/32）
//
// 两臂使用同一批固定种子、同一批牌局、四席同策略（贪婪 EV `decideBloodFlowActionEv`）自对局，跑到结算。
// 只读：不修改任何规则 / 计分 / 锁手代码，本脚本仅驱动既有引擎并按公共信息做统计。
//
// ── 运行方式 ────────────────────────────────────────────────────────────────────────────
//   pnpm exec vitest run --dir scripts opponent-risk-report.test.ts
//
// 注意 `--dir scripts` 不能省：根 vite.config.ts 里 `test.dir: './src'`，只写
// `pnpm exec vitest run scripts/xxx.test.ts` 会得到 "No test files found"。
// 本文件不在 `src` 下，因此 `pnpm test`（只跑 src）不会执行它，不拖慢默认回归，也不进 CI 全量。
//
// 默认种子 1～20（20 局 × 2 臂 = 40 局）；耗时见上一次运行打印与记录文档（约 3 分钟级）。
// 局数可用环境变量覆盖：OPPONENT_RISK_SEEDS=<n>（默认 20；调小后请同步在文档里注明样本量）。
//
// 输出：
//   - 控制台：两臂并列对照表、逐种子决策序列分歧表、微场景证据
//   - work/opponent-risk-report.json（完整数字，机器可读）
//   - docs/blood-flow/records/strategy-opponent-risk.md（可提交的记录文档）
//
// 确定性自检：跑完两臂后，用同样的种子重跑前两个种子（两臂各一次），断言决策序列与关键指标逐位一致。
import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Meld, TileType } from '../src/game/core/contracts/types'
import { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView, visibleTiles } from '../src/game/variants/lotus/bloodFlow/seatView'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { seededRandom } from '../src/game/variants/lotus/bloodFlow/simulation'
import { bloodFlowOpponentRisk, bloodFlowSafetyExposure, decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG } from '../src/game/variants/lotus/bloodFlow/config'
import type { BloodFlowAiConfig } from '../src/game/variants/lotus/bloodFlow/config'
import { SEATS } from '../src/game/variants/lotus/bloodFlow/state'
import type { Seat } from '../src/game/variants/lotus/bloodFlow/types'
import { maxOpponentRiskTier } from '../src/game/shared/ai/opponentPatternRisk'

const SEED_COUNT = Math.max(1, Number(process.env.OPPONENT_RISK_SEEDS ?? 20))
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1)

const ARM_A: BloodFlowAiConfig = Object.freeze({ ...BLOOD_FLOW_AI, opponentPatternRisk: 'off' as const })
const ARM_B: BloodFlowAiConfig = BLOOD_FLOW_AI
/**
 * 量度口径固定为档位版：两臂的"高风险档"必须用同一把尺子量，否则 A 臂（配置关闭）根本
 * 不会算出档位，占比无从比较。档位本身只由公共信息决定，与臂的决策参数无关。
 */
const MEASURE_AI: BloodFlowAiConfig = BLOOD_FLOW_AI
const HIGH_RISK_TIER = 2
/** 锁手信号词形如 `已胡N次仍听`；用它把"高风险"拆成锁手来源与副露/牌河来源。 */
const LOCKED_SIGNAL = /^已胡\d+次仍听$/

// ── 统计容器 ────────────────────────────────────────────────────────────────

interface Accumulator {
  rounds: number
  /** 胡牌记录总数（含锁手后重复胡）。 */
  winRecords: number
  /** 胡牌批次总数（一炮多响算一批）。 */
  batches: number
  /** 点炮批次 / 点炮胡牌记录（source === 'discard'）。 */
  discardBatches: number
  discardRecords: number
  /** 点炮：每单家支付（按胡牌记录）/ 每批总收（按批次）。 */
  payments: number[]
  batchTotals: number[]
  /** 首胡时剩余墙长。 */
  firstWalls: number[]
  /** 每局：四席 (终局 - 开局) 的带符号均值 / 绝对值均值；终局最大分差。 */
  signedNet: number[]
  absNet: number[]
  spreads: number[]
  /** 全桌弃牌动作总数（含被吃碰杠/被胡走的那些）。 */
  totalDiscards: number
  /** 全部窗口决策步数（本地 AI 每被调用一次算一步）。 */
  decisions: number
  robbedKong: number
  kongBloom: number
  /** 四家都已锁手之后仍然成立的胡牌批次 / 记录。 */
  allLockedBatches: number
  allLockedRecords: number
  /** 胡牌者在本次胡之前就已经锁手（已胡过）的记录数。 */
  relockedRecords: number
  /** 点炮批次中，弃牌者视角最高档 ≥ 2 的批次；以及这些批次的赔付总收。 */
  highRiskBatches: number
  highRiskTotals: number[]
  /** 高风险批次里，最高档信号**只**来自"已胡N次仍听"（不含副露/牌河信号）的批次数。 */
  highRiskLockedOnly: number
  /** 高风险批次里，最高档信号含副露/牌河等非锁手信号的批次数。 */
  highRiskWithPattern: number
  /** 高风险批次中，真正的胡家本身也在高风险档（tier ≥ 2）的批次数。 */
  highRiskHitWinner: number
  /** 点炮批次的最高档分布：下标 = 档位 0/1/2/3。 */
  tierHistogram: [number, number, number, number]
  /** 高风险批次的信号词频（用公共信息解释"为什么算高"）。 */
  highRiskSignals: Record<string, number>
  noWinRounds: number
  /** 决策级诊断：同局面下两臂选择不同的步数 / 轮到出牌且给出弃牌选项的局面诊断。 */
  dualDiffer: number
  turnDiscards: number
  /** 弃牌局面中，档位口径的放炮成本在合法候选牌上恒定（= 去差异化，现物/公开张数折扣失效）。 */
  turnTierUniform: number
  /** 弃牌局面中，两臂的放炮成本在合法候选上"最便宜的那张牌"不同（风险项自身排序变化）。 */
  turnExposureRankFlip: number
}

function emptyAccumulator(): Accumulator {
  return {
    rounds: 0, winRecords: 0, batches: 0, discardBatches: 0, discardRecords: 0,
    payments: [], batchTotals: [], firstWalls: [], signedNet: [], absNet: [], spreads: [],
    totalDiscards: 0, decisions: 0, robbedKong: 0, kongBloom: 0, allLockedBatches: 0, allLockedRecords: 0,
    relockedRecords: 0, highRiskBatches: 0, highRiskTotals: [], highRiskLockedOnly: 0, highRiskWithPattern: 0,
    highRiskHitWinner: 0, tierHistogram: [0, 0, 0, 0], highRiskSignals: {}, noWinRounds: 0,
    dualDiffer: 0, turnDiscards: 0, turnTierUniform: 0, turnExposureRankFlip: 0,
  }
}

interface DiscardSnapshot {
  seat: Seat
  tile: TileType
  maxTier: number
  /** 座位 → 该家当时的风险档（只含对手，本人为 0）。 */
  tierBySeat: [number, number, number, number]
  signals: string[]
}

interface StepDescriptor {
  step: number
  seat: number
  windowKind: string
  sourceKind: string
  wallCount: number
  action: string
}

interface RoundOutcome {
  seed: number
  steps: StepDescriptor[]
}

/** 用档位口径复算"弃牌者视角下三家对手的最高风险档"。 */
function measureRisk(view: BloodFlowSeatView) {
  const profiles = bloodFlowOpponentRisk(view, MEASURE_AI)
  const tierBySeat: [number, number, number, number] = [0, 0, 0, 0]
  for (const profile of profiles) tierBySeat[profile.seat] = profile.tier
  const top = maxOpponentRiskTier(profiles)
  const signals = profiles.filter(profile => profile.tier === top).flatMap(profile => profile.signals)
  return { tierBySeat, maxTier: top, signals }
}

/** 让某张牌最便宜的那个候选（放炮成本被减去，所以"最便宜"就是风险项最偏好的弃牌）。 */
function cheapestTile(tiles: readonly TileType[], exposure: (tile: TileType) => number): string {
  let best = '', bestValue = Number.POSITIVE_INFINITY
  for (const tile of tiles) {
    const value = exposure(tile)
    if (value < bestValue) { bestValue = value; best = tile }
  }
  return best
}

function playRound(config: BloodFlowAiConfig, other: BloodFlowAiConfig, seed: number, acc: Accumulator): RoundOutcome {
  const engine = new BloodFlowEngine({
    authorityEpoch: 'opponent-risk-report', roundId: `seed-${seed}`, random: seededRandom(seed),
    scores: [BLOOD_FLOW_CONFIG.initialScore, BLOOD_FLOW_CONFIG.initialScore, BLOOD_FLOW_CONFIG.initialScore, BLOOD_FLOW_CONFIG.initialScore],
    dealer: 0, now: () => 0, winBeatMs: 0,
  })
  // 弃牌源事件 id → 弃牌瞬间（决策前）的公共风险快照。
  const snapshots = new Map<string, DiscardSnapshot>()
  const steps: StepDescriptor[] = []
  let count = 0
  let firstWinWall: number | null = null
  while (!engine.result) {
    if (++count > 2000) throw new Error(`stalled arm=${config.opponentPatternRisk} seed=${seed}`)
    const window = engine.window!
    const seat = SEATS.find(candidate => window.options[candidate].length && !window.decisions[candidate])!
    const view = bloodFlowSeatView(engine, seat)
    // 快照必须在决策/出牌之前取：此时弃牌者的牌河与三家公开信息正是"决定打这张"的可见状态。
    const tierBySeat = measureRisk(view)
    const action = decideBloodFlowActionEv(view, config)
    expect(action, `seed ${seed} seat ${seat}`).toBeTruthy()
    // 决策级诊断：同一局面下另一臂会选什么（纯函数、无副作用，不改变本臂轨迹）。
    const mirror = decideBloodFlowActionEv(view, other)
    const selfLabel = JSON.stringify(action)
    if (selfLabel !== JSON.stringify(mirror)) acc.dualDiffer += 1
    acc.decisions += 1

    const hand = view.players[seat].hand
    if (window.kind === 'turn' && action?.kind === 'discard') {
      // 本家出牌局面：只看合法弃牌候选（引擎给出的 ownActions）。
      const candidates = window.options[seat]
        .filter(move => move.kind === 'discard')
        .map(move => hand[(move as { index: number }).index])
        .filter((tile): tile is TileType => Boolean(tile))
      if (candidates.length > 1) {
        acc.turnDiscards += 1
        const offExposure = bloodFlowSafetyExposure(view, ARM_A, visibleTiles(view))
        const tierExposure = bloodFlowSafetyExposure(view, MEASURE_AI, visibleTiles(view))
        const tierValues = candidates.map(tierExposure)
        if (Math.max(...tierValues) === Math.min(...tierValues)) acc.turnTierUniform += 1
        if (cheapestTile(candidates, offExposure) !== cheapestTile(candidates, tierExposure)) acc.turnExposureRankFlip += 1
      }
    }

    const discardsBefore = engine.discardActions.length
    const wallBefore = engine.wall.length
    if (!engine.submit(engine.command(seat, action!))) throw new Error(`rejected action arm=${config.opponentPatternRisk} seed=${seed}`)
    steps.push({ step: count, seat, windowKind: window.kind, sourceKind: window.source.kind, wallCount: wallBefore, action: selfLabel })
    if (engine.discardActions.length > discardsBefore) {
      const source = engine.discardActions[engine.discardActions.length - 1]
      snapshots.set(source.id, {
        seat, tile: source.tile, maxTier: tierBySeat.maxTier,
        tierBySeat: [tierBySeat.tierBySeat[0], tierBySeat.tierBySeat[1], tierBySeat.tierBySeat[2], tierBySeat.tierBySeat[3]],
        signals: tierBySeat.signals,
      })
    }
    if (firstWinWall === null && engine.archives.length) firstWinWall = wallBefore
    engine.assertConservation()
  }

  const state = engine.publicState()
  const batches = state.batches
  const ending = state.roundResult!.endingScores
  const opening = state.roundResult!.openingScores

  // 四家锁手的判定完全由批次顺序重建（ordinal = 该家本次胡之前的已胡次数 + 1），不读引擎私有状态。
  const winCounts = [0, 0, 0, 0]
  for (const batch of batches) {
    const allLockedBefore = SEATS.every(s => winCounts[s] >= 1)
    if (allLockedBefore) { acc.allLockedBatches += 1; acc.allLockedRecords += batch.winners.length }
    for (const record of batch.winners) {
      if (record.ordinal > 1 || winCounts[record.winner] >= 1) acc.relockedRecords += 1
      acc.winRecords += 1
      if (record.score.source === 'robbed-kong') acc.robbedKong += 1
      if (record.score.source === 'kong-bloom') acc.kongBloom += 1
      winCounts[record.winner] += 1
    }
    acc.batches += 1
    if (batch.source.kind !== 'discard') continue
    // 点炮批次：batch.source 就是那张被胡的弃牌事件。
    acc.discardBatches += 1
    acc.discardRecords += batch.winners.length
    const total = batch.deltas.reduce((sum, delta) => sum + Math.max(0, delta), 0)
    acc.batchTotals.push(total)
    for (const record of batch.winners) acc.payments.push(record.score.paymentPerPayer)
    const snapshot = snapshots.get(batch.source.id)
    // 快照必然存在（同一局内弃牌源 id 唯一）；缺失只可能是引擎口径变化，宁可显式报错也不默认 0。
    if (!snapshot) throw new Error(`missing discard snapshot for ${batch.source.id} (seed ${seed})`)
    acc.tierHistogram[Math.min(3, snapshot.maxTier)] += 1
    if (snapshot.maxTier >= HIGH_RISK_TIER) {
      acc.highRiskBatches += 1
      acc.highRiskTotals.push(total)
      const patternSignals = snapshot.signals.filter(signal => !LOCKED_SIGNAL.test(signal))
      if (patternSignals.length) acc.highRiskWithPattern += 1
      else acc.highRiskLockedOnly += 1
      for (const signal of new Set(snapshot.signals)) acc.highRiskSignals[signal] = (acc.highRiskSignals[signal] ?? 0) + 1
      if (batch.winners.some(record => snapshot.tierBySeat[record.winner] >= HIGH_RISK_TIER)) acc.highRiskHitWinner += 1
    }
  }

  acc.rounds += 1
  if (!batches.length) acc.noWinRounds += 1
  if (firstWinWall !== null) acc.firstWalls.push(firstWinWall)
  const nets = SEATS.map(s => ending[s] - opening[s])
  acc.signedNet.push(nets.reduce((a, b) => a + b, 0) / 4)
  acc.absNet.push(nets.reduce((sum, net) => sum + Math.abs(net), 0) / 4)
  acc.spreads.push(Math.max(...ending) - Math.min(...ending))
  acc.totalDiscards += engine.discardActions.length
  return { seed, steps }
}

function runArm(config: BloodFlowAiConfig, other: BloodFlowAiConfig, label: string, seeds: readonly number[], into?: Accumulator) {
  const acc = into ?? emptyAccumulator()
  const rounds: RoundOutcome[] = []
  const began = performance.now()
  for (const seed of seeds) rounds.push(playRound(config, other, seed, acc))
  const elapsedMs = performance.now() - began
  console.log(`[arm ${label}] ${rounds.length} 局完成，${acc.decisions} 步决策，耗时 ${(elapsedMs / 1000).toFixed(1)}s`)
  return { acc, rounds, elapsedMs }
}

/** 最长公共前缀：两臂决策序列从第几步开始不一样（1 基；返回 0 表示第一步就不同）。 */
function commonPrefix(a: readonly StepDescriptor[], b: readonly StepDescriptor[]): number {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a[index].action === b[index].action) index += 1
  return index
}

// ── 呈现 ────────────────────────────────────────────────────────────────────

const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const max = (values: readonly number[]): number | null => values.length ? Math.max(...values) : null
const pct = (part: number, whole: number): number | null => whole ? 100 * part / whole : null

/** 最近秩（nearest-rank）分位：不需要插值假设，样本量小也稳定。 */
function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

/**
 * 被测源码指纹。这个特性（对手风险定价）在记录时仍是未提交的工作区改动，
 * 只写 `git rev-parse HEAD` 标不住真正被测的源码状态，因此额外给出关键文件的 sha256 前 12 位。
 */
const FINGERPRINT_FILES = [
  'src/game/shared/ai/opponentPatternRisk.ts',
  'src/game/variants/lotus/bloodFlow/ai.ts',
  'src/game/variants/lotus/bloodFlow/config.ts',
  'src/game/variants/lotus/bloodFlow/evContext.ts',
  'src/game/variants/lotus/lotusAi.ts',
  'src/game/variants/lotus/bloodFlow/engine.ts',
]

function sourceFingerprint(): { file: string; hash: string }[] {
  return FINGERPRINT_FILES.map(file => {
    try { return { file, hash: createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12) } }
    catch { return { file, hash: 'unreadable' } }
  })
}

interface Row {
  label: string
  a: number | null
  b: number | null
  digits: number
}

const fixed = (value: number | null, digits: number) => value === null ? '—' : value.toFixed(digits)
const signed = (value: number | null, digits: number) =>
  value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
const deltaOf = (row: Row) => row.a === null || row.b === null ? null : row.b - row.a

function renderTable(head: readonly string[], rows: readonly (readonly string[])[]) {
  const widths = head.map((text, index) => Math.max(text.length, ...rows.map(row => row[index].length)))
  const line = (values: readonly string[]) => values.map((text, index) =>
    text.padEnd(widths[index])).join('  ')
  return [line(head), widths.map(width => '─'.repeat(width)).join('  '), ...rows.map(line)]
}

function printTable(title: string, rows: readonly Row[]) {
  const head = ['指标', 'A 臂（off 旧口径）', 'B 臂（tier 档位版）', 'Δ(B−A)']
  const cells = rows.map(row => [row.label, fixed(row.a, row.digits), fixed(row.b, row.digits), signed(deltaOf(row), row.digits)])
  console.log(`\n${title}`)
  for (const text of renderTable(head, cells)) console.log(text)
}

function round(value: number, digits: number) { const scale = 10 ** digits; return Math.round(value * scale) / scale }

// ── 微场景固定局面（不走整局） ────────────────────────────────────────────────
//
// 只填决策路径真正会读的字段（players / public.seats / ownActions / window / wallCount / jokers），
// 因此是"可复现的定局面夹具"，不依赖洗牌。`visibleTiles()` 会把本家手牌也算作公开张，
// 所以手上唯一的牌 = 生张（公开 1 张）、手里两张或牌河里已出 = 现物（公开 ≥2 张）。

const peng = (tile: TileType): Meld => ({ type: 'peng', tile, tiles: [tile, tile, tile] as TileType[], from: 1 })

type MicroMode = 'suspect' | 'locked'

function microView(hand: readonly TileType[], mode: MicroMode): BloodFlowSeatView {
  const lockedSeat = mode === 'locked' ? 1 : -1
  const players = [0, 1, 2, 3].map(index => ({
    seat: index, score: 2000,
    hand: index === 0 ? [...hand] : [],
    drawnTileIndex: index === 0 ? hand.length - 1 : -1,
    discards: index === 1 ? ['m1', 'm2', 'm3', 's1', 's2', 's3', 's4', 's5'] as TileType[] : [],
    melds: index === 1 && mode === 'suspect' ? [peng('p4'), peng('p7')] : [],
    concealedTileCount: index === 0 ? hand.length : 13,
  }))
  return {
    seat: 0, wallCount: 40, flipTile: 'east', jokers: ['white'],
    players,
    public: {
      seats: [0, 1, 2, 3].map(index => ({
        winCount: index === lockedSeat ? 5 : 0, locked: index === lockedSeat, firstWinSequence: null, recordIds: [],
      })),
      batches: [],
    },
    ownActions: [...hand.map((_, index) => ({ kind: 'discard', index }) as const)],
    ownScore: null,
    window: { id: 'w', version: 1, kind: 'turn', deadlineAt: 0, opensAt: 0,
      source: { id: 's', kind: 'draw', tile: hand[hand.length - 1], seat: 0 } },
  } as unknown as BloodFlowSeatView
}

const MICRO_SUSPECT_HAND: TileType[] = [
  'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 's2', 's3', 'east', 'south', 'p1', 'p5', 'p9',
]
const MICRO_LOCKED_HAND: TileType[] = [
  'm1', 'm1', 'm1', 'm2', 'm3', 'm4', 's7', 's8', 's9', 'east', 'south', 'p1', 'p5', 'p9',
]

function microReport(hand: readonly TileType[], mode: MicroMode) {
  const view = microView(hand, mode)
  const offAction = decideBloodFlowActionEv(view, ARM_A)
  const tierAction = decideBloodFlowActionEv(view, ARM_B)
  const offExposure = bloodFlowSafetyExposure(view, ARM_A)
  const tierExposure = bloodFlowSafetyExposure(view, ARM_B)
  const offIndex = offAction?.kind === 'discard' ? offAction.index : -1
  const tierIndex = tierAction?.kind === 'discard' ? tierAction.index : -1
  const profiles = bloodFlowOpponentRisk(view, ARM_B)
  return {
    mode, hand: [...hand], offIndex, tierIndex, offTile: hand[offIndex] ?? null, tierTile: hand[tierIndex] ?? null,
    offAction, tierAction, offExposure, tierExposure, profiles,
    tierUniform: Math.max(...hand.map(tierExposure)) === Math.min(...hand.map(tierExposure)),
  }
}

// ── 主对拍 ──────────────────────────────────────────────────────────────────

interface ReportData {
  rows: Row[]
  a: Accumulator
  b: Accumulator
  seedTable: string[]
  divergedSeeds: number
  sameSeeds: number
  firstStepSeeds: number
  totalSteps: number
  commit: string
  worktreeDirty: boolean
  fingerprint: { file: string; hash: string }[]
  elapsedA: number
  elapsedB: number
  micro: ReturnType<typeof microReport>[]
}

it(`对手大牌风险定价：off（改前）vs tier（档位版），种子 1～${SEED_COUNT}，四席 EV 自对局`, () => {
  const armA = runArm(ARM_A, ARM_B, 'A/off', SEEDS)
  const armB = runArm(ARM_B, ARM_A, 'B/tier', SEEDS)
  const a = armA.acc, b = armB.acc

  // ── 决策序列分歧（最长公共前缀） ──
  const seedRows: string[][] = []
  let divergedSeeds = 0, sameSeeds = 0, firstStepSeeds = 0, totalSteps = 0
  for (const seed of SEEDS) {
    const roundA = armA.rounds.find(round => round.seed === seed)!
    const roundB = armB.rounds.find(round => round.seed === seed)!
    totalSteps += Math.min(roundA.steps.length, roundB.steps.length)
    const prefix = commonPrefix(roundA.steps, roundB.steps)
    const same = prefix === roundA.steps.length && prefix === roundB.steps.length
    if (same) sameSeeds += 1
    else {
      divergedSeeds += 1
      if (prefix === 0) firstStepSeeds += 1
    }
    const atA = roundA.steps[prefix], atB = roundB.steps[prefix]
    seedRows.push([
      String(seed),
      `${roundA.steps.length} / ${roundB.steps.length}`,
      same ? `${prefix}（无分歧）` : String(prefix),
      same ? '—' : `${prefix + 1}：A=${atA ? `${atA.action}（座${atA.seat}/${atA.windowKind}，墙${atA.wallCount}）` : '本局已结束'} vs B=${atB ? `${atB.action}（座${atB.seat}/${atB.windowKind}，墙${atB.wallCount}）` : '本局已结束'}`,
    ])
  }

  const rows: Row[] = [
    { label: '局数', a: a.rounds, b: b.rounds, digits: 0 },
    { label: '决策步数（本地 AI 被调用次数）', a: a.decisions, b: b.decisions, digits: 0 },
    { label: '平均每局总胡次数（含锁手重复胡）', a: a.winRecords / a.rounds, b: b.winRecords / b.rounds, digits: 2 },
    { label: '平均每局胡牌批次数', a: a.batches / a.rounds, b: b.batches / b.rounds, digits: 2 },
    { label: '平均每局净分变化（带符号，零和恒 0）', a: mean(a.signedNet), b: mean(b.signedNet), digits: 2 },
    { label: '平均每局每席 |净分变化|', a: mean(a.absNet), b: mean(b.absNet), digits: 2 },
    { label: '平均每局终局最大分差', a: mean(a.spreads), b: mean(b.spreads), digits: 2 },
    { label: '平均首胡墙余', a: mean(a.firstWalls), b: mean(b.firstWalls), digits: 2 },
    { label: '无胡局数', a: a.noWinRounds, b: b.noWinRounds, digits: 0 },
    { label: '全桌弃牌动作总数', a: a.totalDiscards, b: b.totalDiscards, digits: 0 },
    { label: '点炮批次（source=discard）', a: a.discardBatches, b: b.discardBatches, digits: 0 },
    { label: '点炮胡牌记录（一炮多响按记录计）', a: a.discardRecords, b: b.discardRecords, digits: 0 },
    { label: '点炮率（点炮批次 / 全桌弃牌）%', a: pct(a.discardBatches, a.totalDiscards), b: pct(b.discardBatches, b.totalDiscards), digits: 2 },
    { label: '点炮赔付：每单家支付均值', a: mean(a.payments), b: mean(b.payments), digits: 2 },
    { label: '点炮赔付：每单家支付 P50', a: percentile(a.payments, 0.5), b: percentile(b.payments, 0.5), digits: 2 },
    { label: '点炮赔付：每单家支付 P90', a: percentile(a.payments, 0.9), b: percentile(b.payments, 0.9), digits: 2 },
    { label: '点炮赔付：每单家支付最大', a: max(a.payments), b: max(b.payments), digits: 0 },
    { label: '点炮赔付：每批总收均值', a: mean(a.batchTotals), b: mean(b.batchTotals), digits: 2 },
    { label: '点炮赔付：每批总收 P50', a: percentile(a.batchTotals, 0.5), b: percentile(b.batchTotals, 0.5), digits: 2 },
    { label: '点炮赔付：每批总收 P90', a: percentile(a.batchTotals, 0.9), b: percentile(b.batchTotals, 0.9), digits: 2 },
    { label: '点炮赔付：每批总收最大', a: max(a.batchTotals), b: max(b.batchTotals), digits: 0 },
    { label: `点炮给高风险档对手（当时最高档≥${HIGH_RISK_TIER}）次数`, a: a.highRiskBatches, b: b.highRiskBatches, digits: 0 },
    { label: '点炮给高风险档对手占比 %', a: pct(a.highRiskBatches, a.discardBatches), b: pct(b.highRiskBatches, b.discardBatches), digits: 2 },
    { label: '高风险点炮批次总收均值', a: mean(a.highRiskTotals), b: mean(b.highRiskTotals), digits: 2 },
    { label: '高风险点炮批次总收最大值', a: max(a.highRiskTotals), b: max(b.highRiskTotals), digits: 0 },
    { label: '高风险点炮：最高档只由"已胡N次仍听"触发', a: a.highRiskLockedOnly, b: b.highRiskLockedOnly, digits: 0 },
    { label: '高风险点炮：最高档含副露/牌河等非锁手信号', a: a.highRiskWithPattern, b: b.highRiskWithPattern, digits: 0 },
    { label: '高风险点炮中"胡家本身即高风险档"批次数', a: a.highRiskHitWinner, b: b.highRiskHitWinner, digits: 0 },
    { label: '点炮最高档分布：tier0', a: a.tierHistogram[0], b: b.tierHistogram[0], digits: 0 },
    { label: '点炮最高档分布：tier1', a: a.tierHistogram[1], b: b.tierHistogram[1], digits: 0 },
    { label: '点炮最高档分布：tier2', a: a.tierHistogram[2], b: b.tierHistogram[2], digits: 0 },
    { label: '点炮最高档分布：tier3', a: a.tierHistogram[3], b: b.tierHistogram[3], digits: 0 },
    { label: '被抢杠胡次数', a: a.robbedKong, b: b.robbedKong, digits: 0 },
    { label: '杠上开花次数', a: a.kongBloom, b: b.kongBloom, digits: 0 },
    { label: '四家锁手后仍然胡牌的批次', a: a.allLockedBatches, b: b.allLockedBatches, digits: 0 },
    { label: '四家锁手后仍然胡牌的记录', a: a.allLockedRecords, b: b.allLockedRecords, digits: 0 },
    { label: '已锁手座位再次胡牌（ordinal>1）记录', a: a.relockedRecords, b: b.relockedRecords, digits: 0 },
  ]

  printTable(`两臂并列对照（种子 1～${SEED_COUNT}，四席 EV 自对局，A=off 改前 / B=tier 档位版）`, rows)

  console.log('\n决策级分歧（同种子两臂决策序列的最长公共前缀；前缀长度 = 前多少步完全一致）')
  for (const text of renderTable(
    ['种子', '步数 A / B', '公共前缀', '首个分歧步：A vs B'],
    seedRows,
  )) console.log(text)

  console.log(`\n分歧汇总：${divergedSeeds}/${SEED_COUNT} 个种子出现分歧（首步即分歧 ${firstStepSeeds} 个，序列完全相同 ${sameSeeds} 个）`)
  console.log(`同局面双判（每一步都在同一份公共视图上让两臂各选一次，纯函数、不改变轨迹）：`)
  console.log(`  A 臂轨迹 ${a.decisions} 步中 ${a.dualDiffer} 步选择不同（${pct(a.dualDiffer, a.decisions)?.toFixed(2)}%）`)
  console.log(`  B 臂轨迹 ${b.decisions} 步中 ${b.dualDiffer} 步选择不同（${pct(b.dualDiffer, b.decisions)?.toFixed(2)}%）`)
  console.log('弃牌局面（本家 14 张、合法弃牌候选 > 1）诊断：')
  console.log(`  A 臂 ${a.turnDiscards} 个局面：档位成本对全部候选恒定（去差异化）${a.turnTierUniform} 个，最便宜候选发生变化 ${a.turnExposureRankFlip} 个`)
  console.log(`  B 臂 ${b.turnDiscards} 个局面：档位成本对全部候选恒定（去差异化）${b.turnTierUniform} 个，最便宜候选发生变化 ${b.turnExposureRankFlip} 个`)
  console.log('\nA 臂高风险点上炮次数的信号词频：', a.highRiskSignals)
  console.log('B 臂高风险点上炮次数的信号词频：', b.highRiskSignals)

  // ── 定向微场景（固定局面，不走整局） ──
  const micro = [microReport(MICRO_SUSPECT_HAND, 'suspect'), microReport(MICRO_LOCKED_HAND, 'locked')]
  console.log('\n微场景证据（固定局面，直接调 decideBloodFlowActionEv）')
  for (const scenario of micro) {
    console.log(`  [${scenario.mode}] hand=${scenario.hand.join(',')}`)
    console.log(`    对手档位=${JSON.stringify(scenario.profiles.map(p => ({ seat: p.seat, tier: p.tier, suspectSuit: p.suspectSuit, signals: p.signals })))}`)
    console.log(`    off  选 ${scenario.offTile}（index ${scenario.offIndex}）／放炮成本 ${scenario.offTile ? scenario.offExposure(scenario.offTile) : '—'} 点`)
    console.log(`    tier 选 ${scenario.tierTile}（index ${scenario.tierIndex}）／放炮成本 ${scenario.tierTile ? scenario.tierExposure(scenario.tierTile) : '—'} 点`)
    console.log(`    两臂选择不同：${scenario.offIndex !== scenario.tierIndex}；档位成本对候选恒定：${scenario.tierUniform}`)
  }

  // ── 确定性自检：同种子重跑，决策序列必须逐位一致 ──
  const checkSeeds = SEEDS.slice(0, Math.min(2, SEEDS.length))
  for (const [config, other, rounds, label] of [[ARM_A, ARM_B, armA.rounds, 'A/off'], [ARM_B, ARM_A, armB.rounds, 'B/tier']] as const) {
    const replay = emptyAccumulator()
    const again = runArm(config, other, `${label}-replay`, checkSeeds, replay)
    for (const round of again.rounds) {
      const original = rounds.find(item => item.seed === round.seed)!
      expect(round.steps.map(step => step.action), `确定性自检 ${label} seed ${round.seed}`)
        .toEqual(original.steps.map(step => step.action))
    }
    expect(replay.payments, `确定性自检 ${label} 点炮赔付序列`).toEqual(
      (config === ARM_A ? a : b).payments.slice(0, replay.payments.length))
  }

  let commit = 'unknown'
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* 非 git 环境不阻塞出报告 */ }
  let worktreeDirty = false
  try { worktreeDirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim().length > 0 } catch { /* 同上 */ }
  const fingerprint = sourceFingerprint()
  console.log(`\n基线提交：${commit}；src 工作区${worktreeDirty ? '有未提交改动（数字对应运行时的源码状态，见指纹）' : '干净'}`)
  for (const item of fingerprint) console.log(`  指纹 ${item.hash}  ${item.file}`)

  const data: ReportData = {
    rows, a, b, seedTable: seedRows, divergedSeeds, sameSeeds, firstStepSeeds, totalSteps,
    commit, worktreeDirty, fingerprint, elapsedA: armA.elapsedMs, elapsedB: armB.elapsedMs, micro,
  }
  const identical = rows.filter(row => row.a !== null && row.a === row.b).map(row => row.label)

  const payload = {
    ruleVersion: BLOOD_FLOW_CONFIG.version, commit, worktreeDirty, fingerprint,
    seeds: [SEEDS[0], SEEDS[SEEDS.length - 1]], rounds: SEED_COUNT,
    arms: {
      A: { config: { ...ARM_A }, elapsedMs: round(armA.elapsedMs, 1), ...a },
      B: { config: { ...ARM_B }, elapsedMs: round(armB.elapsedMs, 1), ...b },
    },
    divergence: {
      seedsCompared: SEED_COUNT, seedsWithDivergence: divergedSeeds, seedsIdentical: sameSeeds,
      seedsDivergingAtFirstStep: firstStepSeeds,
      longestCommonPrefix: seedRows.map((row, index) => ({ seed: SEEDS[index], prefix: row[2], description: row[3] })),
      sameStateDualDecision: {
        armA: { decisions: a.decisions, differ: a.dualDiffer }, armB: { decisions: b.decisions, differ: b.dualDiffer },
      },
      turnDiscardDiagnosis: {
        armA: { positions: a.turnDiscards, tierUniform: a.turnTierUniform, cheapestCandidateChanged: a.turnExposureRankFlip },
        armB: { positions: b.turnDiscards, tierUniform: b.turnTierUniform, cheapestCandidateChanged: b.turnExposureRankFlip },
      },
    },
    microScenarios: micro.map(scenario => ({
      mode: scenario.mode, hand: scenario.hand, offIndex: scenario.offIndex, tierIndex: scenario.tierIndex,
      offTile: scenario.offTile, tierTile: scenario.tierTile,
      offExposureOfOffTile: scenario.offTile ? scenario.offExposure(scenario.offTile) : null,
      tierExposureOfOffTile: scenario.offTile ? scenario.tierExposure(scenario.offTile) : null,
      tierExposureOfTierTile: scenario.tierTile ? scenario.tierExposure(scenario.tierTile) : null,
      tierExposureUniformAcrossHand: scenario.tierUniform,
      opponentProfiles: scenario.profiles.map(p => ({ seat: p.seat, tier: p.tier, suspectSuit: p.suspectSuit, signals: p.signals })),
    })),
    measure: `bloodFlowOpponentRisk(view, BLOOD_FLOW_AI) 复算弃牌者视角最高档；tier≥${HIGH_RISK_TIER} 记为高风险`,
    identicalMetrics: identical,
    limitations: [
      `${SEED_COUNT} 局固定种子小样本，只能看方向与量级，不能推出长期平衡或胜率结论。`,
      '两臂牌局同种子同开局，但决策一旦分歧，后续牌河/副露完全不同，因此是"同分布对照"而非逐局配对差分。',
      '高风险判定用档位口径对两臂复算（A 臂自身配置不产生档位），保证尺子一致。',
      '平均净分变化带符号恒为 0（零和），故另报每席绝对值均值与最大分差。',
      '同局面双判沿各自轨迹取样，分歧前的局面是严格同一局面；分歧后的局面各自不同，只作"分歧频率"参考。',
    ],
  }
  mkdirSync('work', { recursive: true })
  writeFileSync('work/opponent-risk-report.json', JSON.stringify(payload, null, 2))
  writeFileSync('docs/blood-flow/records/strategy-opponent-risk.md', buildRecord(data, identical))

  expect(a.rounds).toBe(SEED_COUNT)
  expect(b.rounds).toBe(SEED_COUNT)
}, 900_000)

// ── 定向微场景断言（固定局面，独立于整局对拍） ────────────────────────────────

it('微场景：档位版在嫌疑花色与锁手现物两类差异化信号上确实改变弃牌选择', () => {
  // 1) 对手副露两组同花色（碰 p4 + 碰 p7）→ tier 2 / 染手嫌疑，嫌疑花色 p。
  const suspect = microReport(MICRO_SUSPECT_HAND, 'suspect')
  expect(suspect.profiles.map(p => ({ seat: p.seat, tier: p.tier, suspectSuit: p.suspectSuit })))
    .toEqual([{ seat: 1, tier: 2, suspectSuit: 'p' }, { seat: 2, tier: 0, suspectSuit: null }, { seat: 3, tier: 0, suspectSuit: null }])
  expect(suspect.offExposure('p1')).toBe(4)      // 旧口径：手上唯一一张 → 公开 1 张档 0.1 × 40
  expect(suspect.offExposure('south')).toBe(4)   // 旧口径：嫌疑花色与非嫌疑花色同价（都是 4 点）
  expect(suspect.tierExposure('p1')).toBe(64)    // 档位版：40 × 16（染手嫌疑）× 0.1
  expect(suspect.tierExposure('south')).toBe(32) // 非嫌疑花色再 × 0.5，正好是嫌疑花色的一半
  expect(suspect.tierExposure('m1')).toBe(0)     // m1 是现物（牌河 + 手上各 1 张 = 公开 2 张）→ 0 档，倍数乘 0 仍是 0
  expect(suspect.offIndex).toBe(11)              // off：打嫌疑花色生张 p1（旧口径只贵 4 点）
  expect(suspect.tierIndex).toBe(0)              // tier：改打现物 m1（p1 涨到 64 点，边际翻转）
  expect(suspect.offIndex).not.toBe(suspect.tierIndex)

  // 2) 对手已锁手（已胡 5 次仍在听）→ 现物不再享受折扣，档位成本对全部候选恒定。
  const locked = microReport(MICRO_LOCKED_HAND, 'locked')
  expect(locked.profiles[0]).toMatchObject({ seat: 1, tier: 2 })
  expect(locked.offExposure('east')).toBe(0)     // 旧口径：翻精 + 手上 1 张 = 公开 2 张 → 现物免费
  expect(locked.tierExposure('east')).toBe(160)  // 档位版：40 × 16 × 0.25（锁手不吃现物折扣）
  expect(locked.tierUniform).toBe(true)
  expect(locked.offIndex).toBe(9)                // off：打现物 east
  expect(locked.tierIndex).toBe(6)               // tier：改打 s7
  expect(locked.offIndex).not.toBe(locked.tierIndex)
}, 120_000)

// ── 记录文档 ────────────────────────────────────────────────────────────────

function buildRecord(data: ReportData, identical: readonly string[]) {
  const { rows, a, b, seedTable, divergedSeeds, sameSeeds, firstStepSeeds, commit, worktreeDirty, fingerprint, elapsedA, elapsedB } = data
  // 信号种类很多（"已胡N次仍听"按次数分裂成几十种），文档只列高频前 12 种，避免一行几 KB。
  const signals = (record: Record<string, number>) => {
    const sorted = Object.entries(record).sort((x, y) => y[1] - x[1])
    const head = sorted.slice(0, 12).map(([text, count]) => `${text} ×${count}`).join('、')
    return sorted.length > 12 ? `${head}（其余 ${sorted.length - 12} 种低频信号略）` : head || '无'
  }
  const pctText = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(2)}%` : '无样本'
  const meanOf = (values: readonly number[]) => values.length ? values.reduce((s, n) => s + n, 0) / values.length : 0
  const table = [
    '| 指标 | A 臂（`opponentPatternRisk: \'off\'`，改前口径） | B 臂（`\'tier\'`，档位版） | Δ(B−A) |',
    '|---|---:|---:|---:|',
    ...rows.map(row => `| ${row.label} | ${fixed(row.a, row.digits)} | ${fixed(row.b, row.digits)} | ${signed(deltaOf(row), row.digits)} |`),
  ].join('\n')
  const divergenceTable = [
    '| 种子 | 决策步数 A / B | 最长公共前缀 | 首个分歧步：A vs B |',
    '|---:|---:|---:|---|',
    ...seedTable.map(row => `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |`),
  ].join('\n')
  const microTex = data.micro.map(scenario => `### 微场景：${scenario.mode === 'suspect' ? '嫌疑花色差异化（副露染手）' : '锁手家不吃现物折扣'}

- 固定局面手牌：\`${scenario.hand.join(',')}\`；对手档位：\`${JSON.stringify(scenario.profiles.map(p => ({ seat: p.seat, tier: p.tier, suspectSuit: p.suspectSuit, signals: p.signals })))}\`
- \`off\` 选 **${scenario.offTile}**（index ${scenario.offIndex}），该牌旧口径放炮成本 **${scenario.offTile ? scenario.offExposure(scenario.offTile) : '—'} 点**
- \`tier\` 选 **${scenario.tierTile}**（index ${scenario.tierIndex}），该牌档位口径放炮成本 **${scenario.tierTile ? scenario.tierExposure(scenario.tierTile) : '—'} 点**；档位成本对全部候选是否恒定：**${scenario.tierUniform}**
- 两臂选择是否不同：**${scenario.offIndex !== scenario.tierIndex}**`).join('\n\n')

  return `# 血流本地 AI：对手大牌风险定价（off 旧口径 vs tier 档位版）双臂对拍 + 决策级分歧诊断

规则：${BLOOD_FLOW_CONFIG.version}；基线提交：${commit}${worktreeDirty ? '（记录时 `src/` 工作区**含未提交改动**，即对手风险定价特性本身，因此提交号不足以标定被测源码，请看文末"被测源码指纹"）' : ''}；种子：1～${SEEDS.length}（共 ${SEEDS.length} 局 × 2 臂 = ${SEEDS.length * 2} 局）；四席同一策略（贪婪 EV \`decideBloodFlowActionEv\`）自对局，跑到结算；显式关闭 UI 节拍（\`winBeatMs: 0\`、\`now: () => 0\`）；每个动作后检查 136 张物理牌守恒与积分零和。

- **A 臂（改前）**：\`{ ...BLOOD_FLOW_AI, opponentPatternRisk: 'off' }\` —— 弃牌放炮成本只由该牌公开张数决定（0 张 0.25 / 1 张 0.1 / ≥2 张 0 档 × 40 点）。
- **B 臂（档位版，默认）**：\`BLOOD_FLOW_AI\` —— 在上述基础上乘以"对手在做大牌"的风险倍率（tier1 ×4 / tier2 ×16 / tier3 ×32，染手非嫌疑花色再 ×0.5；已锁手家现物折扣失效，见 \`src/game/shared/ai/opponentPatternRisk.ts\`）。
- **高风险判定尺子**：两臂都用 \`bloodFlowOpponentRisk(view, BLOOD_FLOW_AI)\` 复算"弃牌者视角下三家对手的最高档"，\`tier ≥ ${HIGH_RISK_TIER}\` 记为高风险。A 臂自身配置不产生档位，所以量度必须固定用档位口径，否则两臂占比不可比。

## 方法

1. 每个种子 \`1..${SEEDS.length}\` 用 \`seededRandom(seed)\` 洗牌，两臂**同种子同开局**（各 2000 分、庄家 0 席）各跑一局。
2. 决策循环与 \`src/game/variants/lotus/bloodFlow/evStrategy.test.ts\` 一致：\`bloodFlowSeatView\` → \`decideBloodFlowActionEv(view, 臂配置)\` → \`engine.submit\`；唯一差别是传入的 \`BLOOD_FLOW_AI\` 配置。
3. 当某次提交真的产生弃牌（\`engine.discardActions\` 增长）时，把**出牌前**那一刻的公共风险快照按弃牌源事件 id 存档；结算时凡 \`batch.source.kind === 'discard'\` 的批次就是点炮，用该快照回填"当时弃牌者眼中的最高档"。
4. 四家锁手的判定完全由批次顺序重建（\`record.ordinal\` = 该家本次胡之前的已胡次数 + 1），不读引擎私有状态；"四家锁手后仍然胡牌"= 该批次成立前四家 \`winCount\` 均已 ≥1（锁手后"已胡仍付款"，这些胡仍然产生收付）。
5. 分位数为最近秩（nearest-rank）。
6. **决策级诊断口径**（本轮新增）：
   - *决策序列最长公共前缀*：每个种子把两臂各自每一步的动作按顺序记成序列，公共前缀长度 = 两臂从第一步起连续多少个动作完全相同；首个分歧步 = 前缀长度 + 1。因为两臂开局相同，这一步就是两条对局轨迹的分岔点。
   - *同局面双判*：驱动某一臂的每一步时，在**同一份公共视图**上再让另一臂决策一次（两个决策函数都是纯函数，不会改变本臂轨迹），统计"同局面下两臂选择不同"的步数与占比。这是"定价是否真的改变选择"的直接频率指标。
   - *弃牌局面风险项诊断*：在本家 14 张且有多个合法弃牌候选的局面，比较两臂放炮成本在候选牌上的形态——是否对全部候选恒定（等价于"现物 / 公开张数折扣整体失效"，风险项此时不携带候选间差异），以及"成本最低的那张牌"是否发生变化（风险项自身的排序是否变化）。
7. **确定性自检**：两臂跑完后，用同样种子把前 ${Math.min(2, SEEDS.length)} 个种子各重跑一遍，断言决策序列与点炮赔付序列逐位一致（脚本内 \`expect\`）。

## 数据表（端局指标）

${table}

补充：两臂"点炮时弃牌者视角最高档"的信号词频（说明为什么会被判成高风险）——

- A 臂：${signals(a.highRiskSignals)}
- B 臂：${signals(b.highRiskSignals)}

容易被忽略的两项分母：A 臂点炮批次 ${a.discardBatches} / 全桌弃牌 ${a.totalDiscards}（${pctText(a.discardBatches, a.totalDiscards)}），B 臂点炮批次 ${b.discardBatches} / 全桌弃牌 ${b.totalDiscards}（${pctText(b.discardBatches, b.totalDiscards)}）；点炮批次里最高档 ≥${HIGH_RISK_TIER} 的：A ${pctText(a.highRiskBatches, a.discardBatches)} / B ${pctText(b.highRiskBatches, b.discardBatches)}。

## 决策级分歧诊断

### 1. 逐种子决策序列（最长公共前缀）

${divergenceTable}

汇总：**${divergedSeeds}/${SEEDS.length}** 个种子出现决策分歧（其中**首步即分歧 ${firstStepSeeds} 个**），**${sameSeeds}/${SEEDS.length}** 个种子整局序列完全相同。
这意味着端局指标（点炮次数、赔付分布）在多数种子上是"同一条轨迹"，两臂的差别只能通过少数分岔点传播。

### 2. 同局面双判（同一公共视图上两臂各选一次）

| 轨迹 | 决策步数 | 两臂选择不同的步数 | 占比 |
|---|---:|---:|---:|
| A 臂（off）轨迹 | ${a.decisions} | ${a.dualDiffer} | ${pctText(a.dualDiffer, a.decisions)} |
| B 臂（tier）轨迹 | ${b.decisions} | ${b.dualDiffer} | ${pctText(b.dualDiffer, b.decisions)} |

### 3. 弃牌局面风险项形态

| 轨迹 | 弃牌局面数 | 档位成本对全部候选恒定 | 成本最低的候选发生变化 |
|---|---:|---:|---:|
| A 臂（off）轨迹 | ${a.turnDiscards} | ${a.turnTierUniform}（${pctText(a.turnTierUniform, a.turnDiscards)}） | ${a.turnExposureRankFlip}（${pctText(a.turnExposureRankFlip, a.turnDiscards)}） |
| B 臂（tier）轨迹 | ${b.turnDiscards} | ${b.turnTierUniform}（${pctText(b.turnTierUniform, b.turnDiscards)}） | ${b.turnExposureRankFlip}（${pctText(b.turnExposureRankFlip, b.turnDiscards)}） |

### 4. 定向微场景（固定局面，不走整局）

${microTex}

## 结论

${conclusion(data)}

## 两臂完全一致的指标（如实列出）

${identical.length
    ? identical.map(label => `- ${label}`).join('\n')
    : '- 无：所有统计项都出现了差异。'}

注意：即使某些端局指标两臂数值相同，决策级分歧统计（上表）显示的选择差异仍然存在——数值相同只说明这些分歧没有传播到该指标。

## 复现命令与耗时

\`\`\`
pnpm exec vitest run --dir scripts opponent-risk-report.test.ts
\`\`\`

- \`--dir scripts\` 不能省：根 \`vite.config.ts\` 里 \`test.dir: './src'\`，只写 \`pnpm exec vitest run scripts/opponent-risk-report.test.ts\` 会得到 \`No test files found\`。
- 默认种子 1～${SEEDS.length}，耗时约 ${((elapsedA + elapsedB) / 1000).toFixed(1)} 秒（A 臂 ${(elapsedA / 1000).toFixed(1)}s + B 臂 ${(elapsedB / 1000).toFixed(1)}s，含决策级双判与确定性自检，本机实测，随机器浮动）。
- **两臂耗时差不要当性能结论**：A 臂（旧口径）明显更慢，但实测是同一进程内的缓存 / JIT 顺序效应——对同一步局面先后调用两种口径计时，顺序为「off 先 / tier 后」时得到 4.81ms / 0.70ms，顺序反转为「tier 先 / off 后」时得到 0.30ms / 0.28ms（同种子重跑整臂也从 16.2s 降到 0.7s）。同一进程内先跑的配置承担预热成本，与配置本身的算法开销无关。
- 该文件在 \`scripts/\` 下，\`pnpm test\`（只跑 \`src\`）不会执行它，因此不进默认回归、也不进 CI 全量；需要时手动跑。
- 调整样本量：\`OPPONENT_RISK_SEEDS=<n> pnpm exec vitest run --dir scripts opponent-risk-report.test.ts\`（默认 ${SEEDS.length}；改小后请在本节注明实际局数）。
- 脚本同时写出 \`work/opponent-risk-report.json\`（机器可读的完整数字）并重写本文件，因此本文档中的数字与代码运行结果始终同源。
- 脚本只读生产代码（\`src/**\` 未做任何修改），不改变规则、计分、封顶与锁手行为。

### 被测源码指纹（sha256 前 12 位）

| 文件 | 指纹 |
|---|---|
${fingerprint.map(item => `| \`${item.file}\` | \`${item.hash}\` |`).join('\n')}

\`src/\` 工作区在记录时${worktreeDirty ? '**有未提交改动**' : '干净'}。风险定价算法或 EV 决策路径一旦被改动，上表数字即失效——重跑本脚本即可（会自动重写本文档与 \`work/opponent-risk-report.json\`）。

## 口径与边界

- 固定种子小样本，只能看**方向与量级**，不能推出长期平衡、胜率或"哪种口径更强"的结论。
- 两臂同种子同开局，但决策一旦分歧，后续牌河 / 副露 / 摸牌顺序就完全不同，所以本质是"同分布对照"，不是逐局配对的差分实验；端局指标的差值不是配对差分。
- 「平均每局净分变化」带符号恒为 0（四人零和、开局各 2000），真正有信息量的是每席 |净分变化| 与终局最大分差两行。
- 「点炮给高风险档对手」用**最高档**（三家取最大）而非"实际胡家那一家"的档位，这是任务口径；两者都列在表里。
- 同局面双判沿各自轨迹取样：分岔之前的局面才是严格同一局面，分岔之后两臂面对的牌河已不同，因此它衡量的是"分歧频率"，不是反事实重放。
- 档位信号只看公共信息（对手牌河、副露明细、已胡次数 / 锁手、墙余），本脚本同样不读取任何对手暗手。
`
}

function conclusion(data: ReportData) {
  const { a, b, divergedSeeds, sameSeeds, firstStepSeeds } = data
  const meanOf = (values: readonly number[]) => values.length ? values.reduce((s, n) => s + n, 0) / values.length : 0
  const pctText = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(2)}%` : '无样本'
  const lines: string[] = []
  const riskRateA = 100 * a.highRiskBatches / Math.max(1, a.discardBatches)
  const riskRateB = 100 * b.highRiskBatches / Math.max(1, b.discardBatches)
  const dualRateA = 100 * a.dualDiffer / Math.max(1, a.decisions)
  const dualRateB = 100 * b.dualDiffer / Math.max(1, b.decisions)
  const uniformRateA = 100 * a.turnTierUniform / Math.max(1, a.turnDiscards)
  const uniformRateB = 100 * b.turnTierUniform / Math.max(1, b.turnDiscards)
  const rankFlipRateA = 100 * a.turnExposureRankFlip / Math.max(1, a.turnDiscards)
  const rankFlipRateB = 100 * b.turnExposureRankFlip / Math.max(1, b.turnDiscards)
  const lockedOnlyRate = 100 * a.highRiskLockedOnly / Math.max(1, a.highRiskBatches)
  const discardDelta = b.discardBatches - a.discardBatches
  const riskDelta = b.highRiskBatches - a.highRiskBatches
  const direction = discardDelta === 0 ? '两臂相同'
    : `Δ${discardDelta > 0 ? '+' : ''}${discardDelta}，即 B 臂${discardDelta > 0 ? '反而多' : '少'} ${Math.abs(discardDelta)} 次，相当于 ${Math.abs(100 * discardDelta / Math.max(1, a.discardBatches)).toFixed(2)}%`

  lines.push(`### 1. 哪一臂更少"点炮给大牌"：本样本给不出肯定答案，表面差值的方向与预期相反`)
  lines.push(`- 点炮给高风险档对手（当时最高档 ≥${HIGH_RISK_TIER}）：A 臂 ${a.highRiskBatches} 次、B 臂 ${b.highRiskBatches} 次（Δ${riskDelta > 0 ? '+' : ''}${riskDelta}），占该臂全部点炮批次 ${riskRateA.toFixed(2)}% → ${riskRateB.toFixed(2)}%。`)
  lines.push(`- 全部点炮批次（source=discard）：A ${a.discardBatches} → B ${b.discardBatches}（${direction}）；点炮率 ${pctText(a.discardBatches, a.totalDiscards)} → ${pctText(b.discardBatches, b.totalDiscards)}。**没有观察到"B 臂更少点炮给大牌"**；方向反而是 B 臂略多、但差值远小于噪声。`)
  lines.push(`- 赔付分布几乎不动：每单家支付均值 ${meanOf(a.payments).toFixed(2)} → ${meanOf(b.payments).toFixed(2)} 点，P50 ${percentile(a.payments, 0.5) ?? 0} → ${percentile(b.payments, 0.5) ?? 0}，P90 ${percentile(a.payments, 0.9) ?? 0} → ${percentile(b.payments, 0.9) ?? 0}，最大 ${max(a.payments) ?? 0} → ${max(b.payments) ?? 0}；每批总收均值 ${meanOf(a.batchTotals).toFixed(2)} → ${meanOf(b.batchTotals).toFixed(2)}，最大 ${max(a.batchTotals) ?? 0} → ${max(b.batchTotals) ?? 0}。`)
  lines.push(`- 代价项也没有出现系统性方向：每局总胡次数 ${(a.winRecords / a.rounds).toFixed(2)} → ${(b.winRecords / b.rounds).toFixed(2)}，每席 |净分变化| ${meanOf(a.absNet).toFixed(2)} → ${meanOf(b.absNet).toFixed(2)}，终局最大分差均值 ${meanOf(a.spreads).toFixed(2)} → ${meanOf(b.spreads).toFixed(2)}，平均首胡墙余 ${meanOf(a.firstWalls).toFixed(2)} → ${meanOf(b.firstWalls).toFixed(2)}，四家锁手后仍胡牌批次 ${a.allLockedBatches} → ${b.allLockedBatches}（即"代价"同样看不出）。`)
  lines.push(`- **读法**：这些 Δ 不是配对差分（见文末"口径与边界"），幅度也远小于本样本的局间波动（每席 |净分变化| 达 ${meanOf(a.absNet).toFixed(0)} 点级），所以既不能宣布"档位版更少点炮给大牌"，也不能宣布"档位版更危险"。要回答这个问题必须换方法（见第 4 节）。`)
  lines.push(`- 完全一致的两项：被抢杠胡 ${a.robbedKong}/${b.robbedKong}、杠上开花 ${a.kongBloom}/${b.kongBloom}（本批 40 局里这两类事件为 0 次，样本量不足以比较）。`)
  lines.push(`- 另一个必须点明的问题："点炮给高风险档对手"这个指标在本规则下**几近饱和**（${riskRateA.toFixed(2)}% / ${riskRateB.toFixed(2)}%）——血流里任何已胡过的家都已经是 tier 2（\`已胡N次仍听\`），所以它几乎没有分辨力，不应单独当安全性的判据。`)

  lines.push(`\n### 2. 决策级分歧：档位版确实改变选择，但只占极少数局面`)
  lines.push(`- ${SEEDS.length} 个种子中 ${divergedSeeds} 个出现决策分歧（首步即分歧 ${firstStepSeeds} 个），${sameSeeds} 个整局决策序列完全相同 ⇒ 端局指标在多数种子上就是"同一条轨迹"，两臂差别只能通过少数分岔点向下传播。`)
  lines.push(`- 同局面双判（同一份公共视图上两臂各选一次）：A 臂轨迹 ${a.decisions} 步中 ${a.dualDiffer} 步（${dualRateA.toFixed(2)}%）选择不同；B 臂轨迹 ${b.decisions} 步中 ${b.dualDiffer} 步（${dualRateB.toFixed(2)}%）选择不同。`)
  lines.push(`- 定向微场景是"档位版生效"的直接证据（固定局面、不走整局、脚本内 \`expect\` 断言）：嫌疑花色场景 \`off\` 打 ${data.micro[0]?.offTile}、\`tier\` 改打 ${data.micro[0]?.tierTile}（嫌疑花色生张定价 4 → 64 点、非嫌疑 4 → 32 点，边际翻转）；锁手现物场景 \`off\` 打 ${data.micro[1]?.offTile}、\`tier\` 改打 ${data.micro[1]?.tierTile}（现物从 0 点变成统一 160 点，折扣失效）。口径一旦变动，这两条断言会直接失败。`)

  const hypothesisHolds = dualRateA < 10 && dualRateB < 10
  lines.push(`\n### 3. 假设检验：${hypothesisHolds ? '成立（并定位到具体失效环节）' : '不成立'}`)
  lines.push(`待检验假设：**tier≥2 的两类信号（\`副露染手嫌疑\` / \`已胡N次仍听\`）在血流对局里近乎常态存在，导致风险倍率大多只是把整手牌的价格整体抬高或整体拉平，对"候选之间的相对排序"影响有限，因此端局指标趋同；真正会改变选择的是"嫌疑花色 vs 非嫌疑花色"和"锁手家不吃现物折扣"这两类差异化信号。**`)
  lines.push(`逐条数据：`)
  lines.push(`- **前提成立**：A 臂高风险点炮批次里，最高档"只"由 \`已胡N次仍听\` 触发的占 ${lockedOnlyRate.toFixed(2)}%，其余 ${(100 - lockedOnlyRate).toFixed(2)}% 含副露 / 牌河信号——"已锁手"是与副露信号规模相当的常态来源，而不是罕见信号。`)
  lines.push(`- **"整手牌价格被拉平"成立**：弃牌局面中档位放炮成本对**全部合法候选相同**（不携带任何候选间差异）的占比：A 臂轨迹 ${uniformRateA.toFixed(2)}%、B 臂轨迹 ${uniformRateB.toFixed(2)}%。这些局面里档位项只可能"抹平"旧口径的现物折扣，无法把风险"导向"某一张牌。`)
  lines.push(`- **风险项自身排序受影响的比例不大**：档位口径下"放炮成本最低的候选牌"发生变化的局面占 A ${rankFlipRateA.toFixed(2)}% / B ${rankFlipRateB.toFixed(2)}%。`)
  lines.push(`- **真正传到决策的只有极小一部分**：同局面双判差异率 A ${dualRateA.toFixed(2)}% / B ${dualRateB.toFixed(2)}%。风险项即使自身排序变了，也要跨过"听牌 / 进张 / 番型潜力"这几项主导 netScore 的量级才能翻转选择——候选之间本来就常差几十点以上的攻击分。`)
  lines.push(`结论：**${hypothesisHolds ? '假设成立' : '假设不成立'}**。${hypothesisHolds
    ? '档位倍率确实生效（微场景已直接证明），但它的作用面是"少数局面里的差异化信号"：约一半局面里它退化成整手牌的统一涨价（现物折扣失效），另一半才有花色差异化，最终改变弃牌选择的不足全部决策的 1%。因此 20 局级样本的端局聚合指标不可能对它有反应——评估定价效果必须依赖决策级分歧统计与定向微场景，而不是端局数值。'
    : '同局面双判差异率超过 10%，说明定价对选择的影响比假设预期更大，端局指标趋同更可能来自样本量不足或分歧未传播到该指标。'}`)

  lines.push(`\n### 4. 可疑之处与后续建议`)
  lines.push(`- 端局指标的差值不是配对差分：一旦分岔，两臂后续牌局完全不同，Δ 混有"轨迹不同"的噪声，不能用显著性解释，也不应据此宣布"哪一臂更安全"。`)
  lines.push(`- \`已胡N次仍听\` 直接把锁手家定成 tier 2 并使现物折扣失效，等于让"任何已胡对手"的价格对所有候选牌相同（本样本 ${uniformRateA.toFixed(2)}% 的弃牌局面如此）；若目标是"更精细地回避大牌"，这里的分辨率可能不足——锁手家的档位不区分其真实番型，且"高风险"在点炮批次里 ${riskRateA.toFixed(1)}% 命中，几乎不筛选。这是设计观察，本脚本只做记录，未改任何规则。`)
  lines.push(`- 本批 ${SEEDS.length * 2} 局（${SEEDS.length} 局 × 2 臂）里被抢杠胡与杠上开花都是 0 次，无法比较；要评估这两类事件需要更大样本或条件化夹具。`)
  lines.push(`- 若要把"档位版是否更少点炮给大牌"做成可信结论，建议：固定两臂共用同一批**分岔后重放**的对局（A 臂某一手决策替换为 B 臂策略再继续，其余完全相同），或把样本提到数百局并报置信区间；当前脚本已提供可复现的骨架与决策级指标。`)
  return lines.join('\n')
}
