// 血流 WS 权威适配（M3）——把后端血流房间的 bf_snapshot 消息接到 useBloodFlowGame 的
// externalAuthority 端口。快照形状与 bloodFlowSeatView 一致（后端 blood_flow_room.py）。
//
// 生产开关：BLOOD_FLOW_AVAILABILITY 暂不开启 ws；本模块是代码路径与类型契约，
// 大厅接线在联机验收（真实 wakudemo 会话双端冒烟）后再放行。
import type { MatchType } from '../../../../core/contracts/types'
import type { EngineCommand } from '../state'
import type { BloodFlowSeatView } from '../seatView'
import type { Seat } from '../types'

export interface BloodFlowWsOpening {
  firstDice: [number, number]
  secondDice: [number, number]
}

export interface BloodFlowWsMeta {
  round: number
  mode: MatchType
  dealer: number
  matchFinished?: boolean
  /** 每局首份快照携带的骰点：驱动联机开局动画（掷骰/翻精/发牌）。 */
  opening?: BloodFlowWsOpening
  /** 结算快照携带的局间就绪计数（与 P2P 信封同形状）。 */
  continuation?: { readySeats: Seat[]; requiredSeats: Seat[] }
}

export interface BloodFlowWsTransport {
  send(message: Record<string, unknown>): boolean
}

/** 服务端模型原话气泡（llm_message）：文本来自模型回复，不是客户端模板台词。 */
export interface BloodFlowWsSpeech {
  id: number
  seat: Seat
  text: string
  priority: 'normal' | 'important'
  purpose: string
  speechSource: string
  actionKind?: string
}

/** 服务端 TTS 音频（llm_audio）：audioUrl 为相对路径，调用方自行拼 API_BASE。 */
export interface BloodFlowWsAudio {
  messageId: number
  seat: Seat
  audioUrl: string
  priority: 'normal' | 'important'
  purpose: string
  speechSource: string
}

export interface BloodFlowWsAuthorityOptions {
  transport: BloodFlowWsTransport
  onView: (view: BloodFlowSeatView, meta: BloodFlowWsMeta) => void
  /** 模型原话气泡：与 llm_message 同帧到达，按座位落到牌桌气泡。 */
  onSpeech?: (message: BloodFlowWsSpeech) => void
  /** 服务端合成音频：与经典联机同一条播放通道（messageId 去重）。 */
  onAudio?: (message: BloodFlowWsAudio) => void
  onError?: (code: string) => void
}

export interface BloodFlowWsAuthority {
  /** 消息路由器入口：把 WS 消息喂进来（rejoin_ok / bf_snapshot / error）。 */
  feed(message: unknown): void
  /** externalAuthority.send：把权威命令发给后端。 */
  send(command: EngineCommand): boolean
  /** 托管开关：交权给服务端代打（P2P 的 blood_flow_auto 在 WS 下的对应消息）。 */
  setAuto(enabled: boolean): boolean
  /** externalAuthority.nextRound：确认进入下一局（局间屏障回执）。 */
  continueRound(): void
  /** externalAuthority.leave：后端 v1 无离开消息（no-op，由房间生命周期管理）。 */
  leave(): void
  /** externalAuthority.openingDone：开局动画播完回执（就绪屏障）。 */
  openingDone(round: number): void
  close(): void
}

const SEATS: readonly Seat[] = [0, 1, 2, 3]

function isBloodFlowView(value: unknown): value is BloodFlowSeatView {
  if (typeof value !== 'object' || value === null) return false
  const view = value as Partial<BloodFlowSeatView>
  return typeof view.authorityEpoch === 'string'
    && typeof view.roundId === 'string'
    && SEATS.includes(view.seat as Seat)
    && Array.isArray(view.players)
    && typeof view.wallCount === 'number'
    && Array.isArray(view.jokers)
    && typeof view.public === 'object' && view.public !== null
}

function isOpening(value: unknown): value is BloodFlowWsOpening {
  if (typeof value !== 'object' || value === null) return false
  const opening = value as { firstDice?: unknown; secondDice?: unknown }
  return isDicePair(opening.firstDice) && isDicePair(opening.secondDice)
}

function isDicePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n))
}

function isContinuation(value: unknown): value is { readySeats: Seat[]; requiredSeats: Seat[] } {
  if (typeof value !== 'object' || value === null) return false
  const seats = (item: unknown): item is Seat[] => (
    Array.isArray(item) && item.every((seat) => SEATS.includes(seat as Seat))
  )
  const continuation = value as { readySeats?: unknown; requiredSeats?: unknown }
  return seats(continuation.readySeats) && seats(continuation.requiredSeats)
}

export function createBloodFlowWsAuthority(options: BloodFlowWsAuthorityOptions): BloodFlowWsAuthority {
  let closed = false
  let lastRound = 0
  return {
    feed(message) {
      if (closed || typeof message !== 'object' || message === null) return
      const kind = (message as { kind?: unknown }).kind
      if (kind === 'error') {
        options.onError?.(String((message as { code?: unknown }).code ?? 'UNKNOWN'))
        return
      }
      if (kind === 'llm_message') {
        // 服务端模型原话：id 为服务端自增序号，用于气泡/音频去重。
        const payload = message as { id?: unknown; seat?: unknown; text?: unknown; priority?: unknown;
          purpose?: unknown; speechSource?: unknown; actionKind?: unknown }
        if (!Number.isInteger(payload.id) || !SEATS.includes(payload.seat as Seat)
          || typeof payload.text !== 'string' || !payload.text) return
        options.onSpeech?.({
          id: payload.id as number, seat: payload.seat as Seat, text: payload.text,
          priority: payload.priority === 'important' ? 'important' : 'normal',
          purpose: typeof payload.purpose === 'string' ? payload.purpose : 'commentary',
          speechSource: typeof payload.speechSource === 'string' ? payload.speechSource : 'model-message',
          ...(typeof payload.actionKind === 'string' ? { actionKind: payload.actionKind } : {}),
        })
        return
      }
      if (kind === 'llm_audio') {
        const payload = message as { messageId?: unknown; seat?: unknown; audioUrl?: unknown;
          priority?: unknown; purpose?: unknown; speechSource?: unknown }
        if (!Number.isInteger(payload.messageId) || !SEATS.includes(payload.seat as Seat)
          || typeof payload.audioUrl !== 'string' || !payload.audioUrl) return
        options.onAudio?.({
          messageId: payload.messageId as number, seat: payload.seat as Seat,
          audioUrl: payload.audioUrl,
          priority: payload.priority === 'important' ? 'important' : 'normal',
          purpose: typeof payload.purpose === 'string' ? payload.purpose : 'commentary',
          speechSource: typeof payload.speechSource === 'string' ? payload.speechSource : 'model-message',
        })
        return
      }
      if (kind !== 'bf_snapshot') return
      const payload = message as { view?: unknown; round?: unknown; mode?: unknown; dealer?: unknown; matchFinished?: unknown; opening?: unknown; continuation?: unknown }
      if (!isBloodFlowView(payload.view)) return
      const round = Number.isInteger(payload.round) ? Number(payload.round) : 0
      lastRound = round
      const mode: MatchType = payload.mode === 'hanchan' ? 'hanchan' : 'east'
      const dealer = Number.isInteger(payload.dealer) && SEATS.includes(Number(payload.dealer) as Seat)
        ? Number(payload.dealer) as Seat : 0
      options.onView(payload.view, {
        round, mode, dealer, matchFinished: payload.matchFinished === true,
        ...(isOpening(payload.opening) ? { opening: payload.opening } : {}),
        ...(isContinuation(payload.continuation) ? { continuation: payload.continuation } : {}),
      })
    },
    send(command) {
      return options.transport.send({
        kind: 'action',
        windowId: command.windowId,
        stateVersion: command.stateVersion,
        action: command.action,
      })
    },
    continueRound() { options.transport.send({ kind: 'continue', round: lastRound }) },
    setAuto(enabled) { return options.transport.send({ kind: 'auto', enabled }) },
    leave() { /* 由房间生命周期管理 */ },
    openingDone(round) { options.transport.send({ kind: 'opening_done', round }) },
    close() { closed = true },
  }
}
