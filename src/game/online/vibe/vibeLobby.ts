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

export interface LobbyParticipant {
  seat: number
  peerId: string
}

interface HostedSeat extends LobbySeat {
  /** Stable application identity; never included in the public roster. */
  playerId: string
  /** Host-issued capability required to reclaim this seat after peerId changes. */
  seatToken: string
}

// client → host
export type ClientLobbyMessage =
  | { type: 'lobby_hello'; nickname: string; avatar: string; playerId?: string; seatToken?: string }
  | { type: 'lobby_ready'; ready: boolean }
  | { type: 'lobby_leave' }
  | { type: 'lobby_ping' }

// host → client
export type HostLobbyMessage =
  | { type: 'lobby_roster'; hostSeat: number; revision: number; seats: LobbySeat[] }
  | { type: 'lobby_seat_token'; seat: number; token: string }
  /** 房主锁定首局承诺洗牌的实际参与者和对应 roster 版本；缺失即拒绝开局。 */
  | { type: 'lobby_start'; shuffleId: string; seatCount: number; rosterRevision: number; participants: LobbyParticipant[] }
  | { type: 'lobby_closed' }

function isLobbyParticipants(value: unknown, seatCount: number): value is LobbyParticipant[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > seatCount) return false
  const seats = new Set<number>()
  const peers = new Set<string>()
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false
    const participant = item as Record<string, unknown>
    if (!Number.isInteger(participant.seat) || (participant.seat as number) < 0 || (participant.seat as number) >= seatCount) return false
    if (typeof participant.peerId !== 'string' || !participant.peerId) return false
    if (seats.has(participant.seat as number) || peers.has(participant.peerId)) return false
    seats.add(participant.seat as number)
    peers.add(participant.peerId)
    return true
  }) && seats.has(0)
}

export function isClientLobbyMessage(message: unknown): message is ClientLobbyMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const value = message as Record<string, unknown>
  if (value.type === 'lobby_hello') {
    return typeof value.nickname === 'string'
      && typeof value.avatar === 'string'
      && (value.playerId === undefined || typeof value.playerId === 'string')
      && (value.seatToken === undefined || typeof value.seatToken === 'string')
  }
  if (value.type === 'lobby_ready') return typeof value.ready === 'boolean'
  return value.type === 'lobby_leave' || value.type === 'lobby_ping'
}

export function isHostLobbyMessage(message: unknown): message is HostLobbyMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const value = message as Record<string, unknown>
  if (value.type === 'lobby_roster') {
    if (!Number.isInteger(value.revision) || (value.revision as number) < 1
      || value.hostSeat !== 0
      || !Array.isArray(value.seats) || value.seats.length < 1 || value.seats.length > 4) return false
    const seats = value.seats
    const seatNumbers = new Set<number>()
    const peerIds = new Set<string>()
    return seats.every((seat) => {
        if (typeof seat !== 'object' || seat === null) return false
        const item = seat as Record<string, unknown>
        if (!Number.isInteger(item.seat) || (item.seat as number) < 0 || (item.seat as number) > 3) return false
        if (typeof item.peerId !== 'string' || typeof item.nickname !== 'string'
          || typeof item.avatar !== 'string' || typeof item.ready !== 'boolean') return false
        if (seatNumbers.has(item.seat as number) || peerIds.has(item.peerId)) return false
        seatNumbers.add(item.seat as number)
        peerIds.add(item.peerId)
        return true
      }) && seatNumbers.has(value.hostSeat as number)
  }
  if (value.type === 'lobby_seat_token') {
    return Number.isInteger(value.seat) && (value.seat as number) >= 0 && (value.seat as number) <= 3
      && typeof value.token === 'string' && value.token.length > 0
  }
  if (value.type === 'lobby_start') {
    return typeof value.shuffleId === 'string'
      && value.shuffleId.length > 0
      && Number.isInteger(value.seatCount) && (value.seatCount as number) >= 1 && (value.seatCount as number) <= 4
      && Number.isInteger(value.rosterRevision) && (value.rosterRevision as number) >= 1
      && isLobbyParticipants(value.participants, value.seatCount as number)
  }
  return value.type === 'lobby_closed'
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
  onStart: (details: { shuffleId: string; seatCount: number; rosterRevision: number; participants: LobbyParticipant[] }) => void
  /** 掉线宽限（ms）：peer 失联（SDK 只报 reconnecting、不报 leave）超过该时长仍不恢复 → 释放座位。默认 10s。 */
  staleGraceMs?: number
  /** 测试注入；生产默认使用不可预测的主机签发随机 token。 */
  generateSeatToken?: () => string
  /** 对局中回调：为 true 时掉线座位不释放（座位已锁定给对局、AI 代打，不能分给新玩家）。 */
  isInMatch?: () => boolean
}

export function createHostLobby({
  room, capacity, hostNickname, hostAvatar, onRoster, onStart,
  staleGraceMs = 10000, isInMatch = () => false,
  generateSeatToken = () => {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  },
}: HostLobbyOptions) {
  // 应用层心跳超时：客户端每 15s 发 lobby_ping，超过 40s 未收到对端任何消息 → 判定离开。
  const PING_TIMEOUT_MS = 40000
  // 座位 0 固定给房主；其余座位按 hello 到达顺序分配。
  const peers = new Map<string, HostedSeat>()
  const occupied = new Set<number>([0])
  const staleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const relayPeers = new Set<string>()
  // 应用层心跳：客户端定期发 lobby_ping（见 createClientLobby），房主记录每个对端
  // 最后活跃时间；超过 PING_TIMEOUT_MS 无任何消息（关页面不再 ping）→ 判定离开。
  // 这是不依赖 SDK peers()/事件的主动检测，保证「关闭浏览器 → 房主尽快看到退出」。
  const lastSeenMap = new Map<string, number>()
  let hostReady = false
  let rosterRevision = 0

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
      const connected = relayPeers.has(peerId) || Boolean(info && info.open && !info.reconnecting)
      const alive = now - lastSeen < PING_TIMEOUT_MS
      // 连接正常且最近有心跳/消息：不动（宽限的取消只由 join/connecting/hello 等事件负责）。
      if (connected && alive) continue
      // 连接断开/重连中/已从列表移除，或超过心跳超时（关页面前不再发 ping）→ 宽限释放。
      if (!staleTimers.has(peerId)) scheduleStaleRelease(peerId)
    }
  }, 5000)

  function roster(): LobbySeat[] {
    const publicPeers = [...peers.values()].map(({ playerId: _playerId, seatToken: _seatToken, ...seat }) => seat)
    return [
      { seat: 0, peerId: room.peerId, nickname: hostNickname, avatar: hostAvatar, ready: hostReady },
      ...publicPeers.sort((a, b) => a.seat - b.seat),
    ]
  }

  function broadcast() {
    rosterRevision += 1
    const seats = roster()
    room.send({ type: 'lobby_roster', hostSeat: 0, revision: rosterRevision, seats } satisfies HostLobbyMessage)
    onRoster?.(seats)
  }

  function sendSeatToken(seat: HostedSeat, peerId: string) {
    room.send({ type: 'lobby_seat_token', seat: seat.seat, token: seat.seatToken } satisfies HostLobbyMessage, peerId)
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
    relayPeers.delete(peerId)
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
      const replacement = [...peers.entries()].find(([id, s]) => id !== peerId && s.playerId === seat.playerId)
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
      // 大厅中正常掉线/主动离开可以立即释放；对局中必须保留旧身份和座位，
      // 否则刷新后的新 peerId 只能被分到新座位，房主控制器也无法按原座位归还真人。
      // 对局中座位由 AI 代打，等稳定 playerId 的 lobby_hello 来顶替旧 peer。
      if (isInMatch()) return
      relayPeers.delete(event.id)
      clearStaleTimer(event.id)
      removePeer(event.id)
      return
    }
    if (event.type === 'reconnecting') {
      // 真实 SDK 对「对端关闭页面」通常只报 reconnecting（连接中断、等待恢复）而非
      // leave——若不处理，掉线玩家永远占座，新玩家只能被分到下一座位（人越加越多、
      // 4 人局满后新玩家进不去）。宽限超时仍未恢复 → 释放。
      relayPeers.delete(event.id)
      scheduleStaleRelease(event.id)
      return
    }
    if (event.type === 'relay') {
      if (event.active) {
        // 直连切换到 SDK Relay 仍是在线：不能让中继切换期间的宽限计时器释放座位。
        relayPeers.add(event.id)
        clearStaleTimer(event.id)
      } else {
        relayPeers.delete(event.id)
      }
      return
    }
    if (event.type === 'join' || event.type === 'connecting') {
      // 恢复（网络抖动后回来）→ 取消宽限释放。
      relayPeers.delete(event.id)
      clearStaleTimer(event.id)
    }
  })

  room.onMessage((message, fromPeerId) => {
    if (!isClientLobbyMessage(message)) return
    // 任何客户端消息（含心跳 lobby_ping）都刷新「最后活跃时间」。
    lastSeenMap.set(fromPeerId, Date.now())
    if (message.type === 'lobby_hello') {
      // peerId 每次刷新都会变化，playerId 才是可用于续接座位的稳定身份。
      // 缺失时退回当前 peerId，但绝不再按昵称继承座位，避免同名玩家抢座。
      const playerId = message.playerId?.trim() || fromPeerId
      const presentedToken = message.seatToken?.trim() || ''
      const existing = peers.get(fromPeerId)
      if (existing) {
        existing.nickname = message.nickname
        existing.avatar = message.avatar
        // peerId 已经绑定到这个座位；重复 hello 只刷新展示信息，不能借机改写
        // playerId，把当前连接变成另一个稳定身份。
        sendSeatToken(existing, fromPeerId)
      } else {
        // 刷新重进（peerId 变化）：稳定 playerId 只是索引，真正的续接凭据必须是
        // 房主此前签发、且只通过定向消息发给该座位的 seatToken；昵称和可伪造的
        // localStorage playerId 不能单独夺取旧座位。
        const sameIdentity = [...peers.entries()].find(
          ([id, s]) => id !== fromPeerId
            && s.playerId === playerId
            && presentedToken === s.seatToken
            && (isInMatch() || staleTimers.has(id)),
        )
        if (sameIdentity) {
          clearStaleTimer(sameIdentity[0])
          peers.delete(sameIdentity[0])
          peers.set(fromPeerId, {
            seat: sameIdentity[1].seat,
            peerId: fromPeerId,
            nickname: message.nickname,
            avatar: message.avatar,
            ready: false,
            playerId,
            seatToken: sameIdentity[1].seatToken,
          })
        } else {
          const seat = nextSeat()
          if (seat >= 0) {
            occupied.add(seat)
            const seatToken = generateSeatToken()
            peers.set(fromPeerId, { seat, peerId: fromPeerId, nickname: message.nickname, avatar: message.avatar, ready: false, playerId, seatToken })
          }
        }
      }
      broadcast()
      // 新 peer 的第一条 hello 可能早于 SDK 广播列表完成；定向回发最新 roster，
      // 避免该客户端只收到一份不含自己的旧/部分 roster 后停止 hello 重试。
      room.send({ type: 'lobby_roster', hostSeat: 0, revision: rosterRevision, seats: roster() } satisfies HostLobbyMessage, fromPeerId)
      const assigned = peers.get(fromPeerId)
      if (assigned) sendSeatToken(assigned, fromPeerId)
    } else if (message.type === 'lobby_ready') {
      const seat = peers.get(fromPeerId)
      if (seat) {
        seat.ready = message.ready
        broadcast()
      }
    } else if (message.type === 'lobby_leave') {
      const seat = peers.get(fromPeerId)
      if (seat) {
        // 客户端刷新/关闭页面时可能先发 lobby_leave，再触发 SDK leave；
        // 对局中仍要锁住座位，保证新 peerId 能按 playerId 恢复原座位。
        if (isInMatch()) return
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
      const shuffleId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      // seatCount 表示整张牌桌的座位编号范围，不是当前真人数量。
      // 3 人 + 1 AI 时仍必须是 4，否则 AI 补在 seat 3 时会被承诺洗牌
      // 的 validSeat() 错误判为越界；实际参与承诺的真人由 seatByPeer 决定。
      const seatCount = capacity
      // 发送开局前再广播一次当前名单，确保 start 绑定的是最新 revision，而不是
      // ready/重连竞态中的上一版 roster。客户端必须精确匹配这个版本。
      broadcast()
      const startRosterRevision = rosterRevision
      const participants = roster().map(({ seat, peerId }) => ({ seat, peerId }))
      room.send({ type: 'lobby_start', shuffleId, seatCount, rosterRevision: startRosterRevision, participants } satisfies HostLobbyMessage)
      onStart({ shuffleId, seatCount, rosterRevision: startRosterRevision, participants })
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
  onSeatToken?: (token: string) => void
  onStart: (details: { shuffleId: string; seatCount: number; rosterRevision: number; participants: LobbyParticipant[] }) => void
  onClosed: () => void
}

export function createClientLobby({ room, onRoster, onSeatToken, onStart, onClosed }: ClientLobbyOptions) {
  let nickname = ''
  let avatar = ''
  let playerId = ''
  let seatToken = ''
  let assignedSeat: number | null = null
  let pinnedHostPeerId: string | null = null
  let receivedRoster = false
  let lastRosterRevision = 0
  let pendingStart: { shuffleId: string; seatCount: number; rosterRevision: number; participants: LobbyParticipant[] } | null = null
  let startedShuffleId: string | null = null
  let helloRetry: ReturnType<typeof setInterval> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  function sendHello() {
    room.send({ type: 'lobby_hello', nickname, avatar, playerId, ...(seatToken ? { seatToken } : {}) } satisfies ClientLobbyMessage)
  }

  function stopRetry() {
    if (helloRetry != null) {
      clearInterval(helloRetry)
      helloRetry = null
    }
  }

  function startIfReady() {
    if (!pendingStart || !receivedRoster || assignedSeat == null) return
    if (pendingStart.rosterRevision < lastRosterRevision) {
      // 当前名单已经更新，旧 start 不能再启动一套旧座位/旧洗牌。
      pendingStart = null
      return
    }
    if (pendingStart.rosterRevision > lastRosterRevision) return
    // 生产房主会把实际参与者锁进 lobby_start。当前连接不是这份锁定映射的一员
    // 时禁止启动，避免旧/错配 Room 把一个客户端拉进另一套洗牌屏障。
    if (!pendingStart.participants.some((participant) => participant.peerId === room.peerId && participant.seat === assignedSeat)) return
    if (startedShuffleId === pendingStart.shuffleId) {
      pendingStart = null
      return
    }
    const start = pendingStart
    pendingStart = null
    startedShuffleId = start.shuffleId
    onStart(start)
  }

  // 连接就绪后（重新）发送 hello：join 后立即 send 可能因 DataChannel 尚未建立而丢失，
  // 导致房主收不到 hello、roster 缺该玩家（进而 mySeat 恒为 -1、无准备按钮、无法开局）。
  room.onPeer((event) => {
    if (event.type === 'join' && nickname && !receivedRoster) {
      sendHello()
    }
  })

  room.onMessage((message, fromPeerId) => {
    if (!isHostLobbyMessage(message)) return
    // 大厅状态同样由 SDK 房主唯一维护。其它 peer 伪造的 roster/start/closed
    // 不能改变客户端座位、开局或房间生命周期。
    if (!room.hostId || fromPeerId !== room.hostId) return
    if (pinnedHostPeerId == null) pinnedHostPeerId = room.hostId
    if (pinnedHostPeerId !== room.hostId || fromPeerId !== pinnedHostPeerId) return
    if (message.type === 'lobby_roster') {
      if (message.revision <= lastRosterRevision) return
      const hostSeat = message.seats.find((seat) => seat.seat === 0)
      if (!hostSeat || hostSeat.peerId !== pinnedHostPeerId) return
      // 收到 roster 不等于座位恢复成功：SDK/Relay 可能先投递房主的旧列表。
      // 只有列表明确包含当前 peerId，才停止 hello 重试并落地座位。
      const assigned = message.seats.some((seat) => seat.peerId === room.peerId)
      if (!assigned) {
        sendHello()
        return
      }
      receivedRoster = true
      lastRosterRevision = message.revision
      stopRetry()
      assignedSeat = message.seats.find((seat) => seat.peerId === room.peerId)?.seat ?? null
      onRoster(message.hostSeat, message.seats)
      startIfReady()
    } else if (message.type === 'lobby_seat_token') {
      // 令牌是恢复原座位的能力凭据，不允许在收到 roster 前先落地：
      // 否则一条乱序/迟到的定向消息可能把 token 绑定到尚未确认的座位，
      // 后续重进就会携带错误凭据污染会话恢复。
      if (assignedSeat == null || message.seat !== assignedSeat) return
      if (!message.token) return
      seatToken = message.token
      onSeatToken?.(seatToken)
    } else if (message.type === 'lobby_start') {
      // SDK 不保证 roster 与 lobby_start 的到达顺序；没有本端座位时先缓存，
      // 禁止在 mySeat=-1 的半会话里启动承诺洗牌/发牌动画。
      pendingStart = message
      startIfReady()
    }
    else if (message.type === 'lobby_closed') onClosed()
  })

  return {
    hello(name: string, avatarUrl = '', stablePlayerId = '', stableSeatToken = '') {
      nickname = name
      avatar = avatarUrl
      playerId = stablePlayerId
      seatToken = stableSeatToken
      assignedSeat = null
      receivedRoster = false
      lastRosterRevision = 0
      pendingStart = null
      startedShuffleId = null
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
