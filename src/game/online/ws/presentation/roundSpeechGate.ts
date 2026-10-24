/** 等服务端局末发言队列结束；断线或服务端漏发完成消息时不会永久卡住结算。 */
export function createRoundSpeechGate(timeoutMs = 60_000) {
  const completed = new Set<string>()
  const pending = new Map<string, {
    promise: Promise<void>; resolve: () => void; timer: number; playbacks: Promise<unknown>[]
  }>()
  let generation = 0

  function finish(key: string) {
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    globalThis.clearTimeout(entry.timer)
    entry.resolve()
  }

  function ensure(key: string) {
    const existing = pending.get(key)
    if (existing) return existing
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    const timer = globalThis.setTimeout(() => {
      completed.add(key)
      finish(key)
    }, timeoutMs) as unknown as number
    const entry = { promise, resolve, timer, playbacks: [] as Promise<unknown>[] }
    pending.set(key, entry)
    return entry
  }

  return {
    wait(key: string): Promise<void> {
      return completed.has(key) ? Promise.resolve() : ensure(key).promise
    },
    track(key: string, playback: Promise<unknown>) {
      if (!completed.has(key)) ensure(key).playbacks.push(playback)
    },
    complete(key: string) {
      if (completed.has(key)) return
      const entry = ensure(key)
      if (!entry.playbacks.length) {
        completed.add(key)
        finish(key)
        return
      }
      const epoch = generation
      void Promise.allSettled(entry.playbacks).then(() => {
        if (epoch !== generation) return
        completed.add(key)
        finish(key)
      })
    },
    reset() {
      generation += 1
      for (const key of pending.keys()) finish(key)
      completed.clear()
    },
  }
}
