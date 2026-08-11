import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { GameMode } from '../../core/contracts/activeGamePort'
import { getRoomMeta, type RoomMeta } from '../api/roomApi'

export function useRoomAvailability(gameMode: Ref<GameMode>, roomId: Ref<string>) {
  const roomMeta = ref<RoomMeta | null>(null)
  let pollingTimer: number | null = null

  async function refresh() {
    try {
      roomMeta.value = await getRoomMeta()
    } catch {
      // 网络抖动时保留上一次容量，大厅不因辅助查询失败而报错。
    }
  }

  function stopPolling() {
    if (pollingTimer == null) return
    window.clearInterval(pollingTimer)
    pollingTimer = null
  }

  watch([gameMode, roomId], ([mode, id]) => {
    if (mode === 'remote' && !id) {
      void refresh()
      if (pollingTimer == null) pollingTimer = window.setInterval(refresh, 5000)
    } else {
      stopPolling()
    }
  }, { immediate: true })

  onUnmounted(stopPolling)

  return { roomMeta, refresh }
}
