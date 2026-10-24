// VibeHub P2P 传输层：把 SDK Room 的 send/onMessage/onPeer 封装成 roomSocket 同款接口
// （{ status, signalQuality, open, confirmSession, send, close }），供 useRemoteGame 无痛替换。
//
// 与 WebSocket 的关键差异：room.onMessage/onPeer 返回 `this`（Room）而非退订函数，
// 因此 transport 在 join 完成后绑定一次，之后不复绑；SDK 自行处理断线重连与中继切换。
//
// 连接状态完全由 SDK 的 onPeer/onMessage 事件驱动；不建立应用层心跳或周期轮询。
import { ref } from 'vue'

export type RoomSocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface VibeRoomTransportOptions {
  /** 返回当前已加入的 SDK 房间；未加入时为 null。 */
  getRoom: () => VibeHubSDK.Room | null
  onMessage: (message: unknown, fromPeerId?: string) => void
  /** SDK 明确报告房主连接持续不可用，或可靠发送同步失败时完整重进。 */
  onHostConnectionLost?: () => void
}

/** open 选项：signalOnly=true 时只监听 SDK 连接事件，业务消息不转发。
 * 房主用它绑定传输层测「到各客户端」的信号——房主业务消息走 onLocalSnapshot/
 * onLocalEvent，不能经 transport 转发（否则会收到自己广播的回环、重复处理）。 */
export interface VibeRoomOpenOptions {
  signalOnly?: boolean
}

/** SDK 端到端 RTT → 0-3 信号档。 */
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

/**
 * 大包分片：VibeHub SDK 对单条消息的大小有隐含上限，超限时它的可靠发送链会静默失败
 * （只打一条 `[VibeHub] 联机消息加密失败: 消息未发送` 警告）。血流结算帧是全场最大的一帧，
 * 实测正是它发不出去 → 客机长期收不到帧 → 判「房主无法恢复」中断整场（2026-09-10 线上验收）。
 * 这里在应用层把超限消息切成若干块发送，接收端按 index 重组（字节级拼接后再解码，
 * 避免多字节字符被切在块边界上损坏）。
 */
const CHUNK_KIND = '__chunk'
/** 阈值取偏小值：SDK 在「直连中断、走中继」时单包上限比直连小得多，超限会静默失败。 */
const CHUNK_LIMIT_BYTES = 4_000
const CHUNK_ASSEMBLY_TTL_MS = 15_000
const TRANSPORT_DIAG = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('bfdiag')

interface ChunkMail {
  kind: typeof CHUNK_KIND
  id: string
  index: number
  total: number
  data: string
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function chunkEnvelope(text: string): ChunkMail[] {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= CHUNK_LIMIT_BYTES) return []
  const total = Math.ceil(bytes.length / CHUNK_LIMIT_BYTES)
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const parts: ChunkMail[] = []
  for (let index = 0; index < total; index += 1) {
    parts.push({
      kind: CHUNK_KIND, id, index, total,
      data: toBase64(bytes.subarray(index * CHUNK_LIMIT_BYTES, (index + 1) * CHUNK_LIMIT_BYTES)),
    })
  }
  return parts
}

function describeUnserializable(root: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (value: unknown, path: string, depth: number): string | null => {
    if (depth > 6) return null
    if (typeof value === 'bigint') return `BigInt@${path}`
    if (typeof value === 'symbol') return `Symbol@${path}`
    if (!value || typeof value !== 'object') return null
    if (seen.has(value as object)) return `Circular@${path}`
    seen.add(value as object)
    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, 40); index += 1) {
        const hit = walk(value[index], `${path}[${index}]`, depth + 1)
        if (hit) return hit
      }
      return null
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hit = walk(child, `${path}.${key}`, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return walk(root, '$', 0) ?? '(未定位：可能是 getter 抛错或代理陷阱)'
}

/**
 * 发送前净化：SDK 的可靠发送链是异步的（`_reliableSendChain`），加密/序列化失败只会被它自己
 * 吞成一条 `[VibeHub] 联机消息加密失败: 消息未发送` 警告，应用侧看不到是哪条消息挂了。
 * Vue 响应式代理、函数、undefined 与循环引用都会让这一步失败。
 */
function sanitizeForWire(message: object): Record<string, unknown> | null {
  try {
    const text = JSON.stringify(message)
    if (text === undefined) {
      console.warn(`[transport] 消息顶层不可序列化，已跳过发送 kind=${String((message as { kind?: unknown }).kind)}`)
      return null
    }
    return JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    console.warn(`[transport] 消息无法序列化，已跳过发送 kind=${String((message as { kind?: unknown }).kind)} `
      + `err=${String(error).slice(0, 160)} at=${describeUnserializable(message)}`)
    return null
  }
}

/**
 * 所有 P2P 业务发送的统一出口：净化 + 超限分片。
 * 注意：血流房间的 authority 定向发送（结算帧最常从这里发出）此前直接 `room.send(packet, peer)`，
 * 绕过了分片层 → 终局帧静默丢失 → 客机判「房主无法恢复」整场中断（2026-09-10 线上验收实测）。
 */
export function sendChunked(room: VibeHubSDK.Room, message: object, to?: string): boolean {
  const wire = sanitizeForWire(message)
  if (!wire) return false
  const text = JSON.stringify(wire)
  const bytes = new TextEncoder().encode(text).length
  const parts = chunkEnvelope(text)
  if (parts.length) {
    if (TRANSPORT_DIAG) {
      console.log(`[transport] 大包分片 kind=${String(wire.kind)} bytes=${bytes} chunks=${parts.length} to=${to ?? 'all'}`)
    }
    for (const part of parts) { if (to) room.send(part, to); else room.send(part) }
    return true
  }
  if (TRANSPORT_DIAG && bytes > 2_000) {
    console.log(`[transport] 发送 kind=${String(wire.kind)} bytes=${bytes} to=${to ?? 'all'}`)
  }
  if (to) room.send(wire, to)
  else room.send(wire)
  return true
}

/** 分片重组缓冲（模块级）：传输层与血流房间**都**直接订阅 SDK 的 room.onMessage，
 *  两侧都必须能拿到重组结果，因此缓冲与结果缓存放在模块作用域。 */
const assemblies = new Map<string, { total: number; parts: Map<number, Uint8Array>; at: number }>()
const completedChunks = new Map<string, { value: unknown; at: number }>()

/**
 * 幂等拆包：非分片消息原样返回；分片未集齐返回 null；集齐（或已被另一侧重组过）返回重组结果。
 * 两个订阅者（传输层、血流房间）先后调用都能拿到同一个对象。
 */
export function unwrapChunk(message: unknown): unknown | null {
  const chunk = message as Partial<ChunkMail> | null
  if (!chunk || chunk.kind !== CHUNK_KIND || typeof chunk.data !== 'string'
    || typeof chunk.id !== 'string' || !Number.isInteger(chunk.index) || !Number.isInteger(chunk.total)) {
    return message
  }
  const cached = completedChunks.get(chunk.id)
  if (cached) return cached.value
  const entry = assemblies.get(chunk.id)
    ?? { total: chunk.total, parts: new Map<number, Uint8Array>(), at: Date.now() }
  if (!assemblies.has(chunk.id)) assemblies.set(chunk.id, entry)
  entry.parts.set(chunk.index, fromBase64(chunk.data))
  entry.at = Date.now()
  const now = Date.now()
  for (const [id, item] of assemblies) {
    if (now - item.at > CHUNK_ASSEMBLY_TTL_MS) assemblies.delete(id)
  }
  for (const [id, item] of completedChunks) {
    if (now - item.at > CHUNK_ASSEMBLY_TTL_MS) completedChunks.delete(id)
  }
  if (entry.parts.size < entry.total) return null
  assemblies.delete(chunk.id)
  const parts: Uint8Array[] = []
  let length = 0
  for (let index = 0; index < entry.total; index += 1) {
    const part = entry.parts.get(index)
    if (!part) return null
    parts.push(part)
    length += part.length
  }
  const joined = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(joined)) as unknown
    completedChunks.set(chunk.id, { value, at: Date.now() })
    return value
  } catch (error) {
    console.warn(`[transport] 分片重组失败 id=${chunk.id}: ${String(error).slice(0, 120)}`)
    return null
  }
}

export function createVibeRoomTransport({
  getRoom, onMessage, onHostConnectionLost,
}: VibeRoomTransportOptions) {
  const status = ref<RoomSocketStatus>('idle')
  const signalQuality = ref(0)
  let boundRoom: VibeHubSDK.Room | null = null
  // Room.onMessage/onPeer 不提供退订。代次令牌保证 close 后即使 reopen 同一个
  // Room 对象，旧监听器也永久失效，不会让第二场每条消息被重复处理。
  let bindingGeneration = 0
  // reconnecting 延迟确认：SDK 在直连失败自动切换 relay 时也会报 reconnecting
  // （连接其实还在，只是换传输路径）——延迟确认，期间恢复（connecting/join/收到消息）
  // 就不显示「网络断开，正在重连」横幅，避免误报。
  let reconnectingTimer: ReturnType<typeof setTimeout> | null = null
  // reconnecting 是 SDK 事件，不是轮询结果。给 relay 切换一次性宽限；宽限内没有
  // join/connecting/relay/message 恢复事件才完整重进。
  let hostRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  let hostRecoveryEscalated = false
  // SDK relay 事件可能先于 peers() 状态更新；单独记录，避免切路瞬间被判成断线。
  const relayPeers = new Set<string>()

  function clearReconnectingConfirm() {
    if (reconnectingTimer != null) {
      clearTimeout(reconnectingTimer)
      reconnectingTimer = null
    }
  }

  function clearHostRecovery() {
    if (hostRecoveryTimer != null) {
      clearTimeout(hostRecoveryTimer)
      hostRecoveryTimer = null
    }
  }

  function markHostInbound(room: VibeHubSDK.Room, fromPeerId?: string) {    if (room.peerId === room.hostId || !fromPeerId || fromPeerId !== room.hostId) return
    clearReconnectingConfirm()
    clearHostRecovery()
    hostRecoveryEscalated = false
    status.value = 'connected'
    updateSignalQuality()
  }


  function bind(room: VibeHubSDK.Room, signalOnly: boolean) {
    if (boundRoom === room) return
    boundRoom = room
    const generation = ++bindingGeneration
    hostRecoveryEscalated = false
    room.onMessage((message, fromPeerId) => {
      // room.leave() 后 SDK 仍可能把旧轮询队列里的 signal/message 投递出来；
      // 只允许当前绑定的 Room 进入业务层，避免刷新重进时旧房间的快照/请求污染新会话。
      if (boundRoom !== room || generation !== bindingGeneration) return
      markHostInbound(room, fromPeerId)
      // 收到房主消息即可证明当前可靠通道可用。
      clearReconnectingConfirm()
      // 大包分片：先重组，未集齐时不进业务层（分片不参与 kind 诊断/信号判定之外的逻辑）。
      const payload = unwrapChunk(message)
      if (payload === null) return
      // 诊断：只记录消息类型与来源方向，不记录牌面/内容/凭据。用于判定
      // 「房主已发出、客户端 SDK 未投递」与「客户端收到但被业务门禁丢弃」。
      if (!signalOnly) {
        const candidate = payload as { kind?: unknown; type?: unknown }
        const kind = typeof candidate.kind === 'string' ? candidate.kind
          : typeof candidate.type === 'string' ? candidate.type
            : `raw:${typeof payload}`
        const from = fromPeerId == null ? 'local' : fromPeerId === room.hostId ? 'host' : 'other'
        console.log(`[diag] transport-rx kind=${kind} from=${from} room=${room.roomId}`)
      }
      if (signalOnly) return // 房主：不转发业务消息（避免收到自己广播的回环）
      onMessage(payload, fromPeerId)
    })
    room.onPeer((event) => {
      if (boundRoom !== room || generation !== bindingGeneration) return
      // 只跟踪房主（hostId）的连接状态：其他玩家的掉线/抖动不应触发「网络断开，
      // 正在重连」横幅。error 事件无 id，直接忽略。
      if (event.type === 'error') return
      if (event.id !== room.hostId && event.id !== room.peerId) return
      if (event.type === 'reconnecting') {
        relayPeers.delete(event.id)
        // 延迟 2s 确认：relay 切换/短暂抖动会在 2s 内恢复（connecting/消息），不误报。
        if (reconnectingTimer == null) {
          reconnectingTimer = setTimeout(() => {
            reconnectingTimer = null
            if (boundRoom == null) return
            status.value = 'reconnecting'
          }, 2000)
        }
        if (room.peerId !== room.hostId && event.id === room.hostId && hostRecoveryTimer == null) {
          hostRecoveryTimer = setTimeout(() => {
            hostRecoveryTimer = null
            if (boundRoom !== room || hostRecoveryEscalated) return
            hostRecoveryEscalated = true
            console.warn('[transport] SDK 房主重连事件超时，升级为完整房间重进')
            onHostConnectionLost?.()
          }, 8000)
        }
      } else if (event.type === 'relay') {
        if (event.active) {
          // relay 是 SDK 的可用保底路径，不是掉线。直连切换 relay 期间可能没有
          // join/connecting 事件，因此这里也必须取消「正在重连」状态。
          clearReconnectingConfirm()
          clearHostRecovery()
          hostRecoveryEscalated = false
          relayPeers.add(event.id)
          status.value = 'connected'
          updateSignalQuality()
        } else {
          relayPeers.delete(event.id)
        }
      } else if (event.type === 'join' || event.type === 'connecting') {
        clearReconnectingConfirm()
        clearHostRecovery()
        hostRecoveryEscalated = false
        relayPeers.delete(event.id)
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
    const peerScore = Math.min(...peers.map((peer) => (
      relayPeers.has(peer.id) && peer.open ? 3 : scorePeer(peer)
    )))
    let rtt: number | null = null
    try {
      rtt = room.networkStats().quality.rttP95Ms
    } catch {
      // 旧 SDK 无 networkStats 时只使用 peer 连接状态。
    }
    const rttScore = rtt == null ? 3 : scoreFromRtt(rtt)
    signalQuality.value = Math.min(peerScore, rttScore)
  }

  function open(options: VibeRoomOpenOptions = {}) {
    const room = getRoom()
    if (!room) return
    bind(room, options.signalOnly ?? false)
    status.value = 'connected'
    updateSignalQuality()
  }

  function confirmSession() {
    // SDK 自动重连，无需像 WebSocket 那样显式重置重连计数；占位对齐 roomSocket 接口。
  }

  function send(message: Record<string, unknown>): boolean {
    const room = getRoom()
    if (!room) return false
    try {
      sendChunked(room, message)
      updateSignalQuality()
      return true
    } catch (error) {
      console.warn('[transport] VibeHub 可靠发送失败，升级为完整房间重进:', error)
      status.value = 'reconnecting'
      signalQuality.value = 0
      if (room.peerId !== room.hostId && !hostRecoveryEscalated) {
        hostRecoveryEscalated = true
        onHostConnectionLost?.()
      }
      return false
    }
  }

  function close() {
    // 不调用 room.leave()：离开房间由 vibeRoomSession.clearSession() 统一负责，
    // 避免重复 leave 在 SDK 仍协商 relay 时关闭连接、触发 setRemoteDescription 竞态。
    clearReconnectingConfirm()
    clearHostRecovery()
    bindingGeneration += 1
    boundRoom = null
    relayPeers.clear()
    status.value = 'idle'
    signalQuality.value = 0
    hostRecoveryEscalated = false
  }

  return { status, signalQuality, open, confirmSession, send, close }
}
