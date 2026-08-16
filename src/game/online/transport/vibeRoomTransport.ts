// VibeHub P2P 传输层：把 SDK Room 的 send/onMessage/onPeer 封装成 roomSocket 同款接口
// （{ status, signalQuality, open, confirmSession, send, close }），供 useRemoteGame 无痛替换。
//
// 与 WebSocket 的关键差异：room.onMessage/onPeer 返回 `this`（Room）而非退订函数，
// 因此 transport 在 join 完成后绑定一次，之后不复绑；SDK 自行处理断线重连与中继切换。
//
// 信号强度：SDK 不提供统一「信号格」概念，这里用 room.peers() 的每对端
// latency / jitter / relay / reconnecting 估算 0-3 档，取最差对端作为整体信号
// （对局质量取决于最差的一路连接）。
import { ref } from 'vue'

export type RoomSocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface VibeRoomTransportOptions {
  /** 返回当前已加入的 SDK 房间；未加入时为 null。 */
  getRoom: () => VibeHubSDK.Room | null
  onMessage: (message: unknown) => void
  /** 信号轮询间隔（ms）。 */
  signalIntervalMs?: number
}

/** 单个对端 → 0-3 信号档：延迟/抖动主导；relay 中继是 SDK 的正常传输模式
 * （打牌完全正常），不因 relay 本身降档——否则房主对走中继的客户端会长期误显示
 * 「网络不稳定」。reconnecting（直连 P2P 在重连）给 1 格：relay 通道通常仍可用。
 * 彻底失联由掉线判定（25s/30s 无消息）负责，不由信号格表达。 */
function scorePeer(peer: VibeHubSDK.PeerInfo): number {
  if (peer.reconnecting) return 1
  let score = 3
  if (peer.latency > 300) score = Math.max(0, score - 1)
  else if (peer.latency > 150) score = Math.max(1, score - 1)
  if (peer.jitter > 100) score = Math.max(0, score - 1)
  return score
}

export function createVibeRoomTransport({ getRoom, onMessage, signalIntervalMs = 3000 }: VibeRoomTransportOptions) {
  const status = ref<RoomSocketStatus>('idle')
  const signalQuality = ref(0)
  let boundRoom: VibeHubSDK.Room | null = null
  let signalTimer: ReturnType<typeof setInterval> | null = null
  // reconnecting 延迟确认：SDK 在直连失败自动切换 relay 时也会报 reconnecting
  // （连接其实还在，只是换传输路径）——延迟确认，期间恢复（connecting/join/收到消息）
  // 就不显示「网络断开，正在重连」横幅，避免误报。
  let reconnectingTimer: ReturnType<typeof setTimeout> | null = null

  function clearReconnectingConfirm() {
    if (reconnectingTimer != null) {
      clearTimeout(reconnectingTimer)
      reconnectingTimer = null
    }
  }

  function bind(room: VibeHubSDK.Room) {
    if (boundRoom === room) return
    boundRoom = room
    room.onMessage((message, _fromPeerId) => {
      // 收到任何业务消息 → 连接可用，取消 reconnecting 确认。
      clearReconnectingConfirm()
      onMessage(message)
    })
    room.onPeer((event) => {
      // 只跟踪房主（hostId）的连接状态：其他玩家的掉线/抖动不应触发「网络断开，
      // 正在重连」横幅。error 事件无 id，直接忽略。
      if (event.type === 'error') return
      if (event.id !== room.hostId && event.id !== room.peerId) return
      if (event.type === 'reconnecting') {
        // 延迟 2s 确认：relay 切换/短暂抖动会在 2s 内恢复（connecting/消息），不误报。
        // 信号格不在此归 0：直连在重连但 relay 可用（对局照常），由轮询 peers() 估算。
        if (reconnectingTimer == null) {
          reconnectingTimer = setTimeout(() => {
            reconnectingTimer = null
            if (boundRoom == null) return
            status.value = 'reconnecting'
          }, 2000)
        }
      } else if (event.type === 'join' || event.type === 'connecting') {
        clearReconnectingConfirm()
        status.value = 'connected'
        updateSignalQuality()
      }
    })
  }

  function updateSignalQuality() {
    const room = boundRoom
    if (!room) {
      signalQuality.value = 0
      return
    }
    const peers = room.peers()
    // 无对端（大厅空房/刚建房还没人）：没有可测连接，按默认良好显示，避免误报「网络不稳定」。
    if (peers.length === 0) {
      signalQuality.value = 3
      return
    }
    signalQuality.value = Math.min(...peers.map(scorePeer))
  }

  function open() {
    const room = getRoom()
    if (!room) return
    bind(room)
    status.value = 'connected'
    updateSignalQuality()
    // 周期轮询 peers()：SDK 的直连/中继切换、延迟抖动会实时反映到信号格。
    if (signalTimer == null) {
      signalTimer = setInterval(updateSignalQuality, signalIntervalMs)
    }
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
    if (signalTimer != null) {
      clearInterval(signalTimer)
      signalTimer = null
    }
    clearReconnectingConfirm()
    boundRoom = null
    status.value = 'idle'
    signalQuality.value = 0
  }

  return { status, signalQuality, open, confirmSession, send, close }
}
