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
  avatar: string
  ready: boolean
}

// client → host
export type ClientLobbyMessage =
  | { type: 'lobby_hello'; nickname: string; avatar: string }
  | { type: 'lobby_ready'; ready: boolean }
  | { type: 'lobby_leave' }
  | { type: 'lobby_ping' }

// host → client
export type HostLobbyMessage =
  | { type: 'lobby_roster'; hostSeat: number; seats: LobbySeat[] }
  | { type: 'lobby_start' }
  | { type: 'lobby_closed' }

export function isClientLobbyMessage(message: unknown): message is ClientLobbyMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const type = (message as { type?: unknown }).type
  return type === 'lobby_hello' || type === 'lobby_ready' || type === 'lobby_leave' || type === 'lobby_ping'
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
  hostAvatar: string
  /** 每次座位表变化时回调（房主自己的 UI 也用同一份座位表）。 */
  onRoster?: (seats: LobbySeat[]) => void
  /** 全员就绪并请求开局时回调。 */
  onStart: () => void
  /** 掉线宽限（ms）：peer 失联（SDK 只报 reconnecting、不报 leave）超过该时长仍不恢复 → 释放座位。默认 10s。 */
  staleGraceMs?: number
  /** 对局中回调：为 true 时掉线座位不释放（座位已锁定给对局、AI 代打，不能分给新玩家）。 */
  isInMatch?: () => boolean
}

export function createHostLobby({
  room, capacity, hostNickname, hostAvatar, onRoster, onStart,
  staleGraceMs = 10000, isInMatch = () => false,
}: HostLobbyOptions) {
  // 应用层心跳超时：客户端每 15s 发 lobby_ping，超过 40s 未收到对端任何消息 → 判定离开。
  const PING_TIMEOUT_MS = 40000
  // 座位 0 固定给房主；其余座位按 hello 到达顺序分配。
  const peers = new Map<string, LobbySeat>()
  const occupied = new Set<number>([0])
  const staleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // 应用层心跳：客户端定期发 lobby_ping（见 createClientLobby），房主记录每个对端
  // 最后活跃时间；超过 PING_TIMEOUT_MS 无任何消息（关页面不再 ping）→ 判定离开。
  // 这是不依赖 SDK peers()/事件的主动检测，保证「关闭浏览器 → 房主尽快看到退出」。
  const lastSeenMap = new Map<string, number>()
  let hostReady = false

  // 兜底：SDK 可能对「对端直接关闭页面/标签页」只做底层连接关闭、不立刻发
  // leave/reconnecting 事件（对端要从 peers() 移除要等 P2P 重连超时 ≈120s）——
  // 定期检查已登记 peer 的连接状态 + 应用层心跳（最后活跃时间），发现断开/失活
  // 即进 10s 宽限（防抖动），宽限内未恢复就释放座位并广播，让房主尽快看到有人退出。
  const presenceTimer = setInterval(() => {
    if (isInMatch()) return // 对局中座位锁定给 AI 代打，不在此释放
    const onlinePeers = room.peers()
    const now = Date.now()
    for (const [peerId] of peers) {
      const info = onlinePeers.find((p) => p.id === peerId)
      const lastSeen = lastSeenMap.get(peerId) ?? now
      const connected = Boolean(info && info.open && !info.reconnecting)
      const alive = now - lastSeen < PING_TIMEOUT_MS
      // 连接正常且最近有心跳/消息：不动（宽限的取消只由 join/connecting/hello 等事件负责）。
      if (connected && alive) continue
      // 连接断开/重连中/已从列表移除，或超过心跳超时（关页面前不再发 ping）→ 宽限释放。
      if (!staleTimers.has(peerId)) scheduleStaleRelease(peerId)
    }
  }, 5000)

  function roster(): LobbySeat[] {
    return [
      { seat: 0, peerId: room.peerId, nickname: hostNickname, avatar: hostAvatar, ready: hostReady },
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
    // 允许无 peer（房主独玩，空席 AI 补位）；有 peer 时须全员就绪。
    return hostReady && [...peers.values()].every((seat) => seat.ready)
  }

  function removePeer(peerId: string) {
    const seat = peers.get(peerId)
    if (!seat) return
    peers.delete(peerId)
    occupied.delete(seat.seat)
    broadcast()
  }

  function clearStaleTimer(peerId: string) {
    const timer = staleTimers.get(peerId)
    if (timer != null) {
      clearTimeout(timer)
      staleTimers.delete(peerId)
    }
  }

  // 掉线宽限：失联（reconnecting）一段时间后释放座位。若期间有「同名」新窗口加入
  // （刷新页面重进，peerId 变化），直接把旧座位继承给新身份，避免人越加越多。
  function scheduleStaleRelease(peerId: string) {
    if (isInMatch()) return // 对局中座位锁定给 AI 代打，不释放
    clearStaleTimer(peerId)
    staleTimers.set(peerId, setTimeout(() => {
      staleTimers.delete(peerId)
      const seat = peers.get(peerId)
      if (!seat) return
      const replacement = [...peers.entries()].find(([id, s]) => id !== peerId && s.nickname === seat.nickname)
      if (replacement) {
        peers.delete(peerId)
        peers.set(replacement[0], { ...replacement[1], seat: seat.seat })
      } else {
        peers.delete(peerId)
        occupied.delete(seat.seat)
      }
      broadcast()
    }, staleGraceMs))
  }

  room.onPeer((event) => {
    if (event.type === 'leave') {
      // 正常掉线/主动离开：立即释放。
      clearStaleTimer(event.id)
      removePeer(event.id)
      return
    }
    if (event.type === 'reconnecting') {
      // 真实 SDK 对「对端关闭页面」通常只报 reconnecting（连接中断、等待恢复）而非
      // leave——若不处理，掉线玩家永远占座，新玩家只能被分到下一座位（人越加越多、
      // 4 人局满后新玩家进不去）。宽限超时仍未恢复 → 释放。
      scheduleStaleRelease(event.id)
      return
    }
    if (event.type === 'join' || event.type === 'connecting') {
      // 恢复（网络抖动后回来）→ 取消宽限释放。
      clearStaleTimer(event.id)
    }
  })

  room.onMessage((message, fromPeerId) => {
    if (!isClientLobbyMessage(message)) return
    // 任何客户端消息（含心跳 lobby_ping）都刷新「最后活跃时间」。
    lastSeenMap.set(fromPeerId, Date.now())
    if (message.type === 'lobby_hello') {
      const existing = peers.get(fromPeerId)
      if (existing) {
        existing.nickname = message.nickname
        existing.avatar = message.avatar
      } else {
        // 刷新重进（peerId 变化）：优先把座位继承给同名的新身份。对局中旧身份的座位
        // 仍占着（isInMatch 不释放），若不顶替，新 peerId 会被 nextSeat 分到别的座位，
        // 导致 hostGameRunner 按大厅座位表恢复时对错座位（抢真人座位 / 操作对不上 /
        // continue 屏障等错人 → 结算后卡在「已确认，等待其他玩家」）。
        const sameName = [...peers.entries()].find(
          ([id, s]) => id !== fromPeerId && s.nickname === message.nickname && (isInMatch() || staleTimers.has(id)),
        )
        if (sameName) {
          clearStaleTimer(sameName[0])
          peers.delete(sameName[0])
          peers.set(fromPeerId, {
            seat: sameName[1].seat,
            peerId: fromPeerId,
            nickname: message.nickname,
            avatar: message.avatar,
            ready: false,
          })
        } else {
          const seat = nextSeat()
          if (seat >= 0) {
            occupied.add(seat)
            peers.set(fromPeerId, { seat, peerId: fromPeerId, nickname: message.nickname, avatar: message.avatar, ready: false })
          }
        }
      }
      broadcast()
    } else if (message.type === 'lobby_ready') {
      const seat = peers.get(fromPeerId)
      if (seat) {
        seat.ready = message.ready
        broadcast()
      }
    } else if (message.type === 'lobby_leave') {
      const seat = peers.get(fromPeerId)
      if (seat) {
        peers.delete(fromPeerId)
        occupied.delete(seat.seat)
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
      clearInterval(presenceTimer)
      staleTimers.forEach((timer) => clearTimeout(timer))
      staleTimers.clear()
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
  let nickname = ''
  let avatar = ''
  let receivedRoster = false
  let helloRetry: ReturnType<typeof setInterval> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  function sendHello() {
    room.send({ type: 'lobby_hello', nickname, avatar } satisfies ClientLobbyMessage)
  }

  function stopRetry() {
    if (helloRetry != null) {
      clearInterval(helloRetry)
      helloRetry = null
    }
  }

  // 连接就绪后（重新）发送 hello：join 后立即 send 可能因 DataChannel 尚未建立而丢失，
  // 导致房主收不到 hello、roster 缺该玩家（进而 mySeat 恒为 -1、无准备按钮、无法开局）。
  room.onPeer((event) => {
    if (event.type === 'join' && nickname && !receivedRoster) {
      sendHello()
    }
  })

  room.onMessage((message) => {
    if (!isHostLobbyMessage(message)) return
    if (message.type === 'lobby_roster') {
      receivedRoster = true
      stopRetry()
      onRoster(message.hostSeat, message.seats)
    } else if (message.type === 'lobby_start') onStart()
    else if (message.type === 'lobby_closed') onClosed()
  })

  return {
    hello(name: string, avatarUrl = '') {
      nickname = name
      avatar = avatarUrl
      receivedRoster = false
      stopRetry()
      sendHello()
      // 兜底：首次 hello 因通道未就绪丢失（SDK join 事件可能不会对新人自身触发，
      // onPeer 重发兜不住）→ 每 2s 重发，直到收到 roster（mySeat 落地）。
      helloRetry = setInterval(() => {
        if (receivedRoster) { stopRetry(); return }
        sendHello()
      }, 2000)
      // 应用层心跳：每 15s 发 lobby_ping，让房主能检测「关闭页面」的客户端
      // （关页面后不再发 ping，房主 40s 内判定离开并释放座位），不依赖 SDK 事件。
      if (pingTimer == null) {
        pingTimer = setInterval(() => {
          if (nickname) room.send({ type: 'lobby_ping' } satisfies ClientLobbyMessage)
        }, 15000)
      }
    },
    setReady(ready: boolean) {
      room.send({ type: 'lobby_ready', ready } satisfies ClientLobbyMessage)
    },
    leave() {
      stopRetry()
      if (pingTimer != null) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      room.send({ type: 'lobby_leave' } satisfies ClientLobbyMessage)
    },
  }
}
