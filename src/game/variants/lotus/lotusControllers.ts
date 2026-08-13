// 「莲花麻将」控制器：人类（Promise+UI 桥）与 AI（纯决策封装）。
// 决策（做什么）在 lotusAi，回合编排（谁继续、何时继续）在 lotusGame/lotusTurnOrchestrator，
// 这里把「某个玩家的回合/响应」转换成可执行的命令。
import type { Meld, TileType } from '../../core/contracts/types'
import type { ActionPrompt } from '../../core/contracts/gamePort'
import { isWinningHand, type ChiMeld } from './lotusRules'
import {
  decideClaim,
  decideRobKong,
  decideTurn,
} from './lotusAi'
import type { LotusTurnDecision } from './lotusAi'
import { createPendingAction } from '../../shared/runtime/pendingAction'

// ── 动作与上下文类型 ──────────────────────────────────────────────

export type LotusTurnAction =
  | { kind: 'win' }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'wind-kong' }
  | { kind: 'discard'; handIndex: number }

export interface LotusTurnContext {
  hand: TileType[]
  melds: Meld[]
  exposedMelds: number
  kongBloom: boolean
  skipDraw: boolean
  isDealer: boolean
  jokers: TileType[]
}

export interface LotusHuContext {
  hand: TileType[]
  exposedMelds: number
  tile: TileType
  from: number
  dihu: boolean
  jokers: TileType[]
  canPeng: boolean
  canGang: boolean
  chiOptions: ChiMeld[]
}

export interface LotusClaimContext {
  hand: TileType[]
  canGang: boolean
  tile: TileType
  from: number
  jokers: TileType[]
}

export interface LotusChiContext {
  hand: TileType[]
  tile: TileType
  from: number
  chiOptions: ChiMeld[]
  jokers: TileType[]
}

export interface LotusRobKongContext {
  hand: TileType[]
  exposedMelds: number
  tile: TileType
  from: number
  jokers: TileType[]
}

export type LotusClaimAction =
  | { kind: 'gang' }
  | { kind: 'peng'; discardIndex?: number }
  | { kind: 'pass' }

export type LotusChiAction = { kind: 'chi'; meld: ChiMeld } | { kind: 'pass' }
export type LotusHuAction =
  | { kind: 'win' }
  | { kind: 'peng' }
  | { kind: 'gang' }
  | { kind: 'chi'; meld: ChiMeld }
  | { kind: 'pass' }
export type LotusRobKongAction = 'win' | 'pass'

export interface LotusController {
  requestTurn(ctx: LotusTurnContext): Promise<LotusTurnAction>
  /** 他家弃牌后询问是否点炮胡（优先级最高） */
  requestDiscardHu(ctx: LotusHuContext): Promise<LotusHuAction>
  /** 他家弃牌后询问碰/直杠 */
  requestClaim(ctx: LotusClaimContext): Promise<LotusClaimAction>
  /** 弃牌下家询问吃（吃面子在 ctx.chiOptions 中） */
  requestChi(ctx: LotusChiContext): Promise<LotusChiAction>
  requestRobKong(ctx: LotusRobKongContext): Promise<LotusRobKongAction>
  onDiscarded?(): void
  reset?(): void
}

interface Ref<T> { value: T }

/** 人类玩家的 UI 桥（与 useGame 内部响应式状态对接） */
export interface LotusHumanBridge {
  isTurn: Ref<boolean>
  canHu: Ref<boolean>
  canKong: Ref<TileType[]>
  canWindKong: Ref<boolean>
  actionPrompt: Ref<ActionPrompt | null>
  selectedIndex: Ref<number>
  drawnThisTurn: Ref<boolean>
  turnSeconds: Ref<number>
  activateTurn(): void
  activateHu(): void
  activateClaim(): void
  activateChi(): void
  activateRobKong(): void
  deactivate(): void
}

export interface ThinkDelays {
  turn: number
  afterKong: number
  claim: number
}

export const LOTUS_AI_DELAYS: ThinkDelays = { turn: 650, afterKong: 550, claim: 500 }

// ── HumanController ────────────────────────────────────────────────

export class LotusHumanController implements LotusController {
  readonly delays: ThinkDelays = { turn: 0, afterKong: 0, claim: 0 }

  private readonly turnAction = createPendingAction<LotusTurnAction>()
  private readonly huAction = createPendingAction<LotusHuAction>()
  private readonly claimAction = createPendingAction<LotusClaimAction>()
  private readonly chiAction = createPendingAction<LotusChiAction>()
  private readonly robKongAction = createPendingAction<LotusRobKongAction>()

  constructor(private bridge: LotusHumanBridge) {}

  async requestTurn(ctx: LotusTurnContext): Promise<LotusTurnAction> {
    this.bridge.isTurn.value = true
    this.bridge.drawnThisTurn.value = !ctx.skipDraw
    this.bridge.selectedIndex.value = -1
    this.bridge.actionPrompt.value = null
    this.bridge.canHu.value = !ctx.skipDraw && isWinningHand(ctx.hand, ctx.exposedMelds, ctx.jokers)
    this.bridge.canKong.value = []
    this.bridge.canWindKong.value = false
    this.bridge.activateTurn()
    return this.turnAction.request()
  }

  async requestDiscardHu(ctx: LotusHuContext): Promise<LotusHuAction> {
    this.bridge.actionPrompt.value = {
      type: 'response',
      tile: ctx.tile,
      from: ctx.from,
      canHu: true,
      canPeng: ctx.canPeng,
      canGang: ctx.canGang,
      chiOptions: ctx.chiOptions,
    }
    this.bridge.activateHu()
    return this.huAction.request()
  }

  async requestClaim(ctx: LotusClaimContext): Promise<LotusClaimAction> {
    this.bridge.actionPrompt.value = {
      type: 'claim',
      tile: ctx.tile,
      from: ctx.from,
      canGang: ctx.canGang,
    }
    this.bridge.activateClaim()
    return this.claimAction.request()
  }

  async requestChi(ctx: LotusChiContext): Promise<LotusChiAction> {
    this.bridge.actionPrompt.value = {
      type: 'chi',
      tile: ctx.tile,
      from: ctx.from,
      chiOptions: ctx.chiOptions,
    }
    this.bridge.activateChi()
    return this.chiAction.request()
  }

  async requestRobKong(ctx: LotusRobKongContext): Promise<LotusRobKongAction> {
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
    this.huAction.clear()
    this.claimAction.clear()
    this.chiAction.clear()
    this.robKongAction.clear()
  }

  // ── resolve 助手（供 lotusHuman 用户操作控制器调用）──

  hasPendingTurn() { return this.turnAction.hasPending() }
  hasPendingHu() { return this.huAction.hasPending() }
  hasPendingClaim() { return this.claimAction.hasPending() }
  hasPendingChi() { return this.chiAction.hasPending() }
  hasPendingRobKong() { return this.robKongAction.hasPending() }

  resolveDiscard(index: number) {
    if (!this.turnAction.resolve({ kind: 'discard', handIndex: index })) return
    this._cleanupTurn()
  }
  resolveWin() {
    if (!this.turnAction.resolve({ kind: 'win' })) return
    this._cleanupTurn()
  }
  resolveAddedKong(meldIndex: number) {
    if (!this.turnAction.resolve({ kind: 'added-kong', meldIndex })) return
    this._cleanupTurn()
  }
  resolveConcealedKong(tile: TileType) {
    if (!this.turnAction.resolve({ kind: 'concealed-kong', tile })) return
    this._cleanupTurn()
  }
  resolveWindKong() {
    if (!this.turnAction.resolve({ kind: 'wind-kong' })) return
    this._cleanupTurn()
  }
  resolveHu(action: LotusHuAction) {
    if (!this.huAction.resolve(action)) return
    this._cleanupHu()
  }
  resolveClaimPeng() {
    if (!this.claimAction.resolve({ kind: 'peng' })) return
    this._cleanupClaim()
  }
  resolveClaimGang() {
    if (!this.claimAction.resolve({ kind: 'gang' })) return
    this._cleanupClaim()
  }
  resolveClaimPass() {
    if (!this.claimAction.resolve({ kind: 'pass' })) return
    this._cleanupClaim()
  }
  resolveChi(meld: ChiMeld) {
    if (!this.chiAction.resolve({ kind: 'chi', meld })) return
    this._cleanupChi()
  }
  resolveChiPass() {
    if (!this.chiAction.resolve({ kind: 'pass' })) return
    this._cleanupChi()
  }
  resolveRobKongAction(action: LotusRobKongAction) {
    if (!this.robKongAction.resolve(action)) return
    this._cleanupRobKong()
  }

  private _cleanupTurn() {
    this.bridge.isTurn.value = false
    this.bridge.deactivate()
  }
  private _cleanupHu() {
    this.bridge.actionPrompt.value = null
    this.bridge.deactivate()
  }
  private _cleanupClaim() {
    this.bridge.actionPrompt.value = null
    this.bridge.deactivate()
  }
  private _cleanupChi() {
    this.bridge.actionPrompt.value = null
    this.bridge.deactivate()
  }
  private _cleanupRobKong() {
    this.bridge.actionPrompt.value = null
    this.bridge.deactivate()
  }
}

// ── AiController ───────────────────────────────────────────────────

export class LotusAiController implements LotusController {
  constructor(
    private delays: ThinkDelays = LOTUS_AI_DELAYS,
    private scheduler: (fn: () => void, ms: number) => void = (fn, ms) => setTimeout(fn, ms),
    private random: () => number = Math.random,
  ) {}

  async requestTurn(ctx: LotusTurnContext): Promise<LotusTurnAction> {
    await this.wait(ctx.kongBloom ? this.delays.afterKong : this.delays.turn)
    return this.mapTurn(decideTurn({
      hand: ctx.hand,
      melds: ctx.melds,
      exposedMelds: ctx.exposedMelds,
      kongBloom: ctx.kongBloom,
      jokers: ctx.jokers,
    }))
  }

  async requestDiscardHu(ctx: LotusHuContext): Promise<LotusHuAction> {
    return isWinningHand(
      [...ctx.hand, ctx.tile],
      ctx.exposedMelds,
      ctx.jokers,
      ctx.jokers.includes(ctx.tile) ? [ctx.tile] : [],
    )
      ? { kind: 'win' }
      : { kind: 'pass' }
  }

  async requestClaim(ctx: LotusClaimContext): Promise<LotusClaimAction> {
    await this.wait(this.delays.claim)
    // 吃由 requestChi 单独询问，这里 chiOptions 恒为空 → decideClaim 不会返回 chi
    const decision = decideClaim({ hand: ctx.hand, canGang: ctx.canGang, tile: ctx.tile, from: ctx.from, chiOptions: [], jokers: ctx.jokers })
    if (decision.kind === 'gang') return { kind: 'gang' }
    if (decision.kind === 'peng') return { kind: 'peng', discardIndex: decision.discardIndex }
    return { kind: 'pass' }
  }

  async requestChi(ctx: LotusChiContext): Promise<LotusChiAction> {
    await this.wait(this.delays.claim)
    if (!ctx.chiOptions.length) return { kind: 'pass' }
    return { kind: 'chi', meld: ctx.chiOptions[0] }
  }

  async requestRobKong(ctx: LotusRobKongContext): Promise<LotusRobKongAction> {
    return decideRobKong({ hand: ctx.hand, exposedMelds: ctx.exposedMelds, tile: ctx.tile, from: ctx.from, jokers: ctx.jokers })
  }

  onDiscarded(): void {}
  reset(): void {}

  private mapTurn(decision: LotusTurnDecision): LotusTurnAction {
    switch (decision.kind) {
      case 'win': return { kind: 'win' }
      case 'added-kong': return { kind: 'added-kong', meldIndex: decision.meldIndex }
      case 'concealed-kong': return { kind: 'concealed-kong', tile: decision.tile }
      case 'wind-kong': return { kind: 'wind-kong' }
      case 'discard': return { kind: 'discard', handIndex: decision.handIndex }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => this.scheduler(resolve, ms))
  }
}
