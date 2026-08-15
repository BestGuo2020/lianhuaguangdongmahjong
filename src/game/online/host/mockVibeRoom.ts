// 测试助手：最小可用的 VibeHub Room mock，供 controller/lobby/session 单测使用。
// 只实现 onMessage/onPeer/send，其余成员以空桩满足 VibeHubSDK.Room 类型。
export interface SentMessage {
  message: unknown
  to?: string
}

export type MockVibeRoom = VibeHubSDK.Room & {
  /** 模拟远端发来消息。 */
  emit(fromPeerId: string, message: unknown): void
  /** 模拟 peer 事件。 */
  emitPeer(event: VibeHubSDK.PeerEvent): void
  /** 已 send 的消息记录。 */
  sent: SentMessage[]
}

export function createMockVibeRoom(isHost = true): MockVibeRoom {
  const messageHandlers: Array<(message: unknown, fromPeerId: string) => void> = []
  const peerHandlers: Array<(event: VibeHubSDK.PeerEvent) => void> = []
  const sent: SentMessage[] = []

  const room = {
    roomId: 'ROOM',
    peerId: isHost ? 'host-peer' : 'client-peer',
    topology: 'host' as const,
    isHost,
    hostId: 'host-peer',
    data: {} as VibeHubSDK.DataStore,
    state: {} as VibeHubSDK.StateManager,
    sync: {} as VibeHubSDK.SnapshotInterpolator,
    onMessage(cb: (message: unknown, fromPeerId: string) => void) {
      messageHandlers.push(cb)
      return room
    },
    onPeer(cb: (event: VibeHubSDK.PeerEvent) => void) {
      peerHandlers.push(cb)
      return room
    },
    send(message: unknown, toPeerId?: string) {
      sent.push({ message, to: toPeerId })
    },
    sendRealtime() {},
    peers: () => [],
    networkStats: () => ({} as VibeHubSDK.NetworkStats),
    diagnostics: async () => ({} as VibeHubSDK.RoomDiagnostics),
    reconnect() {},
    announce: async () => ({ ok: true as const }),
    close: async () => ({ ok: true as const }),
    leave() {},
  } as unknown as MockVibeRoom

  room.emit = (fromPeerId, message) => {
    messageHandlers.forEach((cb) => cb(message, fromPeerId))
  }
  room.emitPeer = (event) => {
    peerHandlers.forEach((cb) => cb(event))
  }
  room.sent = sent
  return room
}
