/** 等服务端局末发言队列结束；断线或服务端漏发完成消息时不会永久卡住结算。 */
export function createRoundSpeechGate(timeoutMs = 60_000) {
  const completed = new Set<string>()
  const pending = new Map<string, { promise: Promise<void>; resolve: () => void; timer: number }>()

  function finish(key: string) {
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    globalThis.clearTimeout(entry.timer)
    entry.resolve()
  }

  return {
    wait(key: string): Promise<void> {
      if (completed.has(key)) return Promise.resolve()
      const existing = pending.get(key)
      if (existing) return existing.promise
      let resolve!: () => void
      const promise = new Promise<void>((done) => { resolve = done })
      const timer = globalThis.setTimeout(() => {
        completed.add(key)
        finish(key)
      }, timeoutMs) as unknown as number
      pending.set(key, { promise, resolve, timer })
      return promise
    },
    complete(key: string) {
      completed.add(key)
      finish(key)
    },
    reset() {
      for (const key of pending.keys()) finish(key)
      completed.clear()
    },
  }
}
