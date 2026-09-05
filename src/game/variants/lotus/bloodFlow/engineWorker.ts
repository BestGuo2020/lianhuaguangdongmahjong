import { BloodFlowEngine } from './engine'
import type { BloodFlowEngineOptions } from './engine'
import type { EngineCommand } from './state'
import type { Seat } from './types'
import { bloodFlowSeatView } from './seatView'
import { decideBloodFlowAction } from './ai'
import { evaluateWaits } from '../patterns/evaluate'

export type EngineWorkerRequest = { id: number } & (
  | { kind: 'start'; options: Omit<BloodFlowEngineOptions, 'random' | 'now'> }
  | { kind: 'command'; command: EngineCommand }
  | { kind: 'bot'; seat: Seat; windowId: string }
  | { kind: 'expire'; windowId: string }
  | { kind: 'view'; seat: Seat }
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
      const action = decideBloodFlowAction(bloodFlowSeatView(engine, data.seat))
      if (action) engine.submit(engine.command(data.seat, action))
    }
    if (data.kind === 'expire') engine.expire(Date.now(), data.windowId)
    if (data.kind === 'waits') {
      if (engine.window?.id !== data.windowId) result = []
      else {
        const player = engine.players[data.seat]
        const concealed = [...player.hand]
        if (data.discardIndex !== null) concealed.splice(data.discardIndex, 1)
        result = evaluateWaits({ concealed, melds: player.melds, jokers: engine.jokers })
      }
    } else result = bloodFlowSeatView(engine, data.kind === 'view' ? data.seat : 0)
    self.postMessage({ id: data.id, result })
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
