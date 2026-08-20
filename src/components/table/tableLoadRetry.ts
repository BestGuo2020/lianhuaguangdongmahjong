export const TABLE_LOAD_RETRY_DELAYS_MS = [750, 1_500, 3_000] as const

interface TableLoadRetryOptions {
  schedule: (callback: () => void, delayMs: number) => number
  cancel: (timer: number) => void
  onRetry: (attempt: number, message: string) => void
  onExhausted: (message: string) => void
}

export function createTableLoadRetryController(options: TableLoadRetryOptions) {
  let retryIndex = 0
  let timer: number | null = null
  let disposed = false

  const cancelPending = () => {
    if (timer === null) return
    options.cancel(timer)
    timer = null
  }

  const reset = () => {
    cancelPending()
    retryIndex = 0
  }

  return {
    fail(message: string) {
      if (disposed || timer !== null) return
      const reason = message || '牌桌资源加载失败'
      const delayMs = TABLE_LOAD_RETRY_DELAYS_MS[retryIndex]
      if (delayMs === undefined) {
        options.onExhausted(reason)
        return
      }
      retryIndex += 1
      const attempt = retryIndex
      timer = options.schedule(() => {
        timer = null
        if (!disposed) options.onRetry(attempt, reason)
      }, delayMs)
    },
    succeed() {
      reset()
    },
    manualRetry() {
      reset()
      options.onRetry(0, '')
    },
    reset,
    dispose() {
      disposed = true
      cancelPending()
    },
  }
}
