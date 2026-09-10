import type { WinEvaluation, WinEvaluationInput } from '../bloodFlow/types'
import type { evaluateWaits } from './evaluate'
import type { EvaluationRequest } from './worker'
import type { HandWaitHints, HandWaitInput } from './handWaits'
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

/** Browser callers run exhaustive search off the UI thread. Termination cancels pending
 * requests; it never publishes a partial score. Authority decides how to resume a window. */
export function createEvaluatorService() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let serial = 0
  let stopped = false
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>()
  function cancel(reason = new Error('Evaluation cancelled')) {
    stopped = true
    worker.terminate()
    for (const item of pending.values()) item.reject(reason)
    pending.clear()
  }
  worker.onmessage = ({ data }) => {
    const item = pending.get(data.id)
    if (!item) return
    pending.delete(data.id)
    if (data.error) item.reject(new Error(data.error))
    else item.resolve(data.result)
  }
  worker.onerror = () => cancel(new Error('Evaluation worker failed'))
  function request<T>(body: WithoutId<EvaluationRequest>): Promise<T> {
    if (stopped) return Promise.reject(new Error('Evaluator stopped'))
    const id = ++serial
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      worker.postMessage({ ...body, id })
    })
  }
  return {
    evaluate: (input: WinEvaluationInput) => request<WinEvaluation | null>({ kind: 'win', input }),
    waits: (input: Omit<WinEvaluationInput, 'winningTile' | 'source' | 'opening'>) => request<ReturnType<typeof evaluateWaits>>({ kind: 'waits', input }),
    handWaits: (input: HandWaitInput) => request<HandWaitHints>({ kind: 'hand-waits', input }),
    cancel,
  }
}
