import { ref } from 'vue'

export type RoomSocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface SocketLike {
  readyState: number
  onopen: ((event?: unknown) => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: ((event?: unknown) => void) | null
  onerror: ((event?: unknown) => void) | null
  send(data: string): void
  close(): void
}

export interface RoomSocketTransportOptions {
  getUrl: () => string | null
  onMessage: (message: unknown) => void
  socketFactory?: (url: string) => SocketLike
  pingInterval?: number
  stallTimeout?: number
  stallCheckInterval?: number
}

const OPEN = 1
const RTT_EWMA_ALPHA = 0.3

export function createRoomSocketTransport({
  getUrl,
  onMessage,
  socketFactory = (url) => new WebSocket(url),
  pingInterval = 5000,
  stallTimeout = 15000,
  stallCheckInterval = 2000,
}: RoomSocketTransportOptions) {
  const status = ref<RoomSocketStatus>('idle')
  const signalQuality = ref(0)
  let socket: SocketLike | null = null
  let intentionallyClosed = true
  let reconnectTimer: number | null = null
  let reconnectAttempts = 0
  let pingTimer: number | null = null
  let stallTimer: number | null = null
  let lastPingAt = 0
  let lastServerMessageAt = 0
  let smoothedRtt = 200
  let postReconnectPongs = 2

  function stopPing() {
    globalThis.clearInterval(pingTimer as number)
    pingTimer = null
  }

  function stopStallCheck() {
    globalThis.clearInterval(stallTimer as number)
    stallTimer = null
  }

  function updateSignal() {
    if (!socket || socket.readyState !== OPEN) {
      signalQuality.value = 0
      return
    }
    const sinceMessage = Date.now() - lastServerMessageAt
    const stallGrade = sinceMessage > pingInterval * 2 ? 0
      : sinceMessage > pingInterval * 1.5 ? 1 : 3
    const rttGrade = smoothedRtt <= 200 ? 3 : smoothedRtt <= 500 ? 2 : smoothedRtt <= 1000 ? 1 : 0
    const reconnectCap = postReconnectPongs >= 2 ? 3 : 1
    signalQuality.value = Math.max(0, Math.min(rttGrade, stallGrade, reconnectCap))
  }

  function startPing() {
    stopPing()
    pingTimer = globalThis.setInterval(() => {
      if (socket?.readyState !== OPEN) return
      lastPingAt = Date.now()
      socket.send(JSON.stringify({ type: 'ping', t: lastPingAt }))
    }, pingInterval) as unknown as number
  }

  function startStallCheck() {
    stopStallCheck()
    stallTimer = globalThis.setInterval(() => {
      if (!socket || socket.readyState !== OPEN) return
      if (Date.now() - lastServerMessageAt > stallTimeout) {
        signalQuality.value = 0
        socket.close()
        return
      }
      updateSignal()
    }, stallCheckInterval) as unknown as number
  }

  function handleIncoming(raw: string) {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    lastServerMessageAt = Date.now()
    if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'pong') {
      if (lastPingAt) {
        const rtt = Date.now() - lastPingAt
        smoothedRtt = smoothedRtt > 0
          ? smoothedRtt * (1 - RTT_EWMA_ALPHA) + rtt * RTT_EWMA_ALPHA
          : rtt
        postReconnectPongs += 1
      }
      updateSignal()
    }
    onMessage(message)
  }

  function scheduleReconnect() {
    if (intentionallyClosed || !getUrl() || reconnectTimer != null) return
    status.value = 'reconnecting'
    signalQuality.value = 0
    postReconnectPongs = 0
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 8000)
    reconnectAttempts += 1
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay) as unknown as number
  }

  function connect() {
    const url = getUrl()
    if (!url || intentionallyClosed) return
    status.value = 'connecting'
    let nextSocket: SocketLike
    try {
      nextSocket = socketFactory(url)
    } catch {
      scheduleReconnect()
      return
    }
    socket = nextSocket
    nextSocket.onopen = () => {
      status.value = 'connected'
      lastServerMessageAt = Date.now()
      startPing()
      startStallCheck()
    }
    nextSocket.onmessage = (event) => handleIncoming(event.data)
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = null
      status.value = 'closed'
      signalQuality.value = 0
      stopPing()
      stopStallCheck()
      scheduleReconnect()
    }
    nextSocket.onerror = () => {
      // 浏览器随后会触发 close，统一由 onclose 发起重连。
    }
  }

  function open() {
    intentionallyClosed = false
    if (socket?.readyState === OPEN) return
    connect()
  }

  function confirmSession() {
    reconnectAttempts = 0
  }

  function send(message: Record<string, unknown>): boolean {
    if (!socket || socket.readyState !== OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  function close() {
    intentionallyClosed = true
    globalThis.clearTimeout(reconnectTimer as number)
    reconnectTimer = null
    stopPing()
    stopStallCheck()
    if (socket) {
      try {
        socket.onclose = null
        socket.close()
      } catch {
        // 已关闭的连接无需再次处理。
      }
      socket = null
    }
    status.value = 'idle'
    signalQuality.value = 0
    reconnectAttempts = 0
    lastPingAt = 0
    lastServerMessageAt = 0
    smoothedRtt = 200
    postReconnectPongs = 2
  }

  return { status, signalQuality, open, confirmSession, send, close }
}
