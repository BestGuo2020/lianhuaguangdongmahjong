import { BLOOD_FLOW_PATTERNS } from './patternDefinitions'
import type { BloodFlowRuleConfig } from './types'
import type { DefensePolicyConfig } from './defensePolicy'
import { BLOOD_FLOW_BIG_HAND_ROUTE, BLOOD_FLOW_BIG_HAND_ROUTE_WIDE, type BigHandRouteConfig } from './bigHandRoute'
import type { SevenPairsModel } from './patternPotentials'


/**
 * 杠加成（2026-09-12 新增；2026-09-15 用户定案调整风杠）：每个**明杠 +1**、每个**暗杠 +2**、
 * 每个**风杠 +1**（与明杠同档）。此前杠没有任何番型加成，"胡后可开杠"也就没有收益——
 * 这是三杠/四杠这类牌型做不出来的根因之一。
 *
 * 风杠为什么降到 +1（实测数据）：150 局 / 5,021 次胡牌里，**风杠出现率 10.7%（每局）**，
 * 是暗杠（5.3%）的 2 倍、只比明杠（15.3%）稀有 30%；而它与暗杠同为 +2 番。风杠只要攥住
 * 东南西北各一张（四张本来最该打掉的风牌）即可，难度明显低于凑齐同种四张，因此收窄到明杠档。
 * 注意：**风杠的即时杠分（kongPayments.wind = 2 → 80 点）不动**——它和暗杠一样不可被抢杠。
 */
export const BLOOD_FLOW_KONG_BONUS: Readonly<{ exposed: number; concealed: number; wind: number }> =
  Object.freeze({ exposed: 1, concealed: 2, wind: 1 })

/**
 * 开杠价值配置（2026-09-13，用户定案第 3 步）。
 *
 * 血流 AI 的开杠候选不再"能杠必杠"，而是按 `杠收益 − 防守风险 − 自手牌型损失` 计分（见 kongValue.ts），
 * 净值为正才压过"不杠"。`mode: 'off'` 用于 A/B 对照（回退到旧的"能杠必杠 + 已听牌才放弃"口径）。
 */
export interface KongValueConfig {
  readonly mode: 'off' | 'ev'
  /** 倍率加成的折算权重（× 底分）：1 = 按单家一份计（杠加成只在胡牌时兑现，这里不按胡牌概率再折）。 */
  readonly bonusWeight: number
  /** 补杠抢杠风险（点，未见张时）。 */
  readonly robRisk: number
  /** 向听每恶化一档的折算损失（点）＝ 1 番底分。 */
  readonly shantenStepLoss: number
  /** 门清（2026-09-15 起为独立番种）在杠价值模型里的折价：按接近度折算，不按全额计。 */
  readonly concealedHandFallback: number
}

export const BLOOD_FLOW_KONG_VALUE: KongValueConfig = Object.freeze({
  mode: 'ev', bonusWeight: 1, robRisk: 60, shantenStepLoss: 10, concealedHandFallback: 0.5,
})

/**
 * 动作优先级（2026-09-14 用户定案：**线上就是 杠 > 碰 > 吃 > 胡**）。
 *
 * `kong-priority`（默认）：
 * ① **胡牌之后仍可开杠**——锁手座位在自摸窗口可暗杠/风杠/补杠，别人打出的牌也可大明杠（仍不可碰/吃）；
 * ② **动作优先级 杠 > 碰 > 吃 > 胡**（胡最低）——同一张牌的竞争里杠/碰/吃先结算、胡被压到最后；
 *    座位自身同时有杠/碰/吃与胡时，不再把"胡"当默认首选。
 *
 * 2026-09-14 修复：此前这个开关只接受 `VITE_BLOOD_FLOW_EXPERIMENT=kong-priority` 才打开，
 * 而仓库 `.env`（以及 vibehub 工作区）都没有这个变量 → **线上实际一直是 standard（胡优先）**，
 * 用户实测"吃牌被胡拦截"正是这个原因。现在默认即 kong-priority，
 * 需要旧口径做 A/B 时用 `VITE_BLOOD_FLOW_EXPERIMENT=standard` 显式切回。
 */
export const BLOOD_FLOW_ACTION_PRIORITY: 'standard' | 'kong-priority' =
  (import.meta as { env?: Record<string, string> }).env?.VITE_BLOOD_FLOW_EXPERIMENT === 'standard'
    ? 'standard' : 'kong-priority'

export const BLOOD_FLOW_CONFIG: BloodFlowRuleConfig = Object.freeze({
  id: 'lotus-blood-flow',
  version: 'lotus-blood-flow-v1',
  label: '莲花麻将·血流',
  basePoints: 10,
  initialScore: 2000,
  /** 单家封顶。2026-09-12 从 64 提到 128：番值表拉开后顶端（十三幺/大三元 32 番）会被 64 吃掉。 */
  maxMultiplierPerPayer: 128,
  hardWinMultiplier: 2,
  patterns: BLOOD_FLOW_PATTERNS,
  eventMultipliers: Object.freeze({ discard: 1, 'self-draw': 2, 'robbed-kong': 2, 'kong-bloom': 4 }),
  openingMinimumMultiplier: 8,
  kongPayments: Object.freeze({ discard: 1, added: 1, concealed: 2, wind: 2 }),
  kongBonus: BLOOD_FLOW_KONG_BONUS,
  rounds: Object.freeze({ east: 4, hanchan: 8 }),
  lockAfterFirstWin: true,
  multipleWinners: true,
  allowNegativeScores: true,
  alreadyWonPlayersPay: true,
  dealerMultiplier: 1,
  dealerRotation: 'every-round',
  crossWindowPassRestriction: false,
  extraPayments: Object.freeze([]) as readonly [],
})

/** 本地 / WS / P2P 三面均放行：P2P 于 2026-09-10 打开，用于线上双真人 + 机器人（普通 / 大模型）整场验收。 */
export const BLOOD_FLOW_AVAILABILITY = Object.freeze({ local: true, ws: true, p2p: true })

export const BLOOD_FLOW_TIMING = Object.freeze({
  // remoteDecisionMs 与后端 BLOOD_FLOW_TIMING.remoteDecisionMs 对齐（12s = 经典房间回合超时），
  // WS 权威与 P2P 权威共用同一决策窗口，读秒长度不再两套。
  winBeatMs: 450, normalDecisionMs: 15_000, remoteDecisionMs: 12_000, recoveryGraceMs: 12_000,
  /**
   * 权威链上的机器人/大模型决策上限（2026-09-14 追加，P2P 中盘卡死的自愈）。
   *
   * 背景：`BloodFlowAuthority.tick()` 与 `receive()` 共用同一条串行 promise 链，
   * 机器人决策是链里唯一"等外部"的 await（大模型请求可能慢/挂）。一旦它不返回，
   * 后续的窗口过期、快照广播、命令校验全部排不上队——表现就是线上验收里那种
   * "双方都停在等待、只剩托管按钮、5 分钟不动"。超时后回落到引擎自己的机器人策略
   * （`backend.bot(seat, windowId)`），保证链每轮都有界推进。
   *
   * 取 remoteDecisionMs + 3s：正常路径下大模型决策由 runtime 按窗口预算自己 abort，
   * 这个上限只兜住"连 abort 都没回来"的挂死，不影响正常的大模型出牌质量。
   */
  authorityBotDecisionTimeoutMs: 15_000,
  /**
   * 权威链上"引擎/传输调用"的上限（2026-09-14 追加，第二轮自愈）。
   *
   * 线上 trace 实测（房间 G626L9）：卡死时权威的最后一条 tick 停在 window 79，引擎已走到 window 80；
   * 卡住前最后发生的是**一次 45 KB 快照被切成 12 个分片**的广播，而 `botDecisionTimeouts=0`
   * 说明卡的不是决策那一步——是 `backend.view / expire / command / bot` 与 `publish()→sendSnapshot()`
   * 这条路上的某个 await 永不返回，整条串行链（窗口过期、机器人推进、发快照）随之停摆。
   * 这里给每个这类调用一个硬上限：超时就记数、打 trace 并**跳过本次操作**（下一次 tick 重试），
   * 读视图超时时机器人分支直接回落 `backend.bot`，保证链每轮都有界推进。
   */
  authorityWorkerTimeoutMs: 4_000,
  compactWinMs: 2300, largeWinMs: 2600, topWinMs: 2900, multiWinIntroMs: 1500,
  fullEffectCooldownMs: 8000, visualBacklogMs: 2000,
})

/**
 * 本地 AI 贪婪 EV 策略参数（见 docs/blood-flow/design/ai-strategy.md）。
 * 只影响决策，不改变计分、封顶、锁手或胡后自动续行规则。
 */
export interface BloodFlowAiConfig {
  readonly strategy: 'ev' | 'legacy'
  /** legacy 策略的首次胡单家支付门槛（旧行为保留）。 */
  readonly minimumFirstPayment: number
  /** 自摸单次总收入（×2 × 3 家）相对点炮（×1 × 1 家）的连锁期望权重。 */
  readonly selfDrawWeight: number
  /** 首胡门槛（单家支付，取合法 10 的倍数档）：早局 / 中局 / 残局。 */
  readonly firstWinFloorEarly: number
  readonly firstWinFloorMid: number
  readonly firstWinFloorLate: number
  /** 墙余分界：≤ late 为残局，> early 为早局。 */
  readonly lateGameWallCount: number
  readonly earlyGameWallCount: number
  /** 拒胡所需的最小改造潜力（Σ weight×progress²；默认 2 ≈ 一个 4 倍级方向 0.7 接近度）。 */
  readonly potentialFloor: number
  /** 改张 EV 需 ≥ 该比例 × 立即胡 EV 才执行 / 提示。 */
  readonly reformGainRatio: number
  /** 锁手后连锁期望的展望巡数。 */
  readonly chainHorizon: number
  /** 连锁收入预测；source-v2 使用规范计分与已校准的自摸／点炮机会。 */
  readonly chainForecast?: 'legacy' | 'self-draw-v1' | 'source-v2'
  readonly opportunityCalibration?: { readonly drawScale: number; readonly discardScale: number; readonly selfYield: number; readonly ronYield: number }
  /** Optional trained category composition; absent preserves source-v2. */
  readonly conditionalRon?: import('./conditionalRon').ConditionalRonModel
  /** 弃牌放炮成本档位（公开 0 张 / 1 张 / ≥2 张）。 */
  readonly safetyCostNone: number
  readonly safetyCostOne: number
  readonly safetyCostSafe: number
  /** 对手牌型（大牌）风险定价：'off' = 只看公开张数的旧口径，'tier' = 档位版（见 shared/ai/opponentPatternRisk.ts）。 */
  readonly opponentPatternRisk: 'off' | 'tier'
  /** 档位倍率：1 = 平胡量级；4/16/32 ≈ 混一色 / 清一色 / 十六倍级硬胡点炮的单家赔付量级。 */
  readonly riskFactorTier1: number
  readonly riskFactorTier2: number
  readonly riskFactorTier3: number
  /** 染手（花色集中）嫌疑对手：非嫌疑花色牌的系数。 */
  readonly riskOffSuitFactor: number
  /** 兜/弃政策阈值（v3）。 */
  readonly defense: DefensePolicyConfig
  /** 真·大牌路线（v4）：只影响 LLM 候选构造，不动引擎/普通 AI。 */
  readonly bigHandRoute: BigHandRouteConfig
  /** LLM route advice never removes otherwise offered actions. */
  readonly routeAdviceOnly?: boolean
  /** 首胡自摸时，墙余不足不得仅因落后而用大牌路线撤胡；缺省 false 兼容旧评估配置。 */
  readonly routeOpportunityGuard?: boolean
  /** 吃／碰候选的番型估值纳入新副露；缺省 false 保留旧评估配置。 */
  readonly claimMeldProjection?: boolean
  /** 吃碰由未听变听时，仍需综合分优于过；缺省 false 保持旧评估配置。 */
  readonly claimReadyNetGuard?: boolean
  /** LLM 候选注入同源 EV 特征并以其为默认推荐（模型可覆盖、要理由）；关闭则回退旧提示词。 */
  readonly llmEvFeatures: boolean
  /** 开杠价值（第 3 步）：杠候选按 收益 − 防守风险 − 自手牌型损失 计分。 */
  readonly kongValue: KongValueConfig
  /**
   * 七对潜力模型（2026-09-13 追加）：'off' = 旧口径（七对只按 4 番估、多余精牌直接丢掉；
   * 经典玩法与旧 A/B 臂逐位一致）；'ev' = 对齐引擎记账 + 豪华七对方向
   * （豪华七对 2026-09-18 由 12 → **6 番** 暂定，见 records/pattern-table-2026-09-18.md）。
   */
  readonly sevenPairsModel: SevenPairsModel
}

/** 兜/弃政策默认值（v3；规则见 defensePolicy.ts 顶部注释）。 */
export const BLOOD_FLOW_DEFENSE: Readonly<DefensePolicyConfig> = Object.freeze({
  /** 触发"兜"的最低对手威胁档（3 = 十六倍级 / 门清大牌）。 */
  foldThreatTier: 3,
  /** 我方上限认定：番型方向接近度 ≥ 该值才算"真有机会做成"。 */
  ceilingProgress: 0.35,
  /** 我方上限认定：该方向的番型倍率下限（与对手对比用）。 */
  ceilingWeightFloor: 4,
  /** 兜牌硬约束：候选层撤碰吃杠 + 只留安全档（engine 与 LLM 共用同一份候选）。 */
  mode: 'hard',
  /** 兜牌时允许的弃牌安全档容差（0 = 只留放炮成本最小档）。 */
  foldDiscardTolerance: 0,
})

// 256 个新源种子的四座轮换东风场验收通过；构建时设为 off 可独立回退。
const sourceForecastEnabled = (import.meta as { env?: Record<string, string> }).env?.VITE_BLOOD_FLOW_SOURCE_FORECAST !== 'off'
const sourceOpportunityCalibration = Object.freeze({
  drawScale: 0.9975786924939467,
  discardScale: 0.8990627253064167,
  selfYield: 0.8478712071537614,
  ronYield: 0.9877357078236184,
})

export const BLOOD_FLOW_AI: BloodFlowAiConfig = Object.freeze({  strategy: 'ev',
  minimumFirstPayment: 0,
  selfDrawWeight: 6,
  firstWinFloorEarly: 40,
  firstWinFloorMid: 20,
  firstWinFloorLate: 10,
  lateGameWallCount: 15,
  earlyGameWallCount: 40,
  potentialFloor: 2,
  reformGainRatio: 1.2,
  chainHorizon: 8,
  chainForecast: sourceForecastEnabled ? 'source-v2' : 'legacy',
  ...(sourceForecastEnabled ? { opportunityCalibration: sourceOpportunityCalibration } : {}),
  safetyCostNone: 0.25,
  safetyCostOne: 0.1,
  safetyCostSafe: 0,
  opponentPatternRisk: 'tier',
  riskFactorTier1: 4,
  riskFactorTier2: 16,
  riskFactorTier3: 32,
  riskOffSuitFactor: 0.5,
  defense: BLOOD_FLOW_DEFENSE,
  /**
   * 大牌路线（v4 + 2026-09-14 推广）：默认对**普通 AI 座**启用五条线
   * （十三幺/九莲/清一色/混一色/碰碰胡）。要回到"只有十三幺/九莲、只作用于 LLM"，
   * 改成 `BLOOD_FLOW_BIG_HAND_ROUTE` 即可（一行回退）。
   */
  bigHandRoute: BLOOD_FLOW_BIG_HAND_ROUTE_WIDE,
  // 已通过四座轮换东风场验证；构建时设 VITE_BLOOD_FLOW_ROUTE_OPPORTUNITY=off 回退。
  routeOpportunityGuard: (import.meta as { env?: Record<string, string> }).env?.VITE_BLOOD_FLOW_ROUTE_OPPORTUNITY !== 'off',
  claimMeldProjection: (import.meta as { env?: Record<string, string> }).env?.VITE_BLOOD_FLOW_CLAIM_MELD_PROJECTION !== 'off',
  // 128 种子四座轮换验证通过；独立回退不关闭其他已接入的修复。
  claimReadyNetGuard: (import.meta as { env?: Record<string, string> }).env?.VITE_BLOOD_FLOW_CLAIM_READY_NET_GUARD !== 'off',
  llmEvFeatures: true,
  kongValue: BLOOD_FLOW_KONG_VALUE,
  /** 七对潜力模型：默认开启（对齐引擎记账 + 豪华七对方向）；改成 'off' 一键回退旧口径做 A/B。 */
  sevenPairsModel: 'ev',
})

/** LLM route advice preserves strategic choices. Forecast promotion is verified separately. */
export const BLOOD_FLOW_LLM_AI: BloodFlowAiConfig = Object.freeze({
  ...BLOOD_FLOW_AI,
  routeAdviceOnly: true,
  chainForecast: 'legacy',
  opportunityCalibration: undefined,
  // Forecast and additional claim policies remain independently gated; route advice is enabled above.
  routeOpportunityGuard: false,
  claimMeldProjection: false,
  claimReadyNetGuard: false,
  bigHandRoute: Object.freeze({ ...BLOOD_FLOW_BIG_HAND_ROUTE_WIDE, mode: 'llm' as const }),
})

/** Shared by the local continuation and the existing DOM/3D director. */
export function bloodFlowWinTiming(tier: number) {
  if (tier >= 2) {
    const base = tier === 3 ? BLOOD_FLOW_TIMING.topWinMs : BLOOD_FLOW_TIMING.largeWinMs
    const impact = tier === 3 ? 1110 : 1000
    const readable = tier === 3 ? 1390 : 1240
    // 收付至少停留 1 秒：score → exit ≥ 1000ms，总时长相应顺延。
    const score = base - 620
    return { duration: score + 1200, phaseMarks: { intro: 0, focus: 0, impact, readable, score, exit: score + 1000 } }
  }
  const score = 1815
  return { duration: score + 1200, phaseMarks: { intro: 0, focus: 0, impact: 870, readable: 1090, score, exit: score + 1000 } }
}
