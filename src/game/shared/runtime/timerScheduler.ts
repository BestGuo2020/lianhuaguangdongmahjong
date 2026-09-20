export interface ResettableController {
  reset?(): void
}

interface TimerSchedulerOptions {
  controllers: ResettableController[]
  stopCountdown(): void
  cancelOpening(): void
  /** 无头模式：later 立即（0ms）触发、wait 立即 resolve，用于权威引擎即时推进逻辑。 */
  instant?: boolean
}

export function createTimerScheduler(options: TimerSchedulerOptions) {
  const timers = new Set<number>()
  const { instant = false } = options

  function later(callback: () => void, delay = 600) {
    if (instant) {
      const id = window.setTimeout(() => {
        timers.delete(id)
        callback()
      }, 0)
      timers.add(id)
      return id
    }
    const id = window.setTimeout(() => {
      timers.delete(id)
      callback()
    }, delay)
    timers.add(id)
    return id
  }

  function wait(delay: number): Promise<void> {
    if (instant) return Promise.resolve()
    return new Promise((resolve) => { later(resolve, delay) })
  }

  function clear() {
    options.cancelOpening()
    timers.forEach((id) => window.clearTimeout(id))
    timers.clear()
    options.stopCountdown()
    options.controllers.forEach((controller) => controller.reset?.())
  }

  return { later, wait, clear }
}
