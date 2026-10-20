import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TableActionEvent } from '../contracts/types'
import { createKongWeatherTimeline, kongWeatherKind, kongWeatherSound } from './kongWeather'

const action = (type: TableActionEvent['type'], id = 1): TableActionEvent => ({
  id, type, actorIndex: 0, meldIndex: 0, sourceIndex: null, tile: 'm1',
})
const player = (pending = false): GamePlayer => ({
  seat: 3, name: '玩家', avatar: '', score: 2000, hand: [], discards: [], redCount: 0, drawnTileIndex: -1,
  melds: [{ type: 'gang', added: true, pending, tile: 'm1', tiles: ['m1', 'm1', 'm1', 'm1'] }],
})

describe('kong weather event adapter', () => {
  it.each(['discard-gang', 'added-gang'] as const)('%s uses wind and the supplied windy audio', type => {
    expect(kongWeatherKind(type)).toBe('tornado')
    expect(kongWeatherSound(kongWeatherKind(type)!)).toBe('sounds/mingang_windy.wav')
  })
  it('concealed kongs use rain; unrelated actions have no weather', () => {
    expect(kongWeatherKind('concealed-gang')).toBe('rain')
    expect(kongWeatherKind('wind-kong')).toBe('rain')
    expect(kongWeatherSound('rain')).toBe('sounds/angang_rainy.wav')
    for (const type of ['peng', 'chi', 'flower-gang', 'self-draw', 'robbed-kong-win'] as const) expect(kongWeatherKind(type)).toBeNull()
  })
  it('plays once per action, rotates using the absolute seat, and outlives transient text', () => {
    const sound = vi.fn(), timeline = createKongWeatherTimeline(sound)
    const event = action('discard-gang')
    const cues = timeline.sync(event, [player()], 100, false)
    expect(cues).toEqual([{ id: 1, seat: 3, kind: 'tornado', startedAt: 100, duration: 2200, reducedMotion: false }])
    timeline.sync({ ...event }, [player()], 200, false)
    expect(timeline.sync(null, [player()], 1800, false)).toEqual(cues)
    expect(sound).toHaveBeenCalledOnce()
    expect(timeline.sync(event, [player()], 2300, false)).toEqual([])
    expect(sound).toHaveBeenCalledOnce()
  })
  it('waits for added-kong settlement even after its table text disappears', () => {
    const sound = vi.fn(), timeline = createKongWeatherTimeline(sound), p = player(true)
    expect(timeline.sync(action('added-gang'), [p], 100, false)).toEqual([])
    expect(timeline.sync(null, [p], 2200, false)).toEqual([])
    expect(sound).not.toHaveBeenCalled()
    p.melds[0].pending = false
    expect(timeline.sync(null, [p], 3000, false)[0]).toMatchObject({ kind: 'tornado', startedAt: 3000 })
    expect(sound).toHaveBeenCalledOnce()
  })
  it('does not celebrate a robbed added kong', () => {
    const sound = vi.fn(), timeline = createKongWeatherTimeline(sound), p = player(true)
    timeline.sync(action('added-gang'), [p], 100, false)
    p.melds = [{ type: 'peng', tile: 'm1', tiles: ['m1', 'm1', 'm1'] }]
    expect(timeline.sync(action('robbed-kong-win', 2), [p], 300, false)).toEqual([])
    expect(sound).not.toHaveBeenCalled()
  })
  it('waits for the matching online meld when the action arrives before its snapshot', () => {
    const sound = vi.fn(), timeline = createKongWeatherTimeline(sound), p = player()
    p.melds = [{ type: 'peng', tile: 'm1', tiles: ['m1', 'm1', 'm1'] }]
    expect(timeline.sync(action('added-gang'), [p], 100, false)).toEqual([])
    p.melds = player().melds
    expect(timeline.sync(null, [p], 200, false)[0]).toMatchObject({ kind: 'tornado', startedAt: 200 })
    expect(sound).toHaveBeenCalledOnce()
  })
  it('accepts completed blood-flow ledger cues without requiring an exposed hand snapshot', () => {
    const sound = vi.fn(), timeline = createKongWeatherTimeline(sound)
    const p = { ...player(), melds: [] }
    expect(timeline.sync(action('added-gang'), [p], 100, false, true)[0].kind).toBe('tornado')
    timeline.sync(action('added-gang'), [p], 300, false, true)
    expect(sound).toHaveBeenCalledOnce()
  })
  it('clears old-round effects and deduplication; reduced motion uses a shorter cue', () => {
    const sound = vi.fn(), timeline = createKongWeatherTimeline(sound)
    timeline.sync(action('concealed-gang'), [player()], 100, false)
    timeline.reset()
    expect(timeline.sync(null, [player()], 200, false)).toEqual([])
    expect(timeline.sync(action('concealed-gang'), [player()], 300, true)[0]).toMatchObject({ duration: 600, reducedMotion: true })
    expect(sound).toHaveBeenCalledTimes(2)
  })
})
