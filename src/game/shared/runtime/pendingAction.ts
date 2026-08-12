export interface PendingAction<T> {
  hasPending(): boolean
  request(): Promise<T>
  resolve(value: T): boolean
  clear(): void
}

export function createPendingAction<T>(): PendingAction<T> {
  let resolver: ((value: T) => void) | null = null

  function request() {
    return new Promise<T>((resolve) => { resolver = resolve })
  }

  function resolve(value: T) {
    if (!resolver) return false
    const current = resolver
    resolver = null
    current(value)
    return true
  }

  function clear() {
    resolver = null
  }

  return {
    hasPending: () => resolver !== null,
    request,
    resolve,
    clear,
  }
}
