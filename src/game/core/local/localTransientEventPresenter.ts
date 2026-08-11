import type { ScoreDelta, TableActionType, TileType } from '../contracts/types'
import type { LocalGameState } from './localGameState'

interface LocalTransientEventPresenterOptions {
  state: LocalGameState
  later(callback: () => void, delay: number): number
}

export function createLocalTransientEventPresenter(options: LocalTransientEventPresenterOptions) {
  const { state } = options

  function announce(text: string, tone = 'gold') {
    state.announcement.value = { text, tone, id: Date.now() }
    options.later(() => {
      if (state.announcement.value?.text === text) state.announcement.value = null
    }, 1500)
  }

  function showTableAction(
    type: TableActionType,
    actorIndex: number,
    sourceIndex: number | null,
    tile: TileType,
    meldIndex: number,
  ) {
    const event = { id: Date.now(), type, actorIndex, sourceIndex, tile, meldIndex }
    state.tableActionEvent.value = event
    options.later(() => {
      if (state.tableActionEvent.value?.id === event.id) state.tableActionEvent.value = null
    }, 1050)
  }

  function showScoreFlow(deltas: ScoreDelta[]) {
    if (!deltas.length) return
    const event = { id: Date.now(), deltas }
    state.scoreFlowEvent.value = event
    options.later(() => {
      if (state.scoreFlowEvent.value?.id === event.id) state.scoreFlowEvent.value = null
    }, 1050)
  }

  return { announce, showTableAction, showScoreFlow }
}
