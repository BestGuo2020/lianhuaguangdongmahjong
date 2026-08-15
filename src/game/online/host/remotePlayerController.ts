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
import type { RemotePlayerActionMessage } from '../orchestration/remoteActionController'
import type { ServerRequest } from '../protocol/messages'

function isActionMessage(message: unknown): message is RemotePlayerActionMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const type = (message as { type?: unknown }).type
  return type === 'discard' || type === 'pass' || type === 'claim' || type === 'gang' || type === 'hu'
}

export class RemotePlayerController implements PlayerController {
  private pending: ((action: RemotePlayerActionMessage) => void) | null = null

  constructor(
    private readonly room: VibeHubSDK.Room,
    private readonly peerId: string,
    private readonly onPending?: (pending: boolean) => void,
  ) {
    room.onMessage((message, fromPeerId) => {
      if (fromPeerId !== peerId || this.pending === null || !isActionMessage(message)) return
      const resolve = this.pending
      this.pending = null
      this.onPending?.(false)
      resolve(message)
    })
  }

  private request(payload: ServerRequest): Promise<RemotePlayerActionMessage> {
    return new Promise((resolve) => {
      this.pending = resolve
      this.onPending?.(true)
      this.room.send(payload, this.peerId)
    })
  }

  async requestTurn(ctx: TurnContext): Promise<TurnAction> {
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
    // 意外/超时回退：弃最后一张（保证引擎不卡死；超时策略后续细化）。
    return { kind: 'discard', handIndex: ctx.hand.length - 1 }
  }

  async requestClaim(ctx: ClaimContext): Promise<ClaimAction> {
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
  }
}
