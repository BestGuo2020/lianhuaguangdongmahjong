import { getCurrentInstance, onUnmounted, ref, watch, type Ref } from 'vue'
import type { GameMode } from '../../core/contracts/activeGamePort'
import type { GamePhase, RoundResult } from '../../core/contracts/gamePort'

interface ContinueCountdownSources {
  gameMode: Ref<GameMode>
  phase: Ref<GamePhase>
  result: Ref<RoundResult | null>
  matchFinished: Ref<boolean>
  waitingNextRound: Ref<boolean>
  continueRound: () => void
  /** 本倒计时是否由当前玩法接管；血流用自己的结算面板倒计时（按演出播完起算），
   *  必须关掉这一份，否则隐藏的 10s 会在演出未播完时抢先回执（「没到 0 就进下一局」）。 */
  enabled?: Ref<boolean>
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
    [sources.result, sources.phase, sources.gameMode, sources.matchFinished, sources.waitingNextRound,
      ...(sources.enabled ? [sources.enabled] : [])],
    () => {
      const active = (sources.enabled?.value ?? true)
        && sources.gameMode.value === 'remote'
        && sources.phase.value === 'settled'
        && Boolean(sources.result.value)
        && !sources.waitingNextRound.value
        && !sources.matchFinished.value
      if (active) start()
      else stop()
    },
  )

  // 组件外调用（单测/无头脚本）不注册卸载钩子，避免 Vue 无实例告警。
  if (getCurrentInstance()) onUnmounted(stop)

  return countdown
}
