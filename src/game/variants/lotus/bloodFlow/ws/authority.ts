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
}

export interface BloodFlowWsTransport {
  send(message: Record<string, unknown>): boolean
}

export interface BloodFlowWsAuthorityOptions {
  transport: BloodFlowWsTransport
  onView: (view: BloodFlowSeatView, meta: BloodFlowWsMeta) => void
  onError?: (code: string) => void
}

export interface BloodFlowWsAuthority {
  /** 消息路由器入口：把 WS 消息喂进来（rejoin_ok / bf_snapshot / error）。 */
  feed(message: unknown): void
  /** externalAuthority.send：把权威命令发给后端。 */
  send(command: EngineCommand): boolean
  /** externalAuthority.nextRound：后端 v1 无续局消息，结算 UI 自行推进（no-op）。 */
  nextRound(): void
  /** externalAuthority.leave：后端 v1 无离开消息（no-op，由房间生命周期管理）。 */
  leave(): void
  /** externalAuthority.openingDone：后端 v1 快照无开局动画数据，直接进入对局视图（no-op）。 */
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

export function createBloodFlowWsAuthority(options: BloodFlowWsAuthorityOptions): BloodFlowWsAuthority {
  let closed = false
  return {
    feed(message) {
      if (closed || typeof message !== 'object' || message === null) return
      const kind = (message as { kind?: unknown }).kind
      if (kind === 'error') {
        options.onError?.(String((message as { code?: unknown }).code ?? 'UNKNOWN'))
        return
      }
      if (kind !== 'bf_snapshot') return
      const payload = message as { view?: unknown; round?: unknown; mode?: unknown; dealer?: unknown; matchFinished?: unknown; opening?: unknown }
      if (!isBloodFlowView(payload.view)) return
      const round = Number.isInteger(payload.round) ? Number(payload.round) : 0
      const mode: MatchType = payload.mode === 'hanchan' ? 'hanchan' : 'east'
      const dealer = Number.isInteger(payload.dealer) && SEATS.includes(Number(payload.dealer) as Seat)
        ? Number(payload.dealer) as Seat : 0
      options.onView(payload.view, {
        round, mode, dealer, matchFinished: payload.matchFinished === true,
        ...(isOpening(payload.opening) ? { opening: payload.opening } : {}),
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
    nextRound() { /* 后端 v1 无续局消息 */ },
    leave() { /* 由房间生命周期管理 */ },
    openingDone(round) { options.transport.send({ kind: 'opening_done', round }) },
    close() { closed = true },
  }
}
