// PlayerController 接口 + AiController / HumanController 实现。
// useGame 只依赖 PlayerController 接口，不再区分人类/AI。
// AI 编排（决策时序、延迟）完全封装在 AiController 中。
import { decideClaim, decideRobKong, decideTurn, makeTurnView, chooseDiscardIndex } from './ai'
import type { AITurnView, ClaimDecision, RobKongView, TurnDecision } from './ai'
import { removeMatches } from '../rules/actions'
import type { GamePlayer, Meld, TileType } from '../contracts/types'
import type { ActionPrompt } from '../contracts/gamePort'
import { createPendingAction } from '../../shared/runtime/pendingAction'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'

// ── 共享类型 ──

/**
 * v1.1 LLM 适配字段（可选；Human/Ai 控制器忽略，LLM 控制器消费）。
 * 见 docs/llm-ai-design.md §6.2 / §11 任务 1.1。
 */
export interface LlmAdapterFields {
  /** 决策者座位（绝对索引） */
  playerIndex?: number
  scores?: number[]
  /** 各座位公开弃牌与副露（按座位绝对索引；只读） */
  peers?: Array<{ discards: TileType[]; melds: Array<{ type: string; tile: TileType; tiles: TileType[] }> }>
  seatWind?: string
  roundWind?: string
  dealerIndex?: number
  roundIndex?: number
  requestId?: string
  stateVersion?: string
  visibleTiles?: TileType[]
  publicTiles?: TileType[]
  upperLastDiscard?: TileType | null
  earlyRound?: boolean
  wallCount?: number
  jokerTiles?: TileType[]
  wildcardTiles?: TileType[]
}

/** 回合决策上下文：引擎传给控制器的只读快照 */
export interface TurnContext extends LlmAdapterFields {
  hand: TileType[]
  melds: Meld[]
  /** 公开副露数（结构性，不含花杠），供胡牌判断 */
  exposedMelds: number
  /** 是否从牌墙尾补摸（杠后），用于杠上开花判断 */
  kongBloom: boolean
  /** 本回合是否跳过了摸牌（碰后出牌等场景） */
  skipDraw: boolean
  /** 是否是杠后补摸的回合（用于 AI 选择更短的思考延迟） */
  afterKong: boolean
  ruleset?: RuleSet
}

/** 吃碰杠响应上下文 */
export interface ClaimContext extends LlmAdapterFields {
  hand: TileType[]
  /** 手中至少有两张与弃牌相同的牌时可碰 */
  canPeng: boolean
  canGang: boolean
  /** 被弃出的牌 */
  tile: TileType
  /** 弃牌来源座位 */
  from: number
  /** 结构性副露数（碰后 +1，用于听口评估） */
  exposedMelds?: number
  ruleset?: RuleSet
}

/** 抢杠响应上下文 */
export interface RobKongContext {
  /** 被加杠的牌 */
  tile: TileType
  /** 加杠者座位 */
  from: number
  hand: TileType[]
  exposedMelds: number
}

/** 回合动作命令（与 ai.ts 的 TurnDecision 语义一致，但独立于 ai.ts 以保持接口纯粹） */
export type TurnAction =
  | { kind: 'win' }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'discard'; handIndex: number }

/** 吃碰杠响应动作。peng 可携带 discardIndex 实现 AI 的单次碰+出牌闭环 */
export type ClaimAction =
  | { kind: 'gang' }
  | { kind: 'peng'; discardIndex?: number }
  | { kind: 'pass' }

/** 抢杠响应动作 */
export type RobKongAction = 'win' | 'pass'

/** AI 思考延迟配置 */
export interface ThinkDelays {
  /** 回合决策前的延迟（ms） */
  turn: number
  /** 暗杠补摸后的再决策延迟（ms） */
  afterKong: number
  /** 吃碰杠响应前的延迟（ms） */
  claim: number
}

export const AI_DELAYS: ThinkDelays = { turn: 650, afterKong: 550, claim: 500 }

// ── PlayerController 接口 ──

export interface PlayerController {
  /** 请求该玩家做出回合动作 */
  requestTurn(ctx: TurnContext): Promise<TurnAction>
  /** 请求该玩家响应弃牌（碰/杠/过） */
  requestClaim(ctx: ClaimContext): Promise<ClaimAction>
  /** 请求该玩家响应抢杠机会 */
  requestRobKong(ctx: RobKongContext): Promise<RobKongAction>
  /** 该玩家完成弃牌后的回调（清理 drawnThisTurn 等标记） */
  onDiscarded?(): void
  /** 取消所有待处理操作（游戏重置/结束/新局） */
  reset?(): void
}

// ── 最小化的 Ref 接口（避免直接依赖 Vue）──

interface Ref<T> { value: T }

/** UI 交互提示（与 useGame 内部的 ActionPrompt 形状一致） */
// ── HumanBridge ──

/**
 * HumanBridge：HumanController 与 useGame 引擎之间的桥接。
 * useGame 在构造 HumanController 时提供此对象，注入其内部响应式状态与控制回调。
 */
export interface HumanBridge {
  isTurn: Ref<boolean>
  canHu: Ref<boolean>
  canKong: Ref<TileType[]>
  actionPrompt: Ref<ActionPrompt | null>
  selectedIndex: Ref<number>
  drawnThisTurn: Ref<boolean>
  turnSeconds: Ref<number>

  /** 激活回合 UI：设 phase='discard'、启动倒计时 */
  activateTurn(): void
  /** 激活吃碰杠 UI：设 phase='prompt'、启动倒计时 */
  activateClaim(): void
  /** 激活抢杠 UI：设 phase='prompt'、播报“可抢杠胡” */
  activateRobKong(): void
  /** 停用 UI：清除倒计时、清理 prompt 标记 */
  deactivate(): void
}

// ── HumanController ──

/**
 * HumanController：人类玩家的 PlayerController 实现。
 * 通过 HumanBridge 桥接到 useGame 的响应式 UI 状态，以 Promise 模式
 * 将异步的 UI 事件（点击出牌/碰/杠/胡/过）转换为 PlayerController 接口。
 * 同时暴露 resolve* 方法与 hasPending* 查询，供 useGame 的 user* 函数
 * 在双模模式下使用（pending promise 优先 → 否则走同步回退以兼容测试）。
 */
export class HumanController implements PlayerController {
  readonly delays: ThinkDelays = { turn: 0, afterKong: 0, claim: 0 }

  private readonly turnAction = createPendingAction<TurnAction>()
  private readonly claimAction = createPendingAction<ClaimAction>()
  private readonly robKongAction = createPendingAction<RobKongAction>()

  constructor(private bridge: HumanBridge) {}

  // ── PlayerController 实现 ──

  async requestTurn(ctx: TurnContext): Promise<TurnAction> {
    this.bridge.isTurn.value = true
    this.bridge.drawnThisTurn.value = !ctx.skipDraw
    this.bridge.selectedIndex.value = -1
    this.bridge.actionPrompt.value = null
    this.bridge.canHu.value = !ctx.skipDraw
      && (ctx.ruleset ?? DEFAULT_RULESET).win.isWinningHand(ctx.hand, ctx.exposedMelds)
    this.bridge.canKong.value = [
      ...(ctx.ruleset ?? DEFAULT_RULESET).win.concealedKongs(ctx.hand),
      ...ctx.melds
        .filter((meld) => meld.type === 'peng' && ctx.hand.includes(meld.tile))
        .map((meld) => meld.tile),
    ]
    this.bridge.activateTurn()
    return this.turnAction.request()
  }

  async requestClaim(ctx: ClaimContext): Promise<ClaimAction> {
    this.bridge.actionPrompt.value = {
      type: 'claim',
      tile: ctx.tile,
      from: ctx.from,
      canPeng: ctx.canPeng,
      canGang: ctx.canGang,
    }
    this.bridge.activateClaim()
    return this.claimAction.request()
  }

  async requestRobKong(ctx: RobKongContext): Promise<RobKongAction> {
    this.bridge.actionPrompt.value = { type: 'rob', tile: ctx.tile, from: ctx.from }
    this.bridge.activateRobKong()
    return this.robKongAction.request()
  }

  onDiscarded(): void {
    this.bridge.drawnThisTurn.value = false
  }

  reset(): void {
    this.bridge.deactivate()
    this.bridge.isTurn.value = false
    this.bridge.actionPrompt.value = null
    this.bridge.selectedIndex.value = -1
    this.bridge.drawnThisTurn.value = false
    this.turnAction.clear()
    this.claimAction.clear()
    this.robKongAction.clear()
  }

  // ── 双模支持：供 useGame 的 user* 函数使用 ──

  hasPendingTurn(): boolean { return this.turnAction.hasPending() }
  hasPendingClaim(): boolean { return this.claimAction.hasPending() }
  hasPendingRobKong(): boolean { return this.robKongAction.hasPending() }

  resolveDiscard(index: number): void {
    if (!this.turnAction.resolve({ kind: 'discard', handIndex: index })) return
    this._cleanupTurn()
  }

  resolveWin(): void {
    if (!this.turnAction.resolve({ kind: 'win' })) return
    this._cleanupTurn()
  }

  resolveAddedKong(meldIndex: number): void {
    if (!this.turnAction.resolve({ kind: 'added-kong', meldIndex })) return
    this._cleanupTurn()
  }

  resolveConcealedKong(tile: TileType): void {
    if (!this.turnAction.resolve({ kind: 'concealed-kong', tile })) return
    this._cleanupTurn()
  }

  resolveClaimPeng(): void {
    if (!this.claimAction.resolve({ kind: 'peng' })) return
    this._cleanupClaim()
  }

  resolveClaimGang(): void {
    if (!this.claimAction.resolve({ kind: 'gang' })) return
    this._cleanupClaim()
  }

  resolveClaimPass(): void {
    if (!this.claimAction.resolve({ kind: 'pass' })) return
    this._cleanupClaim()
  }

  resolveRobKongAction(action: RobKongAction): void {
    if (!this.robKongAction.resolve(action)) return
    this._cleanupRobKong()
  }

  // ── 内部清理 ──

  private _cleanupTurn(): void {
    this.bridge.isTurn.value = false
    this.bridge.deactivate()
  }

  private _cleanupClaim(): void {
    this.bridge.actionPrompt.value = null
    this.bridge.deactivate()
  }

  private _cleanupRobKong(): void {
    this.bridge.actionPrompt.value = null
    this.bridge.deactivate()
  }
}

// ── AiController ──

/**
 * AI 玩家控制器：封装 AI 决策的时序编排与纯函数调用。
 * 构造函数注入 scheduler / random 以支持测试确定性。
 */
export class AiController implements PlayerController {
  constructor(
    private delays: ThinkDelays = AI_DELAYS,
    private scheduler: (fn: () => void, ms: number) => void = (fn, ms) => setTimeout(fn, ms),
    private random: () => number = Math.random,
  ) {}

  async requestTurn(ctx: TurnContext): Promise<TurnAction> {
    await this.wait(ctx.afterKong ? this.delays.afterKong : this.delays.turn)
    return this.decideTurn(ctx)
  }

  async requestClaim(ctx: ClaimContext): Promise<ClaimAction> {
    await this.wait(this.delays.claim)
    return this.decideClaim(ctx)
  }

  async requestRobKong(ctx: RobKongContext): Promise<RobKongAction> {
    // 抢杠决策本身无需额外延迟（引擎层面已在 requestAddedKong / offerRobKong 中 pace）
    const view: RobKongView = { hand: ctx.hand, exposedMelds: ctx.exposedMelds, tile: ctx.tile, from: ctx.from }
    return decideRobKong(view)
  }

  onDiscarded(): void { /* AI 无需清理标记 */ }
  reset(): void { /* AI 无待处理 UI 状态 */ }

  // ── 内部决策逻辑 ──

  private decideTurn(ctx: TurnContext): TurnAction {
    const view: AITurnView = makeTurnView(
      { hand: ctx.hand, melds: ctx.melds } as GamePlayer,
      ctx.exposedMelds,
      ctx.kongBloom,
      ctx.ruleset,
    )
    Object.assign(view, {
      playerIndex: ctx.playerIndex,
      visibleTiles: ctx.visibleTiles,
      publicTiles: ctx.publicTiles,
      peers: ctx.peers,
      wallCount: ctx.wallCount,
    })
    const decision: TurnDecision = decideTurn(view, this.random)
    return this.mapTurnDecision(decision)
  }

  private decideClaim(ctx: ClaimContext): ClaimAction {
    const decision: ClaimDecision = decideClaim({
      hand: ctx.hand,
      canGang: ctx.canGang,
      tile: ctx.tile,
      from: ctx.from,
      exposedMelds: ctx.exposedMelds,
      playerIndex: ctx.playerIndex,
      visibleTiles: ctx.visibleTiles,
      publicTiles: ctx.publicTiles,
      peers: ctx.peers,
      wallCount: ctx.wallCount,
      ruleset: ctx.ruleset,
    })
    if (decision === 'gang') return { kind: 'gang' }
    if (decision === 'peng') {
      // 碰后无牌可打（手牌恰好只剩这 2 张）：真实规则下不能碰，
      // 否则出牌阶段手牌为空，discardTile 空手 no-op → 对局停滞在 checking。
      // 与后端 AIPlayer.request_claim 的守卫对齐。
      const afterPeng = removeMatches(ctx.hand, ctx.tile, 2)
      if (!afterPeng.length) return { kind: 'pass' }
      // 预计算碰后弃牌索引，实现 AI 的单次碰+出牌闭环
      const discardIndex = chooseDiscardIndex(
        afterPeng,
        this.random,
        ctx.exposedMelds + 1,
        ctx.ruleset ?? DEFAULT_RULESET,
        ctx,
      )
      return { kind: 'peng', discardIndex }
    }
    return { kind: 'pass' }
  }

  private mapTurnDecision(decision: TurnDecision): TurnAction {
    switch (decision.kind) {
      case 'win': return { kind: 'win' }
      case 'added-kong': return { kind: 'added-kong', meldIndex: decision.meldIndex }
      case 'concealed-kong': return { kind: 'concealed-kong', tile: decision.tile }
      case 'discard': return { kind: 'discard', handIndex: decision.handIndex }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => this.scheduler(resolve, ms))
  }
}
