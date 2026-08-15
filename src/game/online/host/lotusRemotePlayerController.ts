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

function isActionMessage(message: unknown): message is RemotePlayerActionMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const type = (message as { type?: unknown }).type
  return type === 'discard' || type === 'pass' || type === 'claim' || type === 'gang' || type === 'hu'
}

export class LotusRemotePlayerController implements LotusController {
  private pending: ((action: RemotePlayerActionMessage) => void) | null = null

  constructor(
    private readonly room: VibeHubSDK.Room,
    private readonly peerId: string,
  ) {
    room.onMessage((message, fromPeerId) => {
      if (fromPeerId !== peerId || this.pending === null || !isActionMessage(message)) return
      const resolve = this.pending
      this.pending = null
      resolve(message)
    })
  }

  private request(payload: ServerRequest): Promise<RemotePlayerActionMessage> {
    return new Promise((resolve) => {
      this.pending = resolve
      this.room.send(payload, this.peerId)
    })
  }

  async requestTurn(ctx: LotusTurnContext): Promise<LotusTurnAction> {
    const response = await this.request({
      kind: 'turn_request',
      ctx: {
        hand: ctx.hand,
        melds: ctx.melds,
        exposedMelds: ctx.exposedMelds,
        kongBloom: ctx.kongBloom,
        skipDraw: ctx.skipDraw,
        afterKong: ctx.kongBloom,
        jokers: ctx.jokers,
        canWindKong: true,
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
        if (response.kind === 'wind') {
          return { kind: 'wind-kong' }
        }
        break
    }
    return { kind: 'discard', handIndex: ctx.hand.length - 1 }
  }

  async requestDiscardHu(ctx: LotusHuContext): Promise<LotusHuAction> {
    const response = await this.request({
      kind: 'claim_request',
      ctx: {
        hand: ctx.hand,
        canPeng: ctx.canPeng,
        canHu: true,
        canGang: ctx.canGang,
        chiOptions: ctx.chiOptions,
        tile: ctx.tile,
        from: ctx.from,
      },
    })
    return this.mapCombinedClaim(response, ctx.chiOptions)
  }

  async requestClaim(ctx: LotusClaimContext): Promise<LotusClaimAction> {
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

  async requestChi(ctx: LotusChiContext): Promise<LotusChiAction> {
    const response = await this.request({
      kind: 'claim_request',
      ctx: {
        hand: ctx.hand,
        canGang: false,
        chiOptions: ctx.chiOptions,
        tile: ctx.tile,
        from: ctx.from,
      },
    })
    if (response.type === 'claim' && response.action === 'chi') {
      const meld = ctx.chiOptions[response.optionIndex ?? 0]
      if (meld) return { kind: 'chi', meld }
    }
    return { kind: 'pass' }
  }

  async requestRobKong(ctx: LotusRobKongContext): Promise<LotusRobKongAction> {
    const response = await this.request({
      kind: 'rob_kong_request',
      ctx: { tile: ctx.tile, from: ctx.from, hand: ctx.hand, exposedMelds: ctx.exposedMelds },
    })
    return response.type === 'hu' ? 'win' : 'pass'
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
      resolve({ type: 'pass' })
    }
  }
}
