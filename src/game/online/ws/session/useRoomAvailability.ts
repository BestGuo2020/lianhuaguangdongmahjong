import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { GameMode } from '../../../core/contracts/activeGamePort'
import type { RuleVariant } from '../../../core/rules/ruleVariants'
import { materializeImages } from '../../../core/presentation/imagePreload'
import { getRoomMeta, type RoomMeta } from '../api/roomApi'

export function useRoomAvailability(gameMode: Ref<GameMode>, roomId: Ref<string>, selectedRule: Ref<RuleVariant>) {
  const roomMeta = ref<RoomMeta | null>(null)
  let pollingTimer: number | null = null
  let requestId = 0

  async function refresh() {
    const id = ++requestId
    const rulesetId = selectedRule.value
    try {
      const meta = await getRoomMeta(rulesetId)
      // 切换玩法或退出联机后，旧请求即使晚到也不能覆盖当前玩法的容量。
      if (id === requestId && gameMode.value === 'remote' && selectedRule.value === rulesetId) {
        roomMeta.value = meta
      }
    } catch {
      // 网络抖动时保留上一次容量，大厅不因辅助查询失败而报错。
    }
  }

  function stopPolling() {
    if (pollingTimer == null) return
    window.clearInterval(pollingTimer)
    pollingTimer = null
  }

  // 服务端提供的 LLM 人设头像（img/llm/<供应商>/llm-avatar-<风格>.png）随房间元数据物化：
  // 房主建房/开局后的空位大模型座位会用到它们；只进 HTTP 缓存的话，托管方 60s 新鲜期一过
  // 座位头像首次渲染仍要发一次 304 校验（实测单次 0.5~1.9s），所以这里也走 blob + 预热解码。
  watch(() => (roomMeta.value?.llmProviders ?? []).map((provider) => provider.avatar),
    (avatars) => { void materializeImages(avatars) }, { immediate: true })

  watch([gameMode, roomId, selectedRule], ([mode, , rulesetId], [, , previousRulesetId]) => {
    if (rulesetId !== previousRulesetId) roomMeta.value = null
    // 房间面板同样需要提供商列表：刷新或重进房间时，不能只依赖进入大厅时的旧元数据。
    if (mode === 'remote') {
      void refresh()
      if (pollingTimer == null) pollingTimer = window.setInterval(refresh, 5000)
    } else {
      requestId += 1
      stopPolling()
    }
  }, { immediate: true })

  onUnmounted(() => {
    requestId += 1
    stopPolling()
  })

  return { roomMeta, refresh }
}
