import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { GameMode } from '../../core/contracts/activeGamePort'
import { preloadImages } from '../../core/presentation/imagePreload'
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

  // 服务端提供的 LLM 人设头像（img/llm/<供应商>/llm-avatar-<风格>.png）随房间元数据预热：
  // 房主建房/开局后的空位大模型座位会用到它们，避免牌桌首次渲染才开始下载。
  watch(() => (roomMeta.value?.llmProviders ?? []).map((provider) => provider.avatar),
    (avatars) => { void preloadImages(avatars) }, { immediate: true })

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
