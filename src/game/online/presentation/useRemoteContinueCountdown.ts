import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { GameMode } from '../../core/activeGamePort'
import type { RoundResult } from '../../core/gamePort'

interface ContinueCountdownSources {
  gameMode: Ref<GameMode>
  phase: Ref<string>
  result: Ref<RoundResult | null>
  matchFinished: Ref<boolean>
  waitingNextRound: Ref<boolean>
  continueRound: () => void
}

export function useRemoteContinueCountdown(sources: ContinueCountdownSources) {
  const countdown = ref(10)
  let timer: number | null = null

  function stop() {
    if (timer != null) {
      window.clearInterval(timer)
      timer = null
    }
    countdown.value = 10
  }

  function start() {
    stop()
    timer = window.setInterval(() => {
      countdown.value -= 1
      if (countdown.value <= 0) {
        stop()
        sources.continueRound()
      }
    }, 1000)
  }

  watch(
    [sources.result, sources.phase, sources.gameMode, sources.matchFinished, sources.waitingNextRound],
    () => {
      const active = sources.gameMode.value === 'remote'
        && sources.phase.value === 'settled'
        && Boolean(sources.result.value)
        && !sources.waitingNextRound.value
        && !sources.matchFinished.value
      if (active) start()
      else stop()
    },
  )

  onUnmounted(stop)

  return countdown
}
