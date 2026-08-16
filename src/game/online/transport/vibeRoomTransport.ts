// VibeHub P2P 传输层：把 SDK Room 的 send/onMessage/onPeer 封装成 roomSocket 同款接口
// （{ status, signalQuality, open, confirmSession, send, close }），供 useRemoteGame 无痛替换。
//
// 与 WebSocket 的关键差异：room.onMessage/onPeer 返回 `this`（Room）而非退订函数，
// 因此 transport 在 join 完成后绑定一次，之后不复绑；SDK 自行处理断线重连与中继切换。
//
// 信号强度：不依赖 SDK 的 latency/jitter 字段（中继 relay 下常虚高，据此降档会把
// 「打牌完全正常」的对局误报成「网络不稳定」）——传输层自己发 ping、对端回 pong，
// 用真实消息往返时间（RTT）定 0-3 格；peer 的 reconnecting/open 状态仅作兜底。
import { ref } from 'vue'

export type RoomSocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface VibeRoomTransportOptions {
  /** 返回当前已加入的 SDK 房间；未加入时为 null。 */
  getRoom: () => VibeHubSDK.Room | null
  onMessage: (message: unknown) => void
  /** 信号轮询/心跳间隔（ms）。 */
  signalIntervalMs?: number
}

/** open 选项：signalOnly=true 时只收发传输层心跳（测 RTT 信号），业务消息不转发。
 * 房主用它绑定传输层测「到各客户端」的信号——房主业务消息走 onLocalSnapshot/
 * onLocalEvent，不能经 transport 转发（否则会收到自己广播的回环、重复处理）。 */
export interface VibeRoomOpenOptions {
  signalOnly?: boolean
}

/** RTT → 0-3 信号档：真实往返 <150ms 流畅、<300ms 良好、<500ms 波动、以上不稳定。 */
function scoreFromRtt(rtt: number): number {
  if (rtt < 150) return 3
  if (rtt < 300) return 2
  if (rtt < 500) return 1
  return 0
}

/** 单个对端 → 0-3 信号档（兜底）：reconnecting（直连在重连）或连接关闭 → 1 格（波动，
 * 不报断线）；正常 → 3（具体质量由应用层 RTT 决定）。彻底失联由掉线判定负责。 */
function scorePeer(peer: VibeHubSDK.PeerInfo): number {
  if (peer.reconnecting || !peer.open) return 1
  return 3
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
  // 最近一轮 ping 测得的最差 RTT（多人局取最差对端）。
  let worstRtt: number | null = null

  function clearReconnectingConfirm() {
    if (reconnectingTimer != null) {
      clearTimeout(reconnectingTimer)
      reconnectingTimer = null
    }
  }

  function recordRtt(rtt: number) {
    worstRtt = worstRtt == null ? rtt : Math.max(worstRtt, rtt)
  }

  function bind(room: VibeHubSDK.Room, signalOnly: boolean) {
    if (boundRoom === room) return
    boundRoom = room
    room.onMessage((message, fromPeerId) => {
      // 收到任何消息 → 连接可用，取消 reconnecting 确认。
      clearReconnectingConfirm()
      if (typeof message === 'object' && message !== null) {
        const m = message as { __transport_ping?: unknown; __transport_pong?: unknown }
        if (typeof m.__transport_ping === 'number') {
          // 对端心跳 → 立即原样回 pong（定向，避免广播互相收到）。
          boundRoom?.send({ __transport_pong: m.__transport_ping }, fromPeerId)
          return
        }
        if (typeof m.__transport_pong === 'number') {
          // 自己的 ping 回来了 → 真实 RTT → 立即刷新信号。
          recordRtt(Date.now() - m.__transport_pong)
          updateSignalQuality()
          return
        }
      }
      if (signalOnly) return // 房主：不转发业务消息（避免收到自己广播的回环）
      onMessage(message)
    })
    room.onPeer((event) => {
      // 只跟踪房主（hostId）的连接状态：其他玩家的掉线/抖动不应触发「网络断开，
      // 正在重连」横幅。error 事件无 id，直接忽略。
      if (event.type === 'error') return
      if (event.id !== room.hostId && event.id !== room.peerId) return
      if (event.type === 'reconnecting') {
        // 延迟 2s 确认：relay 切换/短暂抖动会在 2s 内恢复（connecting/消息），不误报。
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
    // 对端连接状态兜底（reconnecting/关闭 → 至少 1 格）。
    const peerScore = Math.min(...peers.map(scorePeer))
    // 应用层 RTT（真实往返）主导；本轮还没收到 pong 时沿用上一轮 RTT。
    const rttScore = worstRtt == null ? 3 : scoreFromRtt(worstRtt)
    signalQuality.value = Math.min(peerScore, rttScore)
  }

  function tick() {
    worstRtt = null // 重置，用本轮 pong 重新测量
    const room = boundRoom
    if (room) room.send({ __transport_ping: Date.now() })
    updateSignalQuality()
  }

  function open(options: VibeRoomOpenOptions = {}) {
    const room = getRoom()
    if (!room) return
    bind(room, options.signalOnly ?? false)
    status.value = 'connected'
    updateSignalQuality()
    // 周期发心跳 ping 并刷新信号：基于真实往返 RTT（不依赖 SDK 虚高的 latency/jitter）。
    if (signalTimer == null) {
      signalTimer = setInterval(tick, signalIntervalMs)
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
    worstRtt = null
  }

  return { status, signalQuality, open, confirmSession, send, close }
}
