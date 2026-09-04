import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TileType } from '../../../core/contracts/types'
import { createLocalSettlementTimeline } from '../../../core/local/localSettlementTimeline'
import { resolveAnimeAudioPolicy } from '../../../core/presentation/animeAudioPolicy'
import { createLotusSettlement } from '../lotusSettlement'
import { createLotusGameState } from '../lotusState'

const themes = ['jade', 'rosewood', 'happyMahjong', 'llm', 'llmAnime'] as const
const kinds = ['human', 'bot', 'llm'] as const
const modes = ['lotus-classic', 'lotus-legacy'] as const
const sources = ['self-draw', 'discard', 'robbed-kong'] as const
const matrix = modes.flatMap(mode => themes.flatMap(theme => kinds.flatMap(kind => sources
  // Classic local play does not offer ordinary discard wins; do not invent a baseline.
  .filter(source => mode !== 'lotus-classic' || source !== 'discard')
  .map(source => ({ mode, theme, kind, source })),
)))

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('E00 old-mode settlement sound boundary (before engine audio routing)', () => {
  it.each(matrix)('$mode / $theme / $kind / $source', async ({ mode, theme, kind, source }) => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      matchMedia: () => ({ matches: false }),
    })
    const state = createLotusGameState()
    state.phase.value = 'thinking'
    const hand: TileType[] = ['m1', 'm2', 'm3', 'p2', 'p3', 'p4', 's4', 's5', 's6', 'm6', 'm7', 'm8', 'east']
    state.players.push(...Array.from({ length: 4 }, (_, seat): GamePlayer => ({
      name: `P${seat}`, avatar: '', score: 2000, seat,
      playerKind: kind, hand: seat === 0 ? [...hand, ...(source === 'self-draw' ? ['east' as const] : [])] : [],
      discards: seat === 1 && source === 'discard' ? ['east'] : [],
      melds: [], redCount: 0, drawnTileIndex: source === 'self-draw' ? 13 : -1,
    })))
    const playSound = vi.fn()
    const showTableAction = vi.fn()
    const options = {
      state, clearTimers: vi.fn(),
      later: (callback: () => void, delay: number) => setTimeout(callback, delay) as unknown as number,
      playSound, showTableAction,
      structuralMeldCount: () => 0, getRoundLabel: () => '东一局',
      isLlmVoiceSeat: () => kind === 'llm',
      announceLlmRoundReactions: vi.fn(), getThemeName: () => theme,
    }
    const endOptions = {
      selfDraw: source === 'self-draw',
      winTile: 'east' as const,
      sourceFrom: source === 'discard' ? 1 : undefined,
      robbedKong: source === 'robbed-kong',
      robbedKongPlayerIndex: source === 'robbed-kong' ? 1 : undefined,
    }
    const settlement = mode === 'lotus-legacy'
      ? createLotusSettlement(options) : createLocalSettlementTimeline(options)
    settlement.endGame(0, endOptions)
    await vi.runAllTimersAsync()
    expect(state.phase.value).toBe('settled')
    expect(showTableAction).toHaveBeenCalledTimes(1)
    expect(showTableAction.mock.calls[0][0]).toBe(source === 'discard' ? 'discard-win' : source === 'robbed-kong' ? 'robbed-kong-win' : 'self-draw')
    const sound = source === 'self-draw' ? 'zimo.mp3' : 'hu.mp3'
    // Lotus suppresses anime legacy voices in lotusGame's existing outer wrapper;
    // this test intentionally measures the settlement boundary before that wrapper.
    const suppressed = kind === 'llm' || (mode === 'lotus-classic' && theme === 'llmAnime')
    expect(playSound.mock.calls.filter(([name]) => name === sound)).toHaveLength(suppressed ? 0 : 1)
    expect(resolveAnimeAudioPolicy({ themeName: theme, playerKind: kind }).actionVoice)
      .toBe(theme === 'llmAnime' ? 'fixed-line' : 'legacy')
  })
})
