// 房主侧「远程玩家控制器」：把远端玩家的 P2P 输入桥接成广麻引擎的 PlayerController。
//
// 房主跑本地引擎（core/local/useGame）时，用本控制器替代 AiController 给远端真人座位：
// - requestTurn → 发 turn_request → 收 discard/win/gang → TurnAction
// - requestClaim → 发 claim_request → 收 claim(peng/gang)/pass → ClaimAction
// - requestRobKong → 发 rob_kong_request → 收 hu/pass → RobKongAction
//
// 复用现有 wire 协议（messages.ts 的 ServerRequest + remoteActionController 的
// RemotePlayerActionMessage），客户端无需改动：它的 requestCoordinator 已能消费
// turn/claim/rob_kong_request，remoteActionController 已能发回对应动作。
//
// 注意：莲花麻将引擎（LotusController）把「点炮胡/碰杠/吃」拆成 requestDiscardHu/
// requestClaim/requestChi 三个方法，与合并式 claim_request 不一一对应，需另建
// LotusRemotePlayerController（见 docs/vibehub-p2p-migration.md §7）。
import type {
  ClaimAction,
  ClaimContext,
  PlayerController,
  RobKongAction,
  RobKongContext,
  TurnAction,
  TurnContext,
} from '../../core/controllers/playerController'
import { AiController } from '../../core/controllers/playerController'
import type { RemotePlayerActionMessage } from '../orchestration/remoteActionController'
import type { ServerRequest } from '../protocol/messages'

/** 可被房主「掉线接管 / 重连归还」的控制器：掉线后请求改由内部 AI 决策，游戏不卡死。 */
export interface DisconnectableController {
  /** 掉线接管：清除挂起请求（自动过/弃），此后请求改由 AI 决策。 */
  enableAI(): void
  /** 重连归还：恢复远端真人决策。 */
  disableAI(): void
  isAIControlled(): boolean
  /** 重连后身份可能变化（刷新页面 peerId 改变）：把消息过滤改绑到新 peerId。 */
  retargetPeer(peerId: string): void
}

function isActionMessage(message: unknown): message is RemotePlayerActionMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const type = (message as { type?: unknown }).type
  return type === 'discard' || type === 'pass' || type === 'claim' || type === 'gang' || type === 'hu'
}

/** AI 兜底等待：超过该时长玩家未响应则由 AI 决策本请求（仍持续提示玩家，响应即归还）。 */
const REMOTE_FALLBACK_MS = 14000

export class RemotePlayerController implements PlayerController, DisconnectableController {
  private pending: ((action: RemotePlayerActionMessage) => void) | null = null
  private aiMode = false
  private peerId: string
  private readonly ai: AiController

  constructor(
    private readonly room: VibeHubSDK.Room,
    peerId: string,
    private readonly onPending?: (pending: boolean) => void,
    ai: AiController = new AiController(),
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
      this.onPending?.(false)
      resolve(message)
    })
  }

  enableAI(): void {
    if (this.aiMode) return
    this.aiMode = true
    this.onAIControlledChange?.(true)
    // 清除挂起请求：claim → 自动过；turn → 回退弃最后一张，引擎不卡死。
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

  private request(payload: ServerRequest): Promise<RemotePlayerActionMessage> {
    return new Promise((resolve) => {
      this.pending = resolve
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

  async requestTurn(ctx: TurnContext): Promise<TurnAction> {
    if (this.aiMode) {
      return this.requestWithAIFallback(
        {
          kind: 'turn_request',
          ctx: {
            hand: ctx.hand,
            melds: ctx.melds,
            exposedMelds: ctx.exposedMelds,
            kongBloom: ctx.kongBloom,
            skipDraw: ctx.skipDraw,
            afterKong: ctx.afterKong,
          },
        },
        () => this.ai.requestTurn(ctx),
        (response) => this.mapTurnAction(response, ctx),
      )
    }
    const response = await this.request({
      kind: 'turn_request',
      ctx: {
        hand: ctx.hand,
        melds: ctx.melds,
        exposedMelds: ctx.exposedMelds,
        kongBloom: ctx.kongBloom,
        skipDraw: ctx.skipDraw,
        afterKong: ctx.afterKong,
      },
    })
    return this.mapTurnAction(response, ctx)
  }

  private mapTurnAction(response: RemotePlayerActionMessage, ctx: TurnContext): TurnAction {
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
        break
    }
    // 意外/超时回退：弃最后一张（保证引擎不卡死）。
    return { kind: 'discard', handIndex: ctx.hand.length - 1 }
  }

  async requestClaim(ctx: ClaimContext): Promise<ClaimAction> {
    if (this.aiMode) {
      return this.requestWithAIFallback(
        {
          kind: 'claim_request',
          ctx: {
            hand: ctx.hand,
            canPeng: ctx.canPeng,
            canGang: ctx.canGang,
            tile: ctx.tile,
            from: ctx.from,
          },
        },
        () => this.ai.requestClaim(ctx),
        (response) => {
          if (response.type === 'claim') {
            if (response.action === 'peng') return { kind: 'peng' }
            if (response.action === 'gang') return { kind: 'gang' }
          }
          return { kind: 'pass' }
        },
      )
    }
    const response = await this.request({
      kind: 'claim_request',
      ctx: {
        hand: ctx.hand,
        canPeng: ctx.canPeng,
        canGang: ctx.canGang,
        tile: ctx.tile,
        from: ctx.from,
      },
    })
    if (response.type === 'claim') {
      if (response.action === 'peng') return { kind: 'peng' }
      if (response.action === 'gang') return { kind: 'gang' }
    }
    return { kind: 'pass' }
  }

  async requestRobKong(ctx: RobKongContext): Promise<RobKongAction> {
    if (this.aiMode) {
      return this.requestWithAIFallback(
        {
          kind: 'rob_kong_request',
          ctx: { tile: ctx.tile, from: ctx.from, hand: ctx.hand, exposedMelds: ctx.exposedMelds },
        },
        () => this.ai.requestRobKong(ctx),
        (response) => (response.type === 'hu' ? 'win' : 'pass'),
      )
    }
    const response = await this.request({
      kind: 'rob_kong_request',
      ctx: { tile: ctx.tile, from: ctx.from, hand: ctx.hand, exposedMelds: ctx.exposedMelds },
    })
    return response.type === 'hu' ? 'win' : 'pass'
  }

  onDiscarded(): void {
    // 远端玩家无需本地标记清理。
  }

  reset(): void {
    // 游戏重置/结束时清除挂起请求，避免 Promise 永久悬挂。
    if (this.pending) {
      const resolve = this.pending
      this.pending = null
      this.onPending?.(false)
      resolve({ type: 'pass' })
    }
    this.ai.reset?.()
  }
}
