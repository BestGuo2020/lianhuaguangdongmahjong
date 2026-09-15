import { BloodFlowEngine } from './engine'
import type { BloodFlowEngineOptions } from './engine'
import type { EngineCommand } from './state'
import type { Seat } from './types'
import { bloodFlowSeatView } from './seatView'
import { decideBloodFlowAction, decideBloodFlowActionEv } from './ai'
import { BLOOD_FLOW_AI } from './config'
import { evaluateWaits } from '../patterns/evaluate'

export type EngineWorkerRequest = {
  id: number
  /**
   * 本地回放录制：回复里额外附带一份「旁观视角」（四家明牌 + 累计弃牌流水）。
   * 与座位视角同一次回复送达，因此不受 worker 重开/终止影响；该字段永不下发到网络。
   */
  replay?: boolean
} & (
  | { kind: 'start'; options: Omit<BloodFlowEngineOptions, 'random' | 'now'> }
  | { kind: 'command'; command: EngineCommand }
  | { kind: 'bot'; seat: Seat; windowId: string }
  | { kind: 'expire'; windowId: string }
  | { kind: 'advance'; transitionId: string }
  | { kind: 'view'; seat: Seat }
  | { kind: 'pause' | 'resume' }
  | { kind: 'waits'; seat: Seat; discardIndex: number | null; windowId: string }
)
let engine: BloodFlowEngine | null = null
self.onmessage = ({ data }: MessageEvent<EngineWorkerRequest>) => {
  try {
    if (data.kind === 'start') engine = new BloodFlowEngine(data.options)
    if (!engine) throw new Error('No active blood-flow engine')
    let result: unknown
    if (data.kind === 'command') engine.submit(data.command)
    if (data.kind === 'bot' && engine.window?.id === data.windowId) {
      const view = bloodFlowSeatView(engine, data.seat)
      const action = BLOOD_FLOW_AI.strategy === 'legacy'
        ? decideBloodFlowAction(view, BLOOD_FLOW_AI.minimumFirstPayment)
        : decideBloodFlowActionEv(view, BLOOD_FLOW_AI)
      if (action) engine.submit(engine.command(data.seat, action))
    }
    if (data.kind === 'expire') engine.expire(Date.now(), data.windowId)
    if (data.kind === 'advance') engine.advance(data.transitionId)
    if (data.kind === 'pause') engine.pause()
    if (data.kind === 'resume') engine.resume()
    let viewSeat: Seat | null = data.kind === 'view' ? data.seat : 0
    if (data.kind === 'waits') {
      viewSeat = null
      if (engine.window?.id !== data.windowId) result = []
      else {
        const player = engine.players[data.seat]
        const concealed = [...player.hand]
        if (data.discardIndex !== null) concealed.splice(data.discardIndex, 1)
        result = evaluateWaits({ concealed, melds: player.melds, jokers: engine.jokers })
      }
    }
    if (viewSeat !== null) {
      const view = bloodFlowSeatView(engine, viewSeat)
      result = data.replay
        ? { ...view, replay: bloodFlowSeatView(engine, 0, { revealAll: true, includeDiscards: true }) }
        : view
    }
    self.postMessage({ id: data.id, result })
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
