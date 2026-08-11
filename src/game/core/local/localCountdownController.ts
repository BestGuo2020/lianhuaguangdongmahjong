import type { LocalGameState } from './localGameState'

interface LocalCountdownControllerOptions {
  state: LocalGameState
  playSound(name: string, volume?: number): unknown
  onDiscard(): void
  onPass(): void
}

export function createLocalCountdownController(options: LocalCountdownControllerOptions) {
  const { state } = options
  let handle: number | null = null

  function stop() {
    window.clearInterval(handle)
    handle = null
  }

  function startTurn() {
    stop()
    state.turnSeconds.value = 12
    handle = window.setInterval(() => {
      if (state.phase.value !== 'discard' || state.currentPlayer.value !== 0) return
      state.turnSeconds.value -= 1
      if (state.turnSeconds.value === 3) options.playSound('didu.ogg')
      if (state.turnSeconds.value <= 0) {
        stop()
        state.selectedIndex.value = (state.players[0]?.hand.length ?? 0) - 1
        options.onDiscard()
      }
    }, 1000)
  }

  function startPrompt() {
    stop()
    state.turnSeconds.value = 12
    const prompt = state.actionPrompt.value
    handle = window.setInterval(() => {
      if (state.phase.value !== 'prompt' || state.actionPrompt.value !== prompt) return stop()
      state.turnSeconds.value -= 1
      if (state.turnSeconds.value === 3) options.playSound('didu.ogg')
      if (state.turnSeconds.value <= 0) {
        stop()
        options.onPass()
      }
    }, 1000)
  }

  return { startTurn, startPrompt, stop }
}
