import type { GamePlayer, TableActionEvent } from '../../../core/contracts/types'
import { resolveAnimeAudioPolicy } from '../../../core/presentation/animeAudioPolicy'
import { animeFallbackAudioForAction, type AnimeFixedTtsExecutor, type AnimeSeat } from '../../../llm/animeFixedTtsExecutor'

/** Only the existing action-voice routes. Visual effects have no reference to this bridge. */
export function createBloodFlowAudioBridge(options: {
  epoch(): string
  theme(): string
  player(index: number): Pick<GamePlayer, 'characterId'> | undefined
  fixed?: AnimeFixedTtsExecutor
  play(name: string): unknown
}) {
  const seen = new Set<string>()
  return {
    present(event: TableActionEvent): void {
      const epoch = options.epoch(), theme = options.theme(), id = `${epoch}:${event.id}`
      if (seen.has(id)) return
      seen.add(id)
      const route = resolveAnimeAudioPolicy({ themeName: theme, playerKind: 'unknown' })
      if (route.actionVoice === 'fixed-line' && options.fixed) {
        void options.fixed.executeAction({ eventId: id, seat: event.actorIndex as AnimeSeat,
          characterId: options.player(event.actorIndex)?.characterId, action: event.type }).then(result => {
          if (epoch === options.epoch() && theme === options.theme() && result.fallbackAudioFile) options.play(result.fallbackAudioFile)
        }).catch(() => {})
      } else {
        const file = animeFallbackAudioForAction(event.type)
        if (file) options.play(file)
      }
    },
    reset() { seen.clear(); options.fixed?.cancel() },
  }
}
