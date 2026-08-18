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
import type { DisconnectableController, RemoteRequestContext } from './remotePlayerController'

function isActionMessage(message: unknown): message is RemotePlayerActionMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const value = message as {
    type?: unknown
    handIndex?: unknown
    action?: unknown
    optionIndex?: unknown
    kind?: unknown
    tile?: unknown
  }
  if (value.type === 'pass' || value.type === 'hu') return true
  if (value.type === 'discard') return Number.isSafeInteger(value.handIndex) && (value.handIndex as number) >= 0
  if (value.type === 'claim') {
    return (value.action === 'peng' || value.action === 'gang' || value.action === 'chi')
      && (value.action !== 'chi'
        ? (value.optionIndex === undefined || (Number.isSafeInteger(value.optionIndex) && (value.optionIndex as number) >= 0))
        : (Number.isSafeInteger(value.optionIndex) && (value.optionIndex as number) >= 0))
  }
  if (value.type === 'gang') {
    if (value.kind === 'wind') return value.tile === undefined
    return (value.kind === 'added' || value.kind === 'concealed')
      && typeof value.tile === 'string' && value.tile.length > 0
  }
  return false
}

/** AI 兜底等待：超过该时长玩家未响应则由 AI 决策本请求（仍持续提示玩家，响应即归还）。
 * 比房主的掉线接管超时（25s）稍短：AI 先兜住本请求，房主侧的 25s 才正式判掉线。 */
const REMOTE_FALLBACK_MS = 22000

export class LotusRemotePlayerController implements LotusController, DisconnectableController {
  private pending: ((action: RemotePlayerActionMessage) => void) | null = null
  private pendingPayload: ServerRequest | null = null
  private aiMode = false
  private peerId: string
  private readonly ai: LotusAiController
  private requestSequence = 0
  private readonly requestContext?: RemoteRequestContext

  constructor(
    private readonly room: VibeHubSDK.Room,
    peerId: string,
    private readonly onPending?: (pending: boolean) => void,
    ai: LotusAiController = new LotusAiController(),
    private readonly onAIControlledChange?: (ai: boolean) => void,
    requestContext?: RemoteRequestContext,
  ) {
    this.ai = ai
    this.requestContext = requestContext
    this.peerId = peerId
    room.onMessage((message, fromPeerId) => {
      if (fromPeerId !== this.peerId || !isActionMessage(message)) return
      if (this.pending === null) {
        // AI 兜底后的迟到动作不是连接恢复凭据，不能撤销房主的 AI 接管状态。
        // 真人恢复必须经过当前连接的 join/hello 续接路径。
        return
      }
      if (this.requestContext && message.requestId !== this.pendingPayload?.requestId) return
      if (this.aiMode) {
        this.aiMode = false
        this.onAIControlledChange?.(false)
      }
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

  resendPending(): boolean {
    if (this.pending === null || this.pendingPayload === null) return false
    this.room.send(this.pendingPayload, this.peerId)
    return true
  }

  getPendingRequestMeta(): { requestId: string; requestSeq: number; round: number } | null {
    const payload = this.pendingPayload
    if (!payload?.requestId || payload.requestSeq == null || payload.round == null) return null
    return { requestId: payload.requestId, requestSeq: payload.requestSeq, round: payload.round }
  }

  private request(payload: ServerRequest): Promise<RemotePlayerActionMessage> {
    const enriched = this.requestContext
      ? {
          ...payload,
          authorityEpoch: this.requestContext.authorityEpoch,
          round: this.requestContext.getRound(),
          ...(this.requestContext.seat != null ? { targetSeat: this.requestContext.seat } : {}),
          requestSeq: ++this.requestSequence,
          requestId: `${this.requestContext.authorityEpoch}:${this.requestSequence}`,
        }
      : payload
    return new Promise((resolve) => {
      this.pending = resolve
      this.pendingPayload = enriched
      this.onPending?.(true)
      this.room.send(enriched, this.peerId)
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
    const requestId = this.pendingPayload?.requestId
    let fallbackTriggered = false
    const fallback = this.wait(REMOTE_FALLBACK_MS).then(() => {
      if (!requestId || !this.pendingPayload || this.pendingPayload.requestId !== requestId) {
        return new Promise<T>(() => {})
      }
      // 解除挂起（防止迟到响应重复生效），但不能解析 wire：wire 一旦解析，
      // 它的 then 会和 fallback 竞争并把本次请求错误地当成真人 pass。AI 的决定
      // 必须是当前请求唯一的引擎输入。
      fallbackTriggered = true
      if (this.pending) {
        this.pending = null
        this.pendingPayload = null
        this.onPending?.(false)
      }
      this.enableAI()
      return ai()
    })
    return Promise.race([
      wire.then((response) => {
        if (!fallbackTriggered) this.disableAI()
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
          if (response.handIndex >= 0 && response.handIndex < ctx.hand.length) {
            return { kind: 'discard', handIndex: response.handIndex }
          }
          break
        case 'hu':
          return { kind: 'win' }
        case 'gang':
          if (response.kind === 'concealed' && response.tile
            && ctx.hand.filter((tile) => tile === response.tile).length >= 4) {
            return { kind: 'concealed-kong', tile: response.tile }
          }
          if (response.kind === 'added' && response.tile) {
            const meldIndex = ctx.melds.findIndex((meld) => meld.type === 'peng' && meld.tile === response.tile)
            if (meldIndex >= 0 && ctx.hand.includes(response.tile)) {
              return { kind: 'added-kong', meldIndex }
            }
            break
          }
          if (response.kind === 'wind' && windKong(ctx.hand, ctx.jokers)) {
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
      this.mapCombinedClaim(response, ctx.chiOptions, ctx.canPeng, ctx.canGang)
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
        if (response.action === 'peng' && ctx.canPeng) return { kind: 'peng' }
        if (response.action === 'gang' && ctx.canGang) return { kind: 'gang' }
        if (response.action === 'chi') {
          const meld = response.optionIndex != null ? ctx.chiOptions[response.optionIndex] : undefined
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
        const meld = response.optionIndex != null ? ctx.chiOptions[response.optionIndex] : undefined
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
    canPeng: boolean,
    canGang: boolean,
  ): LotusHuAction {
    if (response.type === 'hu') return { kind: 'win' }
    if (response.type === 'claim') {
      if (response.action === 'peng' && canPeng) return { kind: 'peng' }
      if (response.action === 'gang' && canGang) return { kind: 'gang' }
      if (response.action === 'chi') {
        const meld = response.optionIndex != null ? chiOptions[response.optionIndex] : undefined
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
