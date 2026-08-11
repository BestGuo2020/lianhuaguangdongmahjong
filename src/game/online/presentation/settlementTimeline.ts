import type { RefLike, RoundResult } from '../../core/gamePort'
import type { WinPresentation } from '../../core/types'
import {
  prefersReducedMotion,
  REDUCED_WIN_EFFECT_DURATION,
  REDUCED_WIN_REVEAL_DURATION,
  WIN_EFFECT_DURATION,
  WIN_EFFECT_SOUND_DELAY,
  WIN_REVEAL_DURATION,
} from '../../core/winEffect'
import type { ServerSnapshot } from '../protocol/dto'

export interface SettlementTimelineState {
  phase: RefLike<string>
  result: RefLike<RoundResult | null>
  winEffect: RefLike<RoundResult | null>
  winPresentation: RefLike<WinPresentation | null>
  revealHands: RefLike<boolean>
  winningPlayerIndex: RefLike<number>
}

export interface SettlementTimelineOptions {
  state: SettlementTimelineState
  mapResult: (result: RoundResult | null) => RoundResult | null
  mapPresentation: (presentation: WinPresentation | null) => WinPresentation | null
  toLocalSeat: (seat: number) => number
  playSound: (name: string, volume?: number) => unknown
  reducedMotion?: () => boolean
}

export function createSettlementTimeline({
  state,
  mapResult,
  mapPresentation,
  toLocalSeat,
  playSound,
  reducedMotion = prefersReducedMotion,
}: SettlementTimelineOptions) {
  let serial = 0
  const timers = new Set<number>()

  function later(callback: () => void, delay: number) {
    const timer = globalThis.setTimeout(() => {
      timers.delete(timer as unknown as number)
      callback()
    }, delay) as unknown as number
    timers.add(timer)
  }

  function cancel() {
    serial += 1
    timers.forEach((timer) => globalThis.clearTimeout(timer))
    timers.clear()
  }

  function start(snapshot: ServerSnapshot) {
    cancel()
    const currentSerial = serial
    const mappedResult = mapResult(snapshot.result)
    const presentation = mapPresentation(snapshot.winPresentation)
    state.winningPlayerIndex.value = snapshot.winningPlayerIndex >= 0
      ? toLocalSeat(snapshot.winningPlayerIndex)
      : (mappedResult?.winnerIndex ?? -1)
    const isDraw = Boolean(snapshot.result?.draw) || !presentation

    if (isDraw) {
      state.phase.value = 'revealing'
      state.revealHands.value = true
      state.winPresentation.value = null
      state.winEffect.value = null
      later(() => {
        if (serial !== currentSerial) return
        state.phase.value = 'settled'
        state.result.value = mappedResult
      }, 600)
      return
    }

    const reduceMotion = reducedMotion()
    const effectDuration = reduceMotion ? REDUCED_WIN_EFFECT_DURATION : WIN_EFFECT_DURATION
    const revealDuration = reduceMotion ? REDUCED_WIN_REVEAL_DURATION : WIN_REVEAL_DURATION
    state.phase.value = 'win-effect'
    state.revealHands.value = false
    state.winPresentation.value = presentation
    state.winEffect.value = {
      winnerIndex: state.winningPlayerIndex.value,
      tile: presentation.tile,
      robbedKong: presentation.robbedKong,
      robbedKongPlayerIndex: presentation.robbedKongPlayerIndex,
      robbedKongMeldIndex: presentation.robbedKongMeldIndex,
      duration: effectDuration,
      reducedMotion: reduceMotion,
      id: Date.now(),
    }
    playSound(presentation.robbedKong ? 'hu.mp3' : 'zimo.mp3')
    if (!reduceMotion) {
      later(() => {
        if (serial === currentSerial) playSound('hu_effect_sound.mp3', 0.72)
      }, WIN_EFFECT_SOUND_DELAY)
    }
    later(() => {
      if (serial !== currentSerial) return
      state.phase.value = 'revealing'
      state.winEffect.value = null
      state.revealHands.value = true
      later(() => {
        if (serial !== currentSerial) return
        state.phase.value = 'settled'
        state.result.value = mappedResult
      }, revealDuration)
    }, effectDuration)
  }

  return { start, cancel }
}
