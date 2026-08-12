// 「莲花麻将」计时调度：与核心 localTimerScheduler 等价，但控制器类型按本引擎定义。
interface LotusTimerOptions {
  controllers: Array<{ reset?: () => void }>
  stopCountdown(): void
  cancelOpening(): void
}

export function createLotusTimer(options: LotusTimerOptions) {
  const timers = new Set<number>()

  function later(callback: () => void, delay = 600) {
    const id = window.setTimeout(() => {
      timers.delete(id)
      callback()
    }, delay)
    timers.add(id)
    return id
  }

  function wait(delay: number): Promise<void> {
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
