import { watch, type Ref } from 'vue'
import type { GamePhase } from '../../../core/contracts/gamePort'
import { RemoteApiError } from '../api/httpClient'
import type { RoomInfo } from '../api/roomApi'

export type RoomPanelStatus = RoomInfo['status'] | 'unavailable' | 'auth-required'

interface RoomPanelSyncOptions {
  roomId: Ref<string>
  phase: Ref<GamePhase>
  roomStatus: Ref<RoomPanelStatus>
  getRoom(roomId: string): Promise<RoomInfo>
  applyRoom(info: RoomInfo): void
  stopPolling(): void
  onRoomGone(): void
}

export function createRoomPanelRefresh({
  roomId, phase, roomStatus, getRoom, applyRoom, stopPolling, onRoomGone,
}: RoomPanelSyncOptions) {
  let requested = 0
  let applied = 0

  // 换房、开局或回到大厅时，在途请求属于上一段流程。
  watch([roomId, () => phase.value === 'lobby'], () => { applied = requested }, { flush: 'sync' })

  return async function refreshRoom() {
    if (!roomId.value || phase.value !== 'lobby') return
    const request = ++requested
    let info: RoomInfo
    try {
      info = await getRoom(roomId.value)
    } catch (error) {
      if (request <= applied) return
      applied = request
      if (error instanceof RemoteApiError && error.code === 'ROOM_NOT_FOUND') {
        stopPolling()
        onRoomGone()
        return
      }
      if (error instanceof RemoteApiError && error.status === 401) {
        applied = requested
        roomStatus.value = 'auth-required'
        stopPolling()
        return
      }
      roomStatus.value = 'unavailable'
      return
    }

    if (request <= applied) return
    applied = request
    // 终局标记可能先于房间状态更新。旧服务端只返回 status 时仍可正常工作。
    roomStatus.value = info.status === 'playing' && info.matchFinished === true ? 'finished' : info.status
    applyRoom(info)
  }
}
