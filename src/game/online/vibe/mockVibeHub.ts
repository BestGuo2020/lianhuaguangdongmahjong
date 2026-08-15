// dev 专用本地 mock：模拟 VibeHub SDK 的房间/对端/存档，替代真实云端。
//
// 为什么需要它：真实 vibe.lumigrav.space 云端对本地来源有 CORS + 来源校验，
// 浏览器无法绕过（Origin 头不可伪造），所以本地永远连不上真实云端。本 mock 用
// BroadcastChannel 在「同源多窗口」之间模拟房间消息与对端在场，从而不发布即可
// 联调全部联机逻辑（建房/加房/座位/准备/快照/摸牌/碰杠胡/翻精）。
//
// 限制：这是同一浏览器多窗口之间的模拟，不是真实 WebRTC 数据通道；不同浏览器
// （如 Chrome + Edge）之间无法共享 BroadcastChannel，须用同一浏览器的两个窗口。
// 类型使用全局 declare namespace VibeHubSDK（见 vibehub.d.ts），无需 import。

type Wire =
  | { __mock: true; kind: 'join'; roomId: string; peerId: string; ts: number }
  | { __mock: true; kind: 'leave'; roomId: string; peerId: string }
  | { __mock: true; kind: 'welcome'; roomId: string; from: string; hostId: string; hostTs: number }
  | { __mock: true; kind: 'msg'; roomId: string; from: string; to?: string; payload: unknown }
  | { __mock: true; kind: 'meta_req'; roomId: string; from: string }
  | { __mock: true; kind: 'meta'; roomId: string; from: string; meta: VibeHubSDK.RoomMetadata | null }
  | { __mock: true; kind: 'ping'; roomId: string; peerId: string; ts: number }

const CHANNEL_NAME = 'lianhua-vibe-mock'
const META_WAIT_MS = 600

/** 每个窗口一个稳定 peerId（sessionStorage 按标签页隔离，两个标签页各不同）。 */
function getPeerId(): string {
  const fallback = () => {
    const hasUuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    return hasUuid
      ? crypto.randomUUID()
      : `peer-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  }
  try {
    // 本地重连测试：?mockPeer=<id> 覆盖身份；关标签页重开带同一参数即可恢复座位。
    const url = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('mockPeer') : null
    if (url) return url
    if (typeof globalThis.sessionStorage === 'undefined') return fallback()
    const existing = globalThis.sessionStorage.getItem('lianhua_mock_peer')
    if (existing) return existing
    const fresh = fallback()
    globalThis.sessionStorage.setItem('lianhua_mock_peer', fresh)
    return fresh
  } catch {
    return fallback()
  }
}

/** localStorage 优先、内存兜底的数据存储（模拟 client.save / client.global）。 */
function createLocalDataStore(namespace: string): VibeHubSDK.DataStore {
  const memory = new Map<string, string>()
  const storage = (() => {
    try {
      return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null
    } catch {
      return null
    }
  })()
  const rawKey = (key: string) => `vibe-mock:${namespace}:${key}`
  const read = (key: string): string | null => (
    storage ? storage.getItem(rawKey(key)) : (memory.get(key) ?? null)
  )
  const write = (key: string, value: string) => {
    if (storage) storage.setItem(rawKey(key), value)
    else memory.set(key, value)
  }
  const removeKey = (key: string) => {
    if (storage) storage.removeItem(rawKey(key))
    else memory.delete(key)
  }
  return {
    async set(key, value) {
      write(String(key), JSON.stringify(value))
      return { ok: true }
    },
    async get(key) {
      if (Array.isArray(key)) {
        const out: Record<string, unknown> = {}
        for (const k of key) {
          const v = read(String(k))
          if (v != null) out[String(k)] = JSON.parse(v)
        }
        return out
      }
      const v = read(String(key))
      return v != null ? JSON.parse(v) : null
    },
    async all() {
      const out: Record<string, unknown> = {}
      if (storage) {
        const prefix = `vibe-mock:${namespace}:`
        for (let i = 0; i < storage.length; i += 1) {
          const k = storage.key(i)
          if (k && k.startsWith(prefix)) {
            const v = storage.getItem(k)
            if (v != null) out[k.slice(prefix.length)] = JSON.parse(v)
          }
        }
      } else {
        memory.forEach((v, k) => { out[k] = JSON.parse(v) })
      }
      return out
    },
    async remove(key) {
      removeKey(String(key))
      return { ok: true }
    },
  } as VibeHubSDK.DataStore
}

function createMockStateManager(): VibeHubSDK.StateManager {
  const values = new Map<string, unknown>()
  const handlers = new Map<string, Set<(value: unknown, previous: unknown) => void>>()
  return {
    set(key, value) {
      const previous = values.get(key)
      values.set(key, value)
      handlers.get(key)?.forEach((cb) => cb(value, previous))
      return this
    },
    get(key) { return values.get(key) },
    on(key, cb) {
      if (!handlers.has(key)) handlers.set(key, new Set())
      handlers.get(key)!.add(cb)
      return () => { handlers.get(key)?.delete(cb) }
    },
    off(key, cb) { handlers.get(key)?.delete(cb) },
    snapshot() { return Object.fromEntries(values) },
  } as VibeHubSDK.StateManager
}

function createMockSync(): VibeHubSDK.SnapshotInterpolator {
  const store = new Map<string, VibeHubSDK.Snapshot>()
  return {
    push(key, snapshot) { store.set(key, snapshot) },
    get(key) { return store.get(key) ?? null },
    clear(key) {
      if (key != null) store.delete(key)
      else store.clear()
    },
  } as VibeHubSDK.SnapshotInterpolator
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export interface MockVibeOptions {
  /** 加入房间后等待其它对端出现的时间窗口；测试可调小。 */
  settleMs?: number
  /** 心跳间隔；0 表示关闭心跳（不检测掉线）。默认 1000ms。 */
  pingIntervalMs?: number
  /** 超过该时长未收到某成员任何消息则判定掉线（触发 onPeer leave）。默认 4000ms。 */
  leaveTimeoutMs?: number
  /** 注入固定 peerId（模拟刷新页面重进的同一身份）；缺省按 sessionStorage/随机生成。 */
  peerId?: string
}

export function createMockVibeClient(options: MockVibeOptions = {}): VibeHubSDK.Client {
  const settleMs = options.settleMs ?? 250
  const pingIntervalMs = options.pingIntervalMs ?? 1000
  const leaveTimeoutMs = options.leaveTimeoutMs ?? 4000
  const channel = new BroadcastChannel(CHANNEL_NAME)
  const rooms = new Map<string, MockRoom>()
  const metaCache = new Map<string, VibeHubSDK.RoomMetadata>()
  const authHandlers = new Set<(user: VibeHubSDK.User | null) => void>()
  const peerId = options.peerId ?? getPeerId()
  // 真实 SDK 走网络（JSON 序列化），应用层消息按设计是 JSON 安全的；这里同样先
  // JSON 序列化再投递，避免 Vue reactive Proxy 等对象无法被 structured clone 克隆
  // （DataCloneError）——与真实数据通道的行为一致。
  const post = (wire: Wire) => {
    channel.postMessage(JSON.parse(JSON.stringify(wire)))
  }

  channel.onmessage = (event: MessageEvent) => {
    const wire = event.data as Wire | undefined
    if (!wire || wire.__mock !== true) return
    if (wire.kind === 'meta') {
      if (wire.meta) metaCache.set(wire.roomId, wire.meta)
      return
    }
    rooms.get(wire.roomId)?.handleWire(wire)
  }

  // 心跳 + 掉线检测：模拟「标签页关闭」——窗口关闭后不再发 ping，其余端超时
  // 判定其掉线（触发 onPeer leave）。真实 SDK 由底层连接状态驱动，这里是模拟。
  if (pingIntervalMs > 0) {
    setInterval(() => {
      const now = Date.now()
      for (const room of rooms.values()) {
        if (!room.isLeft()) {
          post({ __mock: true, kind: 'ping', roomId: room.roomId, peerId, ts: now })
        }
        room.checkStale(now, leaveTimeoutMs)
      }
    }, pingIntervalMs)
  }

  class MockRoom implements VibeHubSDK.Room {
    readonly roomId: string
    readonly peerId: string
    readonly topology: 'host' = 'host'
    isHost = false
    hostId: string | null = null
    readonly data: VibeHubSDK.DataStore
    readonly state: VibeHubSDK.StateManager = createMockStateManager()
    readonly sync: VibeHubSDK.SnapshotInterpolator = createMockSync()

    private readonly members = new Map<string, number>() // peerId -> joinTs
    private readonly lastSeen = new Map<string, number>() // peerId -> 最近消息时间（心跳/任何消息）
    private meta: VibeHubSDK.RoomMetadata | null = null
    private readonly messageHandlers: Array<(message: unknown, fromPeerId: string) => void> = []
    private readonly peerHandlers: Array<(event: VibeHubSDK.PeerEvent) => void> = []
    private left = false

    constructor(roomId: string) {
      this.roomId = roomId
      this.peerId = peerId
      this.data = createLocalDataStore(`room:${roomId}`)
      const now = Date.now()
      this.members.set(peerId, now)
      this.lastSeen.set(peerId, now)
    }

    onMessage(callback: (message: unknown, fromPeerId: string) => void): this {
      this.messageHandlers.push(callback)
      return this
    }

    onPeer(callback: (event: VibeHubSDK.PeerEvent) => void): this {
      this.peerHandlers.push(callback)
      return this
    }

    send(message: unknown, toPeerId?: string): void {
      if (this.left) return
      post({
        __mock: true,
        kind: 'msg',
        roomId: this.roomId,
        from: this.peerId,
        ...(toPeerId != null ? { to: toPeerId } : {}),
        payload: message,
      })
    }

    sendRealtime(message: unknown, toPeerId?: string): void {
      this.send(message, toPeerId)
    }

    peers(): VibeHubSDK.PeerInfo[] {
      return [...this.members.keys()]
        .filter((id) => id !== this.peerId)
        .map((id) => ({
          id,
          open: true,
          latency: 5,
          jitter: 0,
          relay: false,
          realtime: true,
          reconnecting: false,
        }))
    }

    networkStats(): VibeHubSDK.NetworkStats {
      return { state: 'direct' } as VibeHubSDK.NetworkStats
    }

    async diagnostics(): Promise<VibeHubSDK.RoomDiagnostics> {
      return { capturedAt: new Date().toISOString() } as VibeHubSDK.RoomDiagnostics
    }

    reconnect(): void { /* 本地模拟无需重连 */ }

    async announce(metadata?: Record<string, unknown>): Promise<{ ok: true }> {
      const meta: VibeHubSDK.RoomMetadata = {
        roomId: this.roomId,
        players: this.members.size,
        hostPeerId: this.peerId,
        ...metadata,
      }
      this.meta = meta
      post({ __mock: true, kind: 'meta', roomId: this.roomId, from: this.peerId, meta })
      return { ok: true }
    }

    async close(): Promise<{ ok: true }> {
      this.leave()
      return { ok: true }
    }

    leave(): void {
      if (this.left) return
      this.left = true
      post({ __mock: true, kind: 'leave', roomId: this.roomId, peerId: this.peerId })
      this.messageHandlers.splice(0)
      this.peerHandlers.splice(0)
    }

    /** 该房间是否已被本窗口离开（离开后忽略一切 wire 消息）。 */
    isLeft(): boolean {
      return this.left
    }

    /** 本窗口是不是当前已知成员里最早加入的（用于即时判定房主）。 */
    private isEarliestMember(): boolean {
      return this.earliestMemberId() === this.peerId
    }

    private earliestMemberId(): string | null {
      let earliestId: string | null = null
      let earliestKey = ''
      for (const [id, ts] of this.members) {
        const key = `${String(ts).padStart(16, '0')}:${id}`
        if (earliestId === null || key < earliestKey) {
          earliestId = id
          earliestKey = key
        }
      }
      return earliestId
    }

    handleWire(wire: Wire): void {
      if (this.left) return
      if (wire.kind === 'join') {
        if (wire.peerId === this.peerId || this.members.has(wire.peerId)) return
        this.members.set(wire.peerId, wire.ts)
        this.lastSeen.set(wire.peerId, wire.ts)
        this.peerHandlers.forEach((cb) => cb({ type: 'join', id: wire.peerId }))
        // 本窗口是房主（最早加入者）：欢迎新人（携带房主身份，供对方完成选举）。
        if (this.isEarliestMember()) {
          post({
            __mock: true,
            kind: 'welcome',
            roomId: this.roomId,
            from: this.peerId,
            hostId: this.peerId,
            hostTs: this.members.get(this.peerId) ?? 0,
          })
        }
      } else if (wire.kind === 'welcome') {
        if (wire.hostId === this.peerId) return
        if (this.members.has(wire.hostId)) return
        this.members.set(wire.hostId, wire.hostTs)
        this.lastSeen.set(wire.hostId, wire.hostTs)
        this.hostId = wire.hostId
        this.isHost = false
        this.peerHandlers.forEach((cb) => cb({ type: 'join', id: wire.hostId }))
      } else if (wire.kind === 'leave') {
        if (wire.peerId === this.peerId) return
        if (!this.members.delete(wire.peerId)) return
        this.lastSeen.delete(wire.peerId)
        this.peerHandlers.forEach((cb) => cb({ type: 'leave', id: wire.peerId }))
      } else if (wire.kind === 'msg') {
        if (wire.to != null && wire.to !== this.peerId) return
        this.lastSeen.set(wire.from, Date.now())
        this.messageHandlers.forEach((cb) => cb(wire.payload, wire.from))
      } else if (wire.kind === 'ping') {
        // 心跳：仅刷新 lastSeen，不下发给业务 handler。
        if (wire.peerId !== this.peerId && this.members.has(wire.peerId)) {
          this.lastSeen.set(wire.peerId, wire.ts)
        }
      } else if (wire.kind === 'meta_req') {
        // 只有房主补发房间元数据（announce 的 mode/rulesetId 等）。
        if (!this.isEarliestMember() || !this.meta || wire.from === this.peerId) return
        post({ __mock: true, kind: 'meta', roomId: this.roomId, from: this.peerId, meta: this.meta })
      }
    }

    /** 掉线检测：成员超过 leaveTimeoutMs 未发任何消息 → 判定掉线（模拟标签页关闭）。 */
    checkStale(now: number, leaveTimeoutMs: number): void {
      if (this.left) return
      for (const [id, last] of this.lastSeen) {
        if (id === this.peerId) continue
        if (!this.members.has(id)) continue
        if (now - last > leaveTimeoutMs) {
          this.members.delete(id)
          this.lastSeen.delete(id)
          this.peerHandlers.forEach((cb) => cb({ type: 'leave', id }))
        }
      }
    }

    /** 加入收尾：按最早加入者（ts 最小、同 ts 取 peerId 字典序）确定房主。 */
    finalizeHost(): void {
      const earliestId = this.earliestMemberId()
      this.hostId = earliestId
      this.isHost = earliestId === this.peerId
    }
  }

  return {
    work: 'B5AJupT1',
    apiBase: 'mock://local',
    save: createLocalDataStore('save'),
    global: createLocalDataStore('global'),
    rooms: {
      async list() {
        // 本地模拟只支持「凭房间码加入」，不提供公开房间列表。
        return []
      },
      async get(roomId: string): Promise<VibeHubSDK.RoomMetadata | null> {
        const id = roomId.toUpperCase()
        if (metaCache.has(id)) return metaCache.get(id) ?? null
        // 向房主补发元数据请求（跨窗口无中心存储，只能靠房主响应）。
        post({ __mock: true, kind: 'meta_req', roomId: id, from: peerId })
        const deadline = Date.now() + META_WAIT_MS
        while (Date.now() < deadline) {
          await delay(25)
          if (metaCache.has(id)) return metaCache.get(id) ?? null
        }
        return null
      },
      async quickJoin() {
        return null
      },
    },
    room: {
      async join(roomId: string): Promise<VibeHubSDK.Room> {
        const id = roomId.toUpperCase()
        const existing = rooms.get(id)
        if (existing && !existing.isLeft()) return existing
        const room = new MockRoom(id)
        rooms.set(id, room)
        post({ __mock: true, kind: 'join', roomId: id, peerId, ts: Date.now() })
        // 等一个窗口让其它对端互相发现（房主/成员选举、welcome 互认）。
        await delay(settleMs)
        room.finalizeHost()
        return room
      },
    },
    user: null,
    async login(): Promise<VibeHubSDK.User> {
      return { id: peerId, name: '本地测试玩家', image: null }
    },
    logout(): void { /* 本地 mock 无登录态 */ },
    isLoggedIn(): boolean {
      return false
    },
    onAuthChange(callback: (user: VibeHubSDK.User | null) => void): () => void {
      authHandlers.add(callback)
      return () => { authHandlers.delete(callback) }
    },
  }
}
