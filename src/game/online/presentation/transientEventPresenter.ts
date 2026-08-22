import type { RemoteGameState } from '../state/remoteGameState'
import type { ServerMessage } from '../protocol/messages'
import {
  mapScoreDeltasToLocal,
  mapTableActionToLocal,
} from '../protocol/mapper'

type TransientState = Pick<RemoteGameState,
  'players' | 'announcement' | 'tableActionEvent' | 'scoreFlowEvent'
>
type TableActionMessage = Extract<ServerMessage, { kind: 'table_action' }>
type ScoreFlowMessage = Extract<ServerMessage, { kind: 'score_flow' }>
type AnnouncementMessage = Extract<ServerMessage, { kind: 'announcement' }>

export interface TransientEventPresenterOptions {
  state: TransientState
  getLocalSeat(): number
  isOpening(): boolean
  showServerAnnouncement(message: AnnouncementMessage): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): void
}

const ACTION_SOUNDS: Partial<Record<TableActionMessage['event']['type'], string>> = {
  peng: 'peng.mp3',
  chi: 'chi.mp3',
  'discard-gang': 'gang.mp3',
  'concealed-gang': 'gang.mp3',
  'added-gang': 'gang.mp3',
  'flower-gang': 'gang.mp3',
}

export function createTransientEventPresenter({
  state,
  getLocalSeat,
  isOpening,
  showServerAnnouncement,
  playSound,
  later,
}: TransientEventPresenterOptions) {
  function announce(text: string, tone = 'gold') {
    const current = { text, tone, id: Date.now() }
    state.announcement.value = current
    later(() => {
      if (state.announcement.value?.id === current.id && state.announcement.value.text === current.text) {
        state.announcement.value = null
      }
    }, 1500)
  }

  function handleAnnouncement(message: AnnouncementMessage) {
    showServerAnnouncement(message)
  }

  function handleTableAction(message: TableActionMessage) {
    if (isOpening()) return
    const event = mapTableActionToLocal(message.event, getLocalSeat())
    state.tableActionEvent.value = event
    later(() => {
      if (state.tableActionEvent.value?.id === event.id) state.tableActionEvent.value = null
    }, 1050)

    // 胡牌声音由结算时间线统一播放，避免 table_action 与 settled 快照双响。
    if (event.type === 'self-draw' || event.type === 'robbed-kong-win') return
    // 大模型座位只播放后端吐槽 TTS，不与吃碰杠原始人声叠加。
    if (state.players[event.actorIndex]?.isLlm) return
    const sound = ACTION_SOUNDS[event.type]
    if (sound) playSound(sound)
  }

  function handleScoreFlow(message: ScoreFlowMessage) {
    if (!message.deltas.length) return
    const event = {
      id: Date.now(),
      deltas: mapScoreDeltasToLocal(message.deltas, getLocalSeat()),
    }
    state.scoreFlowEvent.value = event
    later(() => {
      if (state.scoreFlowEvent.value?.id === event.id) state.scoreFlowEvent.value = null
    }, 1050)
  }

  function clear() {
    state.announcement.value = null
    state.tableActionEvent.value = null
    state.scoreFlowEvent.value = null
  }

  return { announce, handleAnnouncement, handleTableAction, handleScoreFlow, clear }
}
