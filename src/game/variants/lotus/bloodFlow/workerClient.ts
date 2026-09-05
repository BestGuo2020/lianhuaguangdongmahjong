import type { EngineWorkerRequest } from './engineWorker'

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
export function createBloodFlowWorkerClient() {
  const worker = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' })
  let serial = 0, closed = false
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  function close(reason = new Error('Blood-flow worker closed')) {
    closed = true; worker.terminate()
    pending.forEach(p => p.reject(reason)); pending.clear()
  }
  worker.onerror = () => close(new Error('Blood-flow engine unavailable'))
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    if (data.error) request.reject(new Error(data.error))
    else request.resolve(data.result)
  }
  return {
    request<T>(body: WithoutId<EngineWorkerRequest>): Promise<T> {
      if (closed) return Promise.reject(new Error('Blood-flow worker closed'))
      const id = ++serial
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        try { worker.postMessage({ ...body, id }) } catch (e) { pending.delete(id); reject(e) }
      })
    },
    close,
  }
}
