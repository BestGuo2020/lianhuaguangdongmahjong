// 血流对局的 AI 分析记录：数据模型。
// 设计见 docs/blood-flow/design/replay-ai-analysis-recording.md（下称"方案"）。
//
// 方案的核心约定（写在这里是为了让实现不容易走偏）：
// - 只旁路采集**当时已有**的信息：不额外调用模型、不在出牌路径上跑反事实搜索、不为凑齐表格新增在线计算（§1）。
// - 区分三层：引擎合法动作 / 策略候选（含被限制的动作与原因） / 策略输出（推荐与实际选择）（§3.3）。
// - 区分「谁选择」与「引擎最终执行什么」：模型回答 ≠ 动作执行成功（§3.4、§10.2）。
// - 没有计算过的量标记为缺失，不填 0（§3.3）。
// - 不保存内部思考、逐 token 流水、全文提示词重复副本、API Key／Authorization／Cookie（§4、§8）。
// - 展示回放（src/game/replay/types.ts）仍然是公开字段的唯一来源；本文件只描述"展示回放恢复不出来"的部分（§9.3）。

/** 分析区格式版本：与展示回放的 REPLAY_SCHEMA_VERSION 独立演进（§9.5）。 */
export const ANALYSIS_FORMAT_VERSION = 1

/** 座位控制方式：接管或回退不能只看开局角色（§3.1）。 */
export type AnalysisSeatControl = 'human' | 'local-ai' | 'llm'

/** 动作来源：模型回答与"模型失败后的本地回退"必须分开（§3.4）。 */
export type AnalysisChoiceSource =
  | 'human'
  | 'local-strategy'
  | 'model'
  | 'model-fallback'
  | 'rule-auto'
  | 'countdown-fallback'
  | 'unknown'

/** 提交结果：选择不等于执行（§3.4）。 */
export type AnalysisExecutionStatus =
  /** 已提交，但尚未观察到执行回执（不能当成执行成功，§10.2）。 */
  | 'pending'
  | 'executed'
  | 'overridden'      // 已接受但被更高优先级动作压过
  | 'window-expired'
  | 'state-changed'
  | 'rejected-illegal'
  | 'cancelled'

/** 窗口类型：摸牌回合 / 弃牌响应 / 抢杠等（§3.2）。 */
export type AnalysisWindowKind = 'draw-turn' | 'claim' | 'rob-kong' | 'other'

/** 记录完整性：缺失必须留痕，不能静默截断后仍声称可复现（§9.5）。 */
export type AnalysisCompleteness = 'complete' | 'partial' | 'missing'

/** 落库的状态：在完整性之外多一个「已删除」墓碑，供列表显示（§9.2）。 */
export type AnalysisStoredStatus = AnalysisCompleteness | 'deleted'

/** 成本/缺失都留痕的三态值：没有计算过就是缺失，不填 0（§3.3）。 */
export type AnalysisMaybe<T> = { known: true; value: T } | { known: false }

export function known<T>(value: T): AnalysisMaybe<T> { return { known: true, value } }
export const UNKNOWN: AnalysisMaybe<never> = { known: false }

// ─────────────────────────────── §3.1 场次级版本与配置 ───────────────────────────────

export interface AnalysisPromptTemplate {
  /** 版本 id（去重存一次，决策只引用它 + 实际变量输入）。 */
  id: string
  /** 内容指纹：单存哈希不足以复现，但用于去重与漂移检测。 */
  fingerprint: string
  /** 模板正文（去重后只存一份）。 */
  text: string
}

export interface AnalysisModelConfig {
  seat: number
  provider: string
  /** 请求模型 ID；角色名不能代表实际模型。 */
  requestModel: string
  /** 返回的模型版本；未返回则明确未知。 */
  responseModel: AnalysisMaybe<string>
  /** 影响决策的采样／思考开关。 */
  sampling: Record<string, unknown>
}

/** 配置按"生效版本"存一次；局中变化则生成新记录，由后续决策引用（§3.1）。 */
export interface AnalysisConfigRecord {
  id: string
  formatVersion: number
  /** 从第几局（1 起）开始生效。 */
  effectiveFromRound: number
  engineBuild: string
  rulesVersion: string
  rulesFingerprint: string
  rules: Record<string, unknown>
  aiStrategy: string
  aiFingerprint: string
  aiConfig: Record<string, unknown>
  seatControl: AnalysisSeatControl[]
  models?: AnalysisModelConfig[]
  promptTemplates?: AnalysisPromptTemplate[]
}

// ─────────────────────────────── §3.2 决策关联与准确前态 ───────────────────────────────

/**
 * 决策前态：取自权威引擎实际交给该座位的视角（§3.2）。
 * 公开字段由展示回放提供唯一来源（§9.3），这里只补展示回放恢复不出来的部分：
 * 本家手牌与摸牌索引、合法动作、本家可胡计分，以及响应窗口缺失的座位差量。
 */
export interface AnalysisDecisionState {
  id: string
  /** 状态指纹：用于校验与去重（§3.2）。 */
  fingerprint: string
  /** 引用展示回放中的权威状态（fps 为 frame index / step index）。 */
  replay?: { roundIndex: number; stepIndex: number }
  /** 本家手牌（含摸牌索引语义；摸切/锁手依赖索引，不能只存牌种）。 */
  hand?: string[]
  drawnTileIndex?: number
  melds?: number
  /** 本家可胡计分（当时视角已有）。 */
  winScores?: AnalysisMaybe<Record<string, number>>
  /** 锁手状态与公开胡牌／杠记录中的、展示回放未覆盖的部分。 */
  locks?: Record<string, unknown>
  /** 响应窗口：响应座位在该窗口的手牌与摸牌索引（§9.3 的已知格式缺口）。 */
  responderCheckpoint?: { seat: number; hand: string[]; drawnTileIndex: number }
  /** 该状态里引擎给出的合法动作（规范化）。 */
  legalActions: AnalysisLegalAction[]
}

/** 规范化动作：弃牌保留手牌索引与牌种；吃牌保留组合；补杠关联副露（§3.3）。 */
export interface AnalysisLegalAction {
  /** 窗口内稳定 ID（候选引用它）。 */
  id: string
  kind: string
  /** 牌种（有则填）。 */
  tile?: string
  /** 弃牌时的当时手牌索引：涉及摸切/锁手时语义不可丢。 */
  handIndex?: number
  /** 被鸣/被胡的来源座位。 */
  from?: number | null
  /** 吃牌组合。 */
  meld?: string[]
  /** 补杠所关联的副露下标。 */
  meldIndex?: number
}

// ─────────────────────────────── §3.3 合法动作、策略候选与选择 ───────────────────────────────

/** 策略候选：模型／本地策略**实际能选**的动作（过滤后的），以及被限制的动作与原因（§3.3）。 */
export interface AnalysisCandidate {
  legalActionId: string
  action: AnalysisLegalAction
  /** 被限制／降权的原因码（例如路线收窄、硬性限制）。 */
  reason?: string
}

/** 选择时**已经计算过**的量；没有计算的字段是 UNKNOWN，不填 0（§3.3）。 */
export interface AnalysisEstimates {
  immediateIncome?: AnalysisMaybe<number>
  predictedIncome?: AnalysisMaybe<number>
  riskCost?: AnalysisMaybe<number>
  composite?: AnalysisMaybe<number>
  changeThreshold?: AnalysisMaybe<number>
  /** 启发式分数不能冒充点数净收益：注明单位与来源。 */
  units?: string
  /** 是否计入支出。 */
  includesPayments?: boolean
  /** 预测范围（例如"到局末"）。 */
  horizon?: string
}

export interface AnalysisDecision {
  id: string
  /** 关联：场次／局／权威代次／窗口／状态版本／绝对座位（§3.2）。 */
  matchId: string
  roundIndex: number
  authorityEpoch: string
  windowId: string
  stateVersion: number
  seat: number
  windowKind: AnalysisWindowKind
  sourceEventId?: string
  /** 决策前态引用（§3.2）。 */
  stateId: string
  /** 策略候选与被限制的动作（§3.3）；未接线时保持**未定义**，与"候选集为空"区分开。 */
  candidates?: AnalysisCandidate[]
  restricted?: Array<{ legalActionId: string; reason: string }>
  /** 当时给出的推荐（LLM 座位必须记录**真正发给该次请求的**推荐，不能用新版补算）。 */
  recommended?: AnalysisMaybe<{ legalActionId: string; note?: string }>
  /** 实际选择与来源、执行回执（§3.4）。 */
  choice: AnalysisMaybe<{ legalActionId: string; action: AnalysisLegalAction }>
  source: AnalysisChoiceSource
  execution: {
    commandId?: string
    status: AnalysisExecutionStatus
    eventId?: string
    /** 引擎最终实际执行的动作：可能不是选择里的那个（被更高优先级压过）。 */
    executedLegalActionId?: string
    /** 原因以实际运行分支为准。 */
    detail?: string
  }
  estimates?: AnalysisEstimates
  /** 关键耗时（§3.5）：本进程单调时钟，跨端关联用事件 ID。 */
  timing: {
    windowOpenedAt?: number
    startedAt?: number
    completedAt?: number
    submittedAt?: number
    deadlineAt?: number
    /** 本地 AI：计算耗时与超时；LLM：见 llmAttempts。 */
    computeMs?: number
    timedOut?: boolean
  }
  /** 主动过牌／拒胡：只有当时存在合法胡牌候选且选择其他动作才算拒胡（§3.4）。 */
  passed?: boolean
  declinedWin?: boolean
  /** 锁手后的强制动作可用精简记录（§3.4）。 */
  forced?: boolean
  configId: string
  /** LLM 座位：本决策的请求尝试（§4）。 */
  llmAttemptIds?: string[]
}

// ─────────────────────────────── §4 LLM 专有补充 ───────────────────────────────

export type AnalysisLlmOutcome =
  | 'success' | 'network-error' | 'timeout' | 'cancelled' | 'parse-failed' | 'candidate-missing'

export interface AnalysisLlmAttempt {
  id: string
  decisionId: string
  requestId: string
  attempt: number
  seat: number
  /** 模型：供应商标识、请求模型、可得返回版本、采样开关。 */
  provider: string
  requestModel: string
  responseModel: AnalysisMaybe<string>
  sampling: Record<string, unknown>
  /** 输入引用：模板版本 + 实际变量输入（模板按版本去重存一次）。 */
  promptTemplateId?: string
  promptVariables?: Record<string, unknown>
  /** 最终回答（模型输出给应用的决策内容，不是内部思考）。 */
  answer?: AnalysisMaybe<{ text: string; candidateId?: string; note?: string }>
  outcome: AnalysisLlmOutcome
  /** 回退链路：触发原因、使用的回退配置、回退动作（§4）。 */
  fallback?: { reason: string; strategy: string; legalActionId?: string }
  timing: { sentAt?: number; firstByteAt?: number; completedAt?: number; cancelledAt?: number; durationMs?: number }
  /** 只在接口已有返回时附带，不为它们新增请求（§4）。 */
  usage?: Record<string, number>
}

// ─────────────────────────────── §5 结构化计分流水 ───────────────────────────────

/** 复用血流权威账本：每次结算引用保存一次，不在每个决策重复复制（§5）。 */
export interface AnalysisSettlement {
  id: string
  roundIndex: number
  roundId: string
  sourceEventId: string
  kind: string
  winners: number[]
  payers: number[]
  deltas: number[]
  scoresAfter: number[]
  /** 同一张牌的一炮多响保留同源关系。 */
  batchId: string
  capped?: boolean
  /** 与展示回放结算一致、且整场分数守恒（§5、§10.5）。 */
  fingerprint?: string
}

// ─────────────────────────────── §6 赛后私有复现数据 ───────────────────────────────

/**
 * 赛后私有数据：联机场景不能为分析向普通客户端提前泄露牌墙或对手暗手，
 * 只能由有权限的权威端在局后提供；无法提供时明确标记"复现能力不足"（§6）。
 */
export interface AnalysisReproduction {
  roundIndex: number
  available: boolean
  /**
   * 完整初始物理牌墙（发牌后剩余），**记牌码**（`m1`/`south`）。
   * 优先保存牌墙而不是只存随机种子（算法变化会让同种子产生不同牌局，§6）。
   * 读取侧 `tileFromName` 两种写法都认：2026-09-21 之前写下的记录是中文显示名，照样能读。
   */
  initialWall?: string[]
  /**
   * 四家初始手牌与庄家第 14 张的下标。
   * **必须记**：引擎走 `opening.players[].hand` 建立手牌（`options.opening ?? this.deal()`），
   * 手牌并非由 `initialWall` 推出，只记牌墙无法重建开局（§6、§10.6）。
   */
  initialHands?: string[][]
  dealerDrawnIndex?: number
  /** 开局必需但记录里曾遗漏的字段（引擎的 opening 需要它们，缺一不可）。 */
  jokers?: string[]
  flipSeat?: number
  /**
   * **两个**翻精（引擎 opening.flipTiles 是二元组）。
   * 第二个由牌墙环按 flipStack 推出，推算规则容易随实现漂移，所以直接记下来而不是事后算。
   */
  flipTiles?: string[]
  dealer?: number
  dice?: { first?: number[]; second?: number[] }
  flipTile?: string | null
  flipStack?: number | null
  wallBreakIndex?: number
  openingScores?: number[]
  /** 完整权威命令（含过牌）与执行顺序：仅有牌墙和展示步骤不足以精确复现。 */
  /**
   * 完整权威命令（含过牌）与执行顺序。
   * **必须带动作载荷**：只有 kind 无法重跑（例如 discard 需要牌种与当时手牌索引），
   * 这正是 §10.6「完整记录可重放到同一结束状态」的前提。
   */
  commands?: Array<{
    seat: number
    kind: string
    at: number
    /** 窗口内稳定 ID（与决策/候选对齐；缺失说明该命令未接线到合法动作集）。 */
    legalActionId?: string
    /**
     * 所属窗口：用于消解记录顺序的歧义 —— 机器人命令要等权威回传才知道内容，
     * 可能排在超时计时器压入的 expire 之后；校验时以"该窗口有真命令"为准丢弃过期的 expire。
     */
    windowId?: string
    /**
     * 这条记录是怎么产生的：
     * - `command`（默认）：真实提交的动作，可复现；
     * - `auto`：该窗口没有本端决策（无 provider / 超时），由权威机器人代决 ——
     *   记录里不含它的选择，因此重跑时必须如实报"无法复现"，而不是笼统说"命令不足"；
     * - `expire`：该窗口**没人决定**，靠超时推进 —— 重跑时要把时钟推过截止时间再推进，
     *   否则状态会与当时分叉（实测过：重放到第 N 条就报"该座位此刻没有合法动作"）。
     */
    resolution?: 'command' | 'auto' | 'expire'
    /**
     * 该条目所属窗口的类型（`turn`／`meld`／`win`…）。§11：只有把两侧**同编号窗口的 kind** 对照，
     * 才能区分「记录侧多压/少压 expire」与「权威端推进方式与记录不一致」——
     * 实测失败现场出现过"同一编号在重放里是 win、在记录里却是 peng"这类错位。
     */
    windowKind?: string
    /** `expire` 条目专用：当时的等待座位（谁的响应本该出现）。 */
    waitingSeats?: number[]
    tile?: string
    /** 吃/杠等组合动作的牌集合：这类动作在引擎里不带单张 `tile`，只比 kind 会吃错组合。 */
    tiles?: string[]
    handIndex?: number
    from?: number | null
    meldIndex?: number
  }>
  /** 其他随机决策的算法版本与种子。 */
  randomSources?: Array<{ scope: string; algorithm: string; seed: string }>
  /** 无法提供时的原因（不能猜测补齐）。 */
  unavailableReason?: string
}

// ─────────────────────────────── §7 数据组织 ───────────────────────────────

/** 每场一次的分析块；展示回放仍是公开字段的唯一来源（§9.3）。 */
export interface AnalysisMatchBlock {
  formatVersion: number
  matchId: string
  rulesetId: string
  createdAt: number
  completeness: AnalysisCompleteness
  /** 缺失范围与原因（容量／队列／写入失败都要留痕，§9.5）。 */
  gaps?: Array<{ scope: string; from?: number; to?: number; reason: string }>
  configurations: AnalysisConfigRecord[]
  decisionStates: AnalysisDecisionState[]
  decisions: AnalysisDecision[]
  llmAttempts: AnalysisLlmAttempt[]
  settlements: AnalysisSettlement[]
  reproduction: AnalysisReproduction[]
}

/** 分析区的落库状态（§9.2：未开启／完整／部分缺失／已删除）。 */
export type AnalysisAreaStatus = 'disabled' | AnalysisStoredStatus
