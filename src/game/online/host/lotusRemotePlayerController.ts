// 房主侧「莲花麻将远端玩家控制器」：把远端玩家的 P2P 输入桥接成 LotusController。
//
// 与广麻不同，莲花引擎把弃牌后的询问拆成 requestDiscardHu / requestClaim / requestChi：
// - requestDiscardHu（点炮胡优先）上下文自带 canPeng/canGang/chiOptions → 对应 wire 的合并式
//   claim_request（canHu + canPeng + canGang + chiOptions），客户端回应 hu/peng/gang/chi/pass。
// - requestClaim（碰/直杠）与 requestChi（下家吃）各自发专用 claim_request（无 canHu）。
// 其余 requestTurn / requestRobKong 与广麻 RemotePlayerController 同构（复用现有 wire）。
import type {
  LotusChiAction,
  LotusChiContext,
  LotusClaimAction,
  LotusClaimContext,
  LotusController,
  LotusHuAction,
  LotusHuContext,
  LotusRobKongAction,
  LotusRobKongContext,
  LotusTurnAction,
  LotusTurnContext,
} from '../../variants/lotus/lotusControllers'
import type { RemotePlayerActionMessage } from '../orchestration/remoteActionController'
import type { ServerRequest } from '../protocol/messages'
import { windKong } from '../../variants/lotus/lotusRules'
import { LotusAiController } from '../../variants/lotus/lotusControllers'
import type { DisconnectableController } from './remotePlayerController'

function isActionMessage(message: unknown): message is RemotePlayerActionMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const type = (message as { type?: unknown }).type
  return type === 'discard' || type === 'pass' || type === 'claim' || type === 'gang' || type === 'hu'
}

/** AI 兜底等待：超过该时长玩家未响应则由 AI 决策本请求（仍持续提示玩家，响应即归还）。 */
const REMOTE_FALLBACK_MS = 14000

export class LotusRemotePlayerController implements LotusController, DisconnectableController {
  private pending: ((action: RemotePlayerActionMessage) => void) | null = null
  private pendingPayload: ServerRequest | null = null
  private aiMode = false
  private peerId: string
  private readonly ai: LotusAiController

  constructor(
    private readonly room: VibeHubSDK.Room,
    peerId: string,
    private readonly onPending?: (pending: boolean) => void,
    ai: LotusAiController = new LotusAiController(),
    private readonly onAIControlledChange?: (ai: boolean) => void,
  ) {
    this.ai = ai
    this.peerId = peerId
    room.onMessage((message, fromPeerId) => {
      if (fromPeerId !== this.peerId || !isActionMessage(message)) return
      // 玩家消息回来了 → 立即归还真人决策（AI 只是兜底，不是永久接管）。
      if (this.aiMode) {
        this.aiMode = false
        this.onAIControlledChange?.(false)
      }
      if (this.pending === null) return
      const resolve = this.pending
      this.pending = null
      this.pendingPayload = null
      this.onPending?.(false)
      resolve(message)
    })
  }

  enableAI(): void {
    if (this.aiMode) return
    this.aiMode = true
    this.onAIControlledChange?.(true)
    this.reset()
  }

  disableAI(): void {
    if (!this.aiMode) return
    this.aiMode = false
    this.onAIControlledChange?.(false)
  }

  isAIControlled(): boolean {
    return this.aiMode
  }

  retargetPeer(peerId: string): void {
    this.peerId = peerId
  }

  resendPending(): void {
    if (this.pending === null || this.pendingPayload === null) return
    this.room.send(this.pendingPayload, this.peerId)
  }

  private request(payload: ServerRequest): Promise<RemotePlayerActionMessage> {
    return new Promise((resolve) => {
      this.pending = resolve
      this.pendingPayload = payload
      this.onPending?.(true)
      this.room.send(payload, this.peerId)
    })
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms) })
  }

  /**
   * AI 兜底：仍向玩家发送请求（玩家响应即归还并采用其操作）；超时无响应则由 AI
   * 决策本请求。这样 AI 接管不是永久性的——玩家的下一条消息就能夺回座位。
   */
  private requestWithAIFallback<T>(
    payload: ServerRequest,
    ai: () => Promise<T>,
    mapWire: (response: RemotePlayerActionMessage) => T,
  ): Promise<T> {
    const wire = this.request(payload)
    const fallback = this.wait(REMOTE_FALLBACK_MS).then(() => {
      // 解除挂起（防止迟到响应重复生效），并由 AI 决策本请求。
      if (this.pending) {
        const resolve = this.pending
        this.pending = null
        this.pendingPayload = null
        this.onPending?.(false)
        resolve({ type: 'pass' })
      }
      this.enableAI()
      return ai()
    })
    return Promise.race([
      wire.then((response) => {
        this.disableAI()
        return mapWire(response)
      }),
      fallback,
    ])
  }

  async requestTurn(ctx: LotusTurnContext): Promise<LotusTurnAction> {
    const payload = {
      kind: 'turn_request' as const,
      ctx: {
        hand: ctx.hand,
        melds: ctx.melds,
        exposedMelds: ctx.exposedMelds,
        kongBloom: ctx.kongBloom,
        skipDraw: ctx.skipDraw,
        afterKong: ctx.kongBloom,
        jokers: ctx.jokers,
        // 风杠可用性按手牌实算（东南西北各 1），不能恒 true——否则客户端每个回合都显示风杠按钮。
        canWindKong: windKong(ctx.hand, ctx.jokers ?? []),
      },
    }
    const mapWire = (response: RemotePlayerActionMessage): LotusTurnAction => {
      switch (response.type) {
        case 'discard':
          return { kind: 'discard', handIndex: response.handIndex }
        case 'hu':
          return { kind: 'win' }
        case 'gang':
          if (response.kind === 'concealed' && response.tile) {
            return { kind: 'concealed-kong', tile: response.tile }
          }
          if (response.kind === 'added' && response.tile) {
            const meldIndex = ctx.melds.findIndex((meld) => meld.type === 'peng' && meld.tile === response.tile)
            return { kind: 'added-kong', meldIndex: Math.max(0, meldIndex) }
          }
          if (response.kind === 'wind') {
            return { kind: 'wind-kong' }
          }
          break
      }
      return { kind: 'discard', handIndex: ctx.hand.length - 1 }
    }
    if (this.aiMode) return this.requestWithAIFallback(payload, () => this.ai.requestTurn(ctx), mapWire)
    return mapWire(await this.request(payload))
  }

  async requestDiscardHu(ctx: LotusHuContext): Promise<LotusHuAction> {
    const payload = {
      kind: 'claim_request' as const,
      ctx: {
        hand: ctx.hand,
        canPeng: ctx.canPeng,
        canHu: true,
        canGang: ctx.canGang,
        chiOptions: ctx.chiOptions,
        tile: ctx.tile,
        from: ctx.from,
      },
    }
    const mapWire = (response: RemotePlayerActionMessage): LotusHuAction => (
      this.mapCombinedClaim(response, ctx.chiOptions)
    )
    if (this.aiMode) return this.requestWithAIFallback(payload, () => this.ai.requestDiscardHu(ctx), mapWire)
    return mapWire(await this.request(payload))
  }

  async requestClaim(ctx: LotusClaimContext): Promise<LotusClaimAction> {
    const payload = {
      kind: 'claim_request' as const,
      ctx: {
        hand: ctx.hand,
        canPeng: ctx.canPeng,
        canGang: ctx.canGang,
        // 吃仅下家可吃：只在手牌可吃时给 chiOptions，客户端据此显示「吃」按钮；
        // 此前漏传导致只能吃（不能碰/杠）的下家吃牌按钮消失。
        chiOptions: ctx.chiOptions,
        tile: ctx.tile,
        from: ctx.from,
      },
    }
    const mapWire = (response: RemotePlayerActionMessage): LotusClaimAction => {
      if (response.type === 'claim') {
        if (response.action === 'peng') return { kind: 'peng' }
        if (response.action === 'gang') return { kind: 'gang' }
        if (response.action === 'chi') {
          const meld = ctx.chiOptions[response.optionIndex ?? 0]
          if (meld) return { kind: 'chi', meld }
        }
      }
      return { kind: 'pass' }
    }
    if (this.aiMode) return this.requestWithAIFallback(payload, () => this.ai.requestClaim(ctx), mapWire)
    return mapWire(await this.request(payload))
  }

  async requestChi(ctx: LotusChiContext): Promise<LotusChiAction> {
    const payload = {
      kind: 'claim_request' as const,
      ctx: {
        hand: ctx.hand,
        canGang: false,
        chiOptions: ctx.chiOptions,
        tile: ctx.tile,
        from: ctx.from,
      },
    }
    const mapWire = (response: RemotePlayerActionMessage): LotusChiAction => {
      if (response.type === 'claim' && response.action === 'chi') {
        const meld = ctx.chiOptions[response.optionIndex ?? 0]
        if (meld) return { kind: 'chi', meld }
      }
      return { kind: 'pass' }
    }
    if (this.aiMode) return this.requestWithAIFallback(payload, () => this.ai.requestChi(ctx), mapWire)
    return mapWire(await this.request(payload))
  }

  async requestRobKong(ctx: LotusRobKongContext): Promise<LotusRobKongAction> {
    const payload = {
      kind: 'rob_kong_request' as const,
      ctx: { tile: ctx.tile, from: ctx.from, hand: ctx.hand, exposedMelds: ctx.exposedMelds },
    }
    const mapWire = (response: RemotePlayerActionMessage): LotusRobKongAction => (
      response.type === 'hu' ? 'win' : 'pass'
    )
    if (this.aiMode) return this.requestWithAIFallback(payload, () => this.ai.requestRobKong(ctx), mapWire)
    return mapWire(await this.request(payload))
  }

  private mapCombinedClaim(
    response: RemotePlayerActionMessage,
    chiOptions: LotusHuContext['chiOptions'],
  ): LotusHuAction {
    if (response.type === 'hu') return { kind: 'win' }
    if (response.type === 'claim') {
      if (response.action === 'peng') return { kind: 'peng' }
      if (response.action === 'gang') return { kind: 'gang' }
      if (response.action === 'chi') {
        const meld = chiOptions[response.optionIndex ?? 0]
        if (meld) return { kind: 'chi', meld }
      }
    }
    return { kind: 'pass' }
  }

  onDiscarded(): void { /* 远端玩家无需本地标记清理 */ }

  reset(): void {
    if (this.pending) {
      const resolve = this.pending
      this.pending = null
      this.pendingPayload = null
      this.onPending?.(false)
      resolve({ type: 'pass' })
    }
    this.ai.reset?.()
  }
}
