import { evaluateWin, evaluateWaits } from './evaluate'
import type { WinEvaluationInput } from '../bloodFlow/types'
import { evaluateHandWaits, type HandWaitInput } from './handWaits'

export type EvaluationRequest = { id: number } & (
  | { kind: 'win'; input: WinEvaluationInput }
  | { kind: 'waits'; input: Omit<WinEvaluationInput, 'winningTile' | 'source' | 'opening'> }
  | { kind: 'hand-waits'; input: HandWaitInput }
)

self.onmessage = ({ data }: MessageEvent<EvaluationRequest>) => {
  try {
    const result = data.kind === 'win' ? evaluateWin(data.input)
      : data.kind === 'hand-waits' ? evaluateHandWaits(data.input) : evaluateWaits(data.input)
    self.postMessage({ id: data.id, result })
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
