import type { PlayerController } from '../controllers/playerController'

interface LocalTimerSchedulerOptions {
  controllers: PlayerController[]
  stopCountdown(): void
  cancelOpening(): void
}

export function createLocalTimerScheduler(options: LocalTimerSchedulerOptions) {
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
