import type { GamePlayer, TableActionEvent, TableActionType } from '../contracts/types'

export const KONG_WEATHER_DURATION = 2200
export const REDUCED_KONG_WEATHER_DURATION = 600

export interface KongWeatherCue {
  id: number
  /** Absolute seat, matching the reused renderer's local-seat rotation. */
  seat: number
  kind: 'tornado' | 'rain'
  startedAt: number
  duration: number
  reducedMotion: boolean
}

export function kongWeatherKind(type: TableActionType): KongWeatherCue['kind'] | null {
  if (type === 'discard-gang' || type === 'added-gang') return 'tornado'
  // The four-wind kong is also a concealed kong under the existing rules.
  if (type === 'concealed-gang' || type === 'wind-kong') return 'rain'
  return null
}

export function kongWeatherSound(kind: KongWeatherCue['kind']) {
  return kind === 'rain' ? 'sounds/angang_rainy.wav' : 'sounds/mingang_windy.wav'
}

/** Adapt transient table actions without changing the rules or either online transport. */
export function createKongWeatherTimeline(onCue: (cue: KongWeatherCue) => void) {
  const seen = new Set<number>()
  let pending: TableActionEvent | null = null
  let cues: KongWeatherCue[] = []

  function sync(event: TableActionEvent | null, players: readonly GamePlayer[], now: number, reducedMotion: boolean, completedKong = false) {
    cues = cues.filter(cue => now < cue.startedAt + cue.duration)
    if (event && !seen.has(event.id)) {
      seen.add(event.id)
      if (event.type === 'robbed-kong-win') pending = null
      if (kongWeatherKind(event.type)) pending = { ...event }
    }
    if (!pending) return cues
    const player = players[pending.actorIndex]
    const meld = player?.melds[pending.meldIndex]
    // An added-kong declaration precedes the rob-kong window. Keep it until
    // settlement, even if the short-lived table-action text has already cleared.
    if (!completedKong && pending.type === 'added-gang' && meld?.pending) return cues
    // Online table_action can arrive before the matching meld snapshot.
    if (!completedKong && pending.type === 'added-gang'
      && (!meld || meld.type !== 'gang' || !meld.added || meld.tile !== pending.tile)) return cues
    if (player) {
      const cue: KongWeatherCue = { id: pending.id, seat: player.seat,
        kind: kongWeatherKind(pending.type)!, startedAt: now, reducedMotion,
        duration: reducedMotion ? REDUCED_KONG_WEATHER_DURATION : KONG_WEATHER_DURATION }
      cues = [...cues, cue].slice(-4)
      onCue(cue)
    }
    pending = null
    return cues
  }

  function reset() { seen.clear(); pending = null; cues = [] }
  return { sync, reset }
}
