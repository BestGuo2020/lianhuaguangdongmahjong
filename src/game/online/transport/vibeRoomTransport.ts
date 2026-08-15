// VibeHub P2P 传输层：把 SDK Room 的 send/onMessage/onPeer 封装成 roomSocket 同款接口
// （{ status, signalQuality, open, confirmSession, send, close }），供 useRemoteGame 无痛替换。
//
// 与 WebSocket 的关键差异：room.onMessage/onPeer 返回 `this`（Room）而非退订函数，
// 因此 transport 在 join 完成后绑定一次，之后不复绑；SDK 自行处理断线重连与中继切换。
import { ref } from 'vue'

export type RoomSocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface VibeRoomTransportOptions {
  /** 返回当前已加入的 SDK 房间；未加入时为 null。 */
  getRoom: () => VibeHubSDK.Room | null
  onMessage: (message: unknown) => void
}

export function createVibeRoomTransport({ getRoom, onMessage }: VibeRoomTransportOptions) {
  const status = ref<RoomSocketStatus>('idle')
  const signalQuality = ref(0)
  let boundRoom: VibeHubSDK.Room | null = null

  function bind(room: VibeHubSDK.Room) {
    if (boundRoom === room) return
    boundRoom = room
    room.onMessage((message, _fromPeerId) => onMessage(message))
    room.onPeer((event) => {
      if (event.type === 'reconnecting') {
        status.value = 'reconnecting'
      } else if (event.type === 'join' || event.type === 'connecting') {
        status.value = 'connected'
      }
    })
  }

  function open() {
    const room = getRoom()
    if (!room) return
    bind(room)
    status.value = 'connected'
    // SDK 内部自适应直连/中继/TURN，业务侧按「已连接」取满格信号；后续可用 networkStats 细化。
    signalQuality.value = 3
  }

  function confirmSession() {
    // SDK 自动重连，无需像 WebSocket 那样显式重置重连计数；占位对齐 roomSocket 接口。
  }

  function send(message: Record<string, unknown>): boolean {
    const room = getRoom()
    if (!room) return false
    room.send(message)
    return true
  }

  function close() {
    // 不调用 room.leave()：离开房间由 vibeRoomSession.clearSession() 统一负责，
    // 避免重复 leave 在 SDK 仍协商 relay 时关闭连接、触发 setRemoteDescription 竞态。
    boundRoom = null
    status.value = 'idle'
    signalQuality.value = 0
  }

  return { status, signalQuality, open, confirmSession, send, close }
}
