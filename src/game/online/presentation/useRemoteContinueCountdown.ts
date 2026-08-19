import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { GameMode } from '../../core/contracts/activeGamePort'
import type { GamePhase, RoundResult } from '../../core/contracts/gamePort'

interface ContinueCountdownSources {
  gameMode: Ref<GameMode>
  phase: Ref<GamePhase>
  result: Ref<RoundResult | null>
  matchFinished: Ref<boolean>
  waitingNextRound: Ref<boolean>
  continueRound: () => void
}

export function useRemoteContinueCountdown(sources: ContinueCountdownSources) {
  // 浏览器回归/人工取证可关闭 10 秒自动确认，稳定停留在结算页验证刷新重进。
  // 默认线上行为不变；参数只影响显式带 manualContinue=1 的当前页面。
  const manualContinue = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('manualContinue') === '1'
  const countdown = ref(manualContinue ? 0 : 10)
  let timer: number | null = null

  function stop() {
    if (timer != null) {
      window.clearInterval(timer)
      timer = null
    }
    countdown.value = manualContinue ? 0 : 10
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
      if (active && !manualContinue) start()
      else stop()
    },
  )

  onUnmounted(stop)

  return countdown
}
