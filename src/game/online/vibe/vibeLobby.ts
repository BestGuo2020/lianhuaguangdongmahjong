// 房主权威大厅协议（Phase 1 核心）：座位分配 + 准备态 + 开局，经 SDK Room 的 P2P 消息广播。
//
// SDK 语义（已核实 vibehub.js 源码）：room.onMessage/onPeer 是 push 多监听、无退订，
// 每个 handler 都会收到每条消息 → 各 handler 必须按自己的消息类型过滤。故本模块的
// 消息统一用 `type: 'lobby_*'` 前缀，与游戏消息（`kind: 'state_snapshot'` 等）隔离。
//
// 房主（host）维护座位表并广播 roster；客户端发 hello/ready，收 roster/start/closed。
// remoteRoomLifecycle 将改用本协议，替换 REST 的 room/seat/ready/start。

export interface LobbySeat {
  seat: number
  peerId: string
  nickname: string
  ready: boolean
}

// client → host
export type ClientLobbyMessage =
  | { type: 'lobby_hello'; nickname: string }
  | { type: 'lobby_ready'; ready: boolean }

// host → client
export type HostLobbyMessage =
  | { type: 'lobby_roster'; hostSeat: number; seats: LobbySeat[] }
  | { type: 'lobby_start' }
  | { type: 'lobby_closed' }

export function isClientLobbyMessage(message: unknown): message is ClientLobbyMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const type = (message as { type?: unknown }).type
  return type === 'lobby_hello' || type === 'lobby_ready'
}

export function isHostLobbyMessage(message: unknown): message is HostLobbyMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const type = (message as { type?: unknown }).type
  return type === 'lobby_roster' || type === 'lobby_start' || type === 'lobby_closed'
}

// ── 房主侧 ────────────────────────────────────────────────

export interface HostLobbyOptions {
  room: VibeHubSDK.Room
  capacity: number
  hostNickname: string
  /** 每次座位表变化时回调（房主自己的 UI 也用同一份座位表）。 */
  onRoster?: (seats: LobbySeat[]) => void
  /** 全员就绪并请求开局时回调。 */
  onStart: () => void
}

export function createHostLobby({ room, capacity, hostNickname, onRoster, onStart }: HostLobbyOptions) {
  // 座位 0 固定给房主；其余座位按 hello 到达顺序分配。
  const peers = new Map<string, LobbySeat>()
  const occupied = new Set<number>([0])
  let hostReady = false

  function roster(): LobbySeat[] {
    return [
      { seat: 0, peerId: room.peerId, nickname: hostNickname, ready: hostReady },
      ...[...peers.values()].sort((a, b) => a.seat - b.seat),
    ]
  }

  function broadcast() {
    room.send({ type: 'lobby_roster', hostSeat: 0, seats: roster() } satisfies HostLobbyMessage)
    onRoster?.(roster())
  }

  function nextSeat(): number {
    for (let seat = 1; seat < capacity; seat++) {
      if (!occupied.has(seat)) return seat
    }
    return -1
  }

  function allReady(): boolean {
    return hostReady && peers.size > 0 && [...peers.values()].every((seat) => seat.ready)
  }

  room.onPeer((event) => {
    if (event.type !== 'leave') return
    const seat = peers.get(event.id)
    if (seat) {
      peers.delete(event.id)
      occupied.delete(seat.seat)
      broadcast()
    }
  })

  room.onMessage((message, fromPeerId) => {
    if (!isClientLobbyMessage(message)) return
    if (message.type === 'lobby_hello') {
      const existing = peers.get(fromPeerId)
      if (existing) {
        existing.nickname = message.nickname
      } else {
        const seat = nextSeat()
        if (seat >= 0) {
          occupied.add(seat)
          peers.set(fromPeerId, { seat, peerId: fromPeerId, nickname: message.nickname, ready: false })
        }
      }
      broadcast()
    } else if (message.type === 'lobby_ready') {
      const seat = peers.get(fromPeerId)
      if (seat) {
        seat.ready = message.ready
        broadcast()
      }
    }
  })

  return {
    roster,
    setHostReady(ready: boolean) {
      hostReady = ready
      broadcast()
    },
    requestStart(): boolean {
      if (!allReady()) return false
      room.send({ type: 'lobby_start' } satisfies HostLobbyMessage)
      onStart()
      return true
    },
    close() {
      room.send({ type: 'lobby_closed' } satisfies HostLobbyMessage)
    },
  }
}

// ── 客户端侧 ──────────────────────────────────────────────

export interface ClientLobbyOptions {
  room: VibeHubSDK.Room
  onRoster: (hostSeat: number, seats: LobbySeat[]) => void
  onStart: () => void
  onClosed: () => void
}

export function createClientLobby({ room, onRoster, onStart, onClosed }: ClientLobbyOptions) {
  room.onMessage((message) => {
    if (!isHostLobbyMessage(message)) return
    if (message.type === 'lobby_roster') onRoster(message.hostSeat, message.seats)
    else if (message.type === 'lobby_start') onStart()
    else if (message.type === 'lobby_closed') onClosed()
  })

  return {
    hello(nickname: string) {
      room.send({ type: 'lobby_hello', nickname } satisfies ClientLobbyMessage)
    },
    setReady(ready: boolean) {
      room.send({ type: 'lobby_ready', ready } satisfies ClientLobbyMessage)
    },
  }
}
