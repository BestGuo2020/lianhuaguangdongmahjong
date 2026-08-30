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
import { resolveAnimeAudioPolicy } from '../../core/presentation/animeAudioPolicy'
import type { AnimeFixedTtsExecutor, AnimeRoundWinType } from '../../llm/animeFixedTtsExecutor'

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
  getThemeName?: () => string
  getCharacterIds?: () => readonly unknown[]
  animeFixedTts?: AnimeFixedTtsExecutor
}

export function createSettlementTimeline({
  state,
  mapResult,
  mapPresentation,
  toLocalSeat,
  playSound,
  reducedMotion = prefersReducedMotion,
  getThemeName = () => 'jade',
  getCharacterIds = () => [],
  animeFixedTts,
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

  function queueFixedRound(snapshot: ServerSnapshot, mappedResult: RoundResult | null) {
    if (!animeFixedTts) return
    const policy = resolveAnimeAudioPolicy({ themeName: getThemeName(), playerKind: 'unknown' })
    if (policy.resultVoice !== 'fixed-line') return
    const rawWinType = mappedResult?.winType
    const winType: AnimeRoundWinType = rawWinType === 'discard' || rawWinType === 'dihu'
      ? 'discard'
      : rawWinType === 'robbed-kong' ? 'robbed-kong' : 'self-draw'
    const draw = Boolean(mappedResult?.draw)
    const winnerIndex = draw ? null : (mappedResult?.winnerIndex ?? null)
    const eventId = mappedResult?.presentationKey ?? [
      'remote-round', snapshot.roomId, snapshot.round, snapshot.honba,
      draw ? 'draw' : winnerIndex, rawWinType ?? '',
    ].join(':')
    return animeFixedTts.executeRound({
      eventId,
      characterIds: getCharacterIds(),
      winnerIndex,
      winType,
      draw,
    }).then(() => undefined, () => undefined)
  }

  function finishSettlementAfterSpeech(
    snapshot: ServerSnapshot,
    mappedResult: RoundResult | null,
    currentSerial: number,
  ) {
    const speech = queueFixedRound(snapshot, mappedResult)
    const finish = () => {
      if (serial !== currentSerial) return
      state.phase.value = 'settled'
      state.result.value = mappedResult
    }
    if (speech) void speech.then(finish, finish)
    else finish()
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
      // 流局立即亮牌；二次元主题等待四家固定发言后再打开结算窗口。
      state.phase.value = 'revealing'
      state.revealHands.value = true
      state.winPresentation.value = null
      state.winEffect.value = null
      state.result.value = null
      finishSettlementAfterSpeech(snapshot, mappedResult, currentSerial)
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
    const llmWinner = snapshot.players.find(
      (player) => player.seat === snapshot.winningPlayerIndex,
    )?.isLlm === true
    const winner = snapshot.players.find((player) => player.seat === snapshot.winningPlayerIndex)
    const actionPolicy = resolveAnimeAudioPolicy({
      themeName: getThemeName(),
      playerKind: winner?.playerKind,
      isLlm: winner?.isLlm,
    })
    if (!llmWinner && actionPolicy.actionVoice === 'legacy') {
      playSound(presentation.discardWin || presentation.robbedKong ? 'hu.mp3' : 'zimo.mp3')
    }
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
        finishSettlementAfterSpeech(snapshot, mappedResult, currentSerial)
      }, revealDuration)
    }, effectDuration)
  }

  return { start, cancel }
}
