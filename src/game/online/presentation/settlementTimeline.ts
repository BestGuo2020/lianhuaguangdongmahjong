import type { GamePhase, RefLike, RoundResult, WinEffect } from '../../core/contracts/gamePort'
import type { WinPresentation } from '../../core/contracts/types'
import {
  prefersReducedMotion,
  REDUCED_WIN_EFFECT_DURATION,
  REDUCED_WIN_REVEAL_DURATION,
  WIN_EFFECT_DURATION,
  WIN_EFFECT_SOUND_DELAY,
  WIN_REVEAL_DURATION,
} from '../../core/presentation/winEffect'
import type { ServerSnapshot } from '../protocol/dto'

export type SettlementPresentationPayload = Pick<
  ServerSnapshot,
  'round' | 'honba' | 'result' | 'winPresentation' | 'winningPlayerIndex'
>

export type SettlementEffectPayload = Pick<
  ServerSnapshot,
  'round' | 'honba' | 'winPresentation' | 'winningPlayerIndex'
>

export interface SettlementTimelineState {
  phase: RefLike<GamePhase>
  result: RefLike<RoundResult | null>
  winEffect: RefLike<WinEffect | null>
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
  onResultMissingAfterReveal?: (round: number, honba: number) => void
}

export function createSettlementTimeline({
  state,
  mapResult,
  mapPresentation,
  toLocalSeat,
  playSound,
  reducedMotion = prefersReducedMotion,
  onResultMissingAfterReveal,
}: SettlementTimelineOptions) {
  let serial = 0
  const timers = new Set<number>()
  let activeKey: string | null = null
  let pendingResult: RoundResult | null = null
  let hasResult = false
  let revealComplete = false

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
    activeKey = null
    pendingResult = null
    hasResult = false
    revealComplete = false
  }

  function effectKey(snapshot: SettlementEffectPayload) {
    const presentation = snapshot.winPresentation
    return presentation
      ? [
          snapshot.round,
          snapshot.honba,
          snapshot.winningPlayerIndex,
          presentation.tile,
          presentation.sourceIndex,
          presentation.robbedKong ? 1 : 0,
          presentation.robbedKongPlayerIndex,
          presentation.robbedKongMeldIndex,
        ].join(':')
      : null
  }

  function settleIfReady() {
    if (!hasResult || !revealComplete) return
    state.phase.value = 'settled'
    state.result.value = pendingResult
  }

  function beginEffect(snapshot: SettlementEffectPayload, result?: RoundResult | null) {
    cancel()
    const currentSerial = serial
    const presentation = mapPresentation(snapshot.winPresentation)
    activeKey = effectKey(snapshot)
    if (arguments.length >= 2) {
      pendingResult = result ?? null
      hasResult = true
    }
    state.winningPlayerIndex.value = snapshot.winningPlayerIndex >= 0
      ? toLocalSeat(snapshot.winningPlayerIndex)
      : (result?.winnerIndex ?? -1)
    if (!presentation) return

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
    playSound(presentation.discardWin || presentation.robbedKong ? 'hu.mp3' : 'zimo.mp3')
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
        revealComplete = true
        settleIfReady()
        if (!hasResult) onResultMissingAfterReveal?.(snapshot.round, snapshot.honba)
      }, revealDuration)
    }, effectDuration)
  }

  /** 胡牌一发生就启动表现；最终分数稍后由 settled 快照/公共事实补齐。 */
  function startEffect(snapshot: SettlementEffectPayload) {
    if (!snapshot.winPresentation) return
    const key = effectKey(snapshot)
    if (key != null && key === activeKey) return
    beginEffect(snapshot)
  }

  function start(snapshot: SettlementPresentationPayload) {
    const mappedResult = mapResult(snapshot.result)
    const presentation = mapPresentation(snapshot.winPresentation)
    const isDraw = Boolean(snapshot.result?.draw) || !presentation

    if (isDraw) {
      cancel()
      // 流局直接结算并亮牌（对齐单机 endDraw），不加 600ms revealing 停顿。
      state.phase.value = 'settled'
      state.revealHands.value = true
      state.winPresentation.value = null
      state.winEffect.value = null
      state.winningPlayerIndex.value = mappedResult?.winnerIndex ?? -1
      state.result.value = mappedResult
      return
    }

    const key = effectKey(snapshot)
    if (key != null && key === activeKey) {
      // win_effect 已经让客户端与房主同步播放；settled 到达时只补最终结果，
      // 不能重播音效或把 2.6s 动画重新计时。公共事实每秒重发也走这里。
      pendingResult = mappedResult
      hasResult = true
      settleIfReady()
      return
    }

    beginEffect(snapshot, mappedResult)
  }

  return { start, startEffect, cancel }
}
