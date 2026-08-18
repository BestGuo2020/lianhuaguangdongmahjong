// 自托管 WebRTC 房间：实现与 VibeHubSDK.Room 同形的 host-topology P2P 房间。
// 房主 ↔ 每个客户端各一条 RTCPeerConnection + 可靠有序 DataChannel（房主权威，
// 客户端只连房主）。信令只做握手；业务消息走 DataChannel。
//
// 语义对齐真实 SDK：
// - onMessage/onPeer 是 push 多监听、无退订，每个 handler 收到每条消息/事件。
// - room.send(msg) 广播（房主→所有客户端；客户端→房主），不含自己。
// - room.send(msg, peerId) 定向（房主→某客户端；客户端定向只认房主）。
// - peers() 返回已打开的连接（不含自己）；hostId 在本次加入期间固定。
//
// 自动重连 + relay 兜底（「SDK 式 relay 路径管理」的实用档）：
// - 客户端（offerer）在 DataChannel 关闭 / ICE failed / ICE 长时间 disconnected 时，
//   自动重连：第 1 次正常 ICE（直连优先），失败后第 2 次起强制 relay（iceTransportPolicy='relay'）。
// - 房主在客户端断线时发 reconnecting（不立刻 leave），等客户端用新 generation 重新 offer，
//   替换旧连接后发 join；「真正放弃」交给应用层已有的掉线宽限/AI 接管计时器。
// - 信令 offer/answer/ice 带 generation，避免旧连接迟到的信号污染新连接。
// - 路径探测：轮询 getStats() 读选中候选类型，peers().relay / networkStats().state 反映真实路径。
import type { SignalingConnection } from './selfHostSignaling'

export interface SelfHostRoomOptions {
  signaling: SignalingConnection
  iceServers: RTCIceServer[]
  /** 强制只走 TURN relay（iceTransportPolicy='relay'）。 */
  forceRelay?: boolean
  /** 测试注入：替换 RTCPeerConnection 构造，默认用浏览器实现。 */
  peerConnectionFactory?: () => RTCPeerConnection
  /** 路径探测轮询间隔（ms）；0 关闭真实 relay 探测。默认 2000。 */
  pathPollIntervalMs?: number
}

type SignalPayload =
  | { kind: 'offer'; generation: number; sdp: RTCSessionDescriptionInit }
  | { kind: 'answer'; generation: number; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; generation: number; candidate: RTCIceCandidateInit | null }

interface PeerLink {
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  open: boolean
  /** 当前连接的代号；每次重连（换新 RTCPeerConnection）递增。 */
  generation: number
  /** getStats() 探测到的真实路径是否走 TURN relay。 */
  realRelay: boolean
  /** 测试注入的路径覆盖；null 表示未注入、用 realRelay。 */
  simRelay: boolean | null
  /** 最近一次对外上报的 relay 状态（用于探测切换边沿）。 */
  reportedRelay: boolean
  /** ICE 是否处于断开/失败（重连中）。 */
  reconnecting: boolean
  /** 本次连接已放弃（重连次数耗尽），不再尝试。 */
  gone: boolean
  reconnectAttempts: number
  /** 重连循环是否正在运行（防并发重连）。 */
  reconnectRunning: boolean
  /** 等待「新 DataChannel open」的 resolver（重连用）。 */
  resolveOpen: (() => void) | null
}

const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_ATTEMPT_TIMEOUT_MS = 8000
const RECONNECT_BACKOFF_MS = [0, 2000, 4000]
const ICE_DISCONNECTED_GRACE_MS = 2000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从 getStats() 报告里判断「选中候选对」的本地候选是否为 relay。纯函数、可单测。 */
export function selectedCandidateIsRelay(
  reports: Iterable<{ type: string; [key: string]: unknown }>,
): boolean {
  let selectedPair: { localCandidateId?: unknown } | null = null
  const localCandidates = new Map<string, { candidateType?: unknown }>()
  for (const report of reports) {
    if (report.type === 'candidate-pair') {
      const pair = report as { selected?: unknown; nominated?: unknown; state?: unknown; localCandidateId?: unknown }
      const isSelected = pair.selected === true
        || (pair.nominated === true && pair.state === 'succeeded')
      if (isSelected && (!selectedPair || pair.selected === true)) {
        selectedPair = { localCandidateId: pair.localCandidateId }
      }
    } else if (report.type === 'local-candidate') {
      const candidate = report as { id?: unknown; candidateType?: unknown }
      if (typeof candidate.id === 'string') {
        localCandidates.set(candidate.id, { candidateType: candidate.candidateType })
      }
    }
  }
  if (!selectedPair || typeof selectedPair.localCandidateId !== 'string') return false
  return localCandidates.get(selectedPair.localCandidateId)?.candidateType === 'relay'
}

export function createSelfHostRoom(options: SelfHostRoomOptions): VibeHubSDK.Room {
  const {
    signaling,
    iceServers,
    forceRelay = false,
    pathPollIntervalMs = 2000,
  } = options
  const isHost = signaling.peerId === signaling.hostId
  const messageHandlers: Array<(message: unknown, fromPeerId: string) => void> = []
  const peerHandlers: Array<(event: VibeHubSDK.PeerEvent) => void> = []
  const links = new Map<string, PeerLink>()
  const unsubscribes: Array<() => void> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let pathTimer: ReturnType<typeof setInterval> | null = null
  let left = false

  const emitPeer = (event: VibeHubSDK.PeerEvent) => {
    if (left) return
    peerHandlers.forEach((handler) => handler(event))
  }
  const emitMessage = (message: unknown, fromPeerId: string) => {
    if (left) return
    messageHandlers.forEach((handler) => handler(message, fromPeerId))
  }

  function makePeerInfo(id: string, link: PeerLink): VibeHubSDK.PeerInfo {
    return {
      id,
      open: true,
      latency: 0,
      jitter: 0,
      relay: link.simRelay ?? link.realRelay,
      realtime: true,
      reconnecting: link.reconnecting,
    }
  }

  function effectiveRelay(link: PeerLink): boolean {
    return link.simRelay ?? link.realRelay
  }

  function syncPath(peerId: string, link: PeerLink) {
    if (left) return
    const relay = effectiveRelay(link)
    if (relay === link.reportedRelay) return
    link.reportedRelay = relay
    emitPeer({ type: 'relay', id: peerId, active: relay })
    if (relay) link.reconnecting = false
  }

  function makePeerLink(pc: RTCPeerConnection, generation = 0): PeerLink {
    return {
      pc, channel: null, open: false, generation,
      realRelay: false, simRelay: null, reportedRelay: false, reconnecting: false,
      gone: false, reconnectAttempts: 0, reconnectRunning: false, resolveOpen: null,
    }
  }

  /** 摘除旧连接的事件回调并关闭（用于重连替换，避免 onclose 再次触发重连）。 */
  function detachLink(link: PeerLink) {
    if (link.channel) {
      link.channel.onopen = null
      link.channel.onmessage = null
      link.channel.onclose = null
      link.channel.onerror = null
    }
    try { link.channel?.close() } catch { /* noop */ }
    try { link.pc.close() } catch { /* noop */ }
  }

  function dropLink(peerId: string) {
    const link = links.get(peerId)
    if (!link) return
    links.delete(peerId)
    link.open = false
    link.gone = true
    detachLink(link)
  }

  function createPeerConnection(forceRelayOverride?: boolean): RTCPeerConnection {
    if (options.peerConnectionFactory) return options.peerConnectionFactory()
    return new RTCPeerConnection({
      iceServers,
      ...(forceRelay || forceRelayOverride ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {}),
    })
  }

  function waitForOpen(link: PeerLink, timeoutMs: number): Promise<boolean> {
    if (link.open) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        link.resolveOpen = null
        resolve(false)
      }, timeoutMs)
      link.resolveOpen = () => {
        clearTimeout(timer)
        link.resolveOpen = null
        resolve(true)
      }
    })
  }

  /** 监听 ICE 状态：断开/失败 → reconnecting（客户端再触发重连）。 */
  function attachIceWatcher(peerId: string, link: PeerLink) {
    link.pc.oniceconnectionstatechange = () => {
      if (left || link.gone) return
      const state = link.pc.iceConnectionState
      if (state === 'disconnected') {
        if (!link.reconnecting) {
          link.reconnecting = true
          emitPeer({ type: 'reconnecting', id: peerId })
        }
        if (!isHost) scheduleReconnect(peerId, link, ICE_DISCONNECTED_GRACE_MS)
      } else if (state === 'failed') {
        if (!link.reconnecting) {
          link.reconnecting = true
          emitPeer({ type: 'reconnecting', id: peerId })
        }
        if (!isHost) scheduleReconnect(peerId, link, 0)
      } else if (state === 'connected' || state === 'completed') {
        if (link.reconnecting) {
          link.reconnecting = false
          emitPeer({ type: 'connecting', id: peerId })
        }
      }
    }
  }

  /** 房主转发某客户端的广播给其余客户端（不含发送者）。 */
  function relayToOtherPeers(fromPeerId: string, message: unknown) {
    if (left) return
    const payload = JSON.stringify({ __selfhost_relay: true, from: fromPeerId, payload: message })
    for (const [id, link] of links) {
      if (id === fromPeerId) continue
      if (link.channel && link.channel.readyState === 'open') link.channel.send(payload)
    }
  }

  /** 挂接一条 DataChannel：open/close → join/reconnecting 事件，message → 业务回调。 */
  function attachChannel(peerId: string, channel: RTCDataChannel) {
    channel.onopen = () => {
      const link = links.get(peerId)
      if (!link || link.open) return
      link.open = true
      link.resolveOpen?.()
      if (link.reconnecting) {
        link.reconnecting = false
        emitPeer({ type: 'connecting', id: peerId })
      }
      emitPeer({ type: 'join', id: peerId })
    }
    channel.onmessage = (event) => {
      let raw: unknown
      try { raw = JSON.parse(String(event.data)) } catch { return }
      const relayed = raw as { __selfhost_relay?: unknown; from?: unknown; payload?: unknown } | null
      if (relayed && typeof relayed === 'object' && relayed.__selfhost_relay === true
        && typeof relayed.from === 'string' && 'payload' in relayed) {
        emitMessage(relayed.payload, relayed.from)
        return
      }
      emitMessage(raw, peerId)
      if (isHost) relayToOtherPeers(peerId, raw)
    }
    channel.onclose = () => {
      const link = links.get(peerId)
      if (!link || left || link.gone) return
      link.open = false
      if (!link.reconnecting) {
        link.reconnecting = true
        emitPeer({ type: 'reconnecting', id: peerId })
      }
      // 客户端主动重连；房主等待新的 offer 到来（应用层的掉线宽限负责真正放弃）。
      if (!isHost) scheduleReconnect(peerId, link, 0)
    }
    channel.onerror = () => { /* onclose 兜底 */ }
    if (channel.readyState === 'open') {
      const link = links.get(peerId)
      if (link && !link.open) {
        link.open = true
        link.resolveOpen?.()
        emitPeer({ type: 'join', id: peerId })
      }
    }
  }

  /** 客户端（offerer）：用 link.pc 发起/重连 offer。pc 由调用方先创建好。 */
  function wireOffer(peerId: string, link: PeerLink) {
    attachIceWatcher(peerId, link)
    link.pc.onicecandidate = (event) => {
      if (event.candidate) {
        signaling.send({ type: 'signal', to: peerId, data: { kind: 'ice', generation: link.generation, candidate: event.candidate.toJSON() } })
      }
    }
    const channel = link.pc.createDataChannel('reliable', { ordered: true })
    link.channel = channel
    attachChannel(peerId, channel)
    void (async () => {
      try {
        const offer = await link.pc.createOffer()
        await link.pc.setLocalDescription(offer)
        signaling.send({ type: 'signal', to: peerId, data: { kind: 'offer', generation: link.generation, sdp: offer } })
      } catch (error) {
        console.warn('[selfHost][client] 发起 offer 失败', error)
      }
    })()
  }

  function scheduleReconnect(peerId: string, link: PeerLink, afterMs: number) {
    const run = () => {
      if (left || link.gone || link.reconnectRunning) return
      if (!link.reconnecting) return
      void reconnectLoop(peerId, link)
    }
    if (afterMs <= 0) run()
    else {
      const timer = setTimeout(() => { timers.delete(timer); run() }, afterMs)
      timers.add(timer)
    }
  }

  async function reconnectLoop(peerId: string, link: PeerLink) {
    if (left || link.gone || link.reconnectRunning) return
    link.reconnectRunning = true
    try {
      link.reconnectAttempts = 0
      while (!left && !link.gone && !link.open) {
        link.reconnectAttempts += 1
        if (link.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          link.gone = true
          break
        }
        detachLink(link)
        link.generation += 1
        link.pc = createPeerConnection(link.reconnectAttempts > 1)
        wireOffer(peerId, link)
        const opened = await waitForOpen(link, RECONNECT_ATTEMPT_TIMEOUT_MS)
        if (opened) break
        await sleep(RECONNECT_BACKOFF_MS[Math.min(link.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1)])
      }
      link.reconnectAttempts = 0
      if (link.gone) {
        link.reconnecting = false
        dropLink(peerId)
        emitPeer({ type: 'leave', id: peerId })
      }
    } finally {
      link.reconnectRunning = false
    }
  }

  // ── 房主侧：应答客户端 offer，按 peerId 维护连接 ──
  if (isHost) {
    unsubscribes.push(signaling.onEvent((event) => {
      if (left) return
      if (event.type === 'signal') {
        void handleHostSignal(event.from, event.data as SignalPayload)
      } else if (event.type === 'peer_leave') {
        dropLink(event.peerId)
        emitPeer({ type: 'leave', id: event.peerId })
      }
    }))

    async function handleHostSignal(from: string, payload: SignalPayload) {
      if (left) return
      if (payload.kind === 'offer') {
        let link = links.get(from)
        if (link && link.generation !== payload.generation) {
          // 重连：同一 peerId 的新连接，替换旧连接。
          detachLink(link)
          links.delete(from)
          link = undefined
        }
        if (!link) {
          link = makePeerLink(createPeerConnection(), payload.generation)
          links.set(from, link)
          attachIceWatcher(from, link)
          link.pc.ondatachannel = (event) => {
            link!.channel = event.channel
            attachChannel(from, event.channel)
          }
          link.pc.onicecandidate = (event) => {
            if (event.candidate) {
              signaling.send({ type: 'signal', to: from, data: { kind: 'ice', generation: link!.generation, candidate: event.candidate.toJSON() } })
            }
          }
        }
        try {
          await link.pc.setRemoteDescription(payload.sdp)
          const answer = await link.pc.createAnswer()
          await link.pc.setLocalDescription(answer)
          signaling.send({ type: 'signal', to: from, data: { kind: 'answer', generation: link.generation, sdp: answer } })
        } catch (error) {
          dropLink(from)
          console.warn('[selfHost][host] 应答 offer 失败', from, error)
        }
      } else if (payload.kind === 'ice' && payload.candidate) {
        const link = links.get(from)
        if (link && link.generation === payload.generation) {
          try { await link.pc.addIceCandidate(payload.candidate) } catch { /* 迟到 candidate 忽略 */ }
        }
      }
    }
  } else {
    // ── 客户端侧：向房主发起 offer ──
    const hostId = signaling.hostId
    const link = makePeerLink(createPeerConnection())
    links.set(hostId, link)
    unsubscribes.push(signaling.onEvent((event) => {
      if (left) return
      if (event.type === 'signal') {
        const payload = event.data as SignalPayload
        const current = links.get(hostId)
        if (!current || payload.generation !== current.generation) return
        if (payload.kind === 'answer') {
          void current.pc.setRemoteDescription(payload.sdp).catch((error) => {
            console.warn('[selfHost][client] setRemoteDescription 失败', error)
          })
        } else if (payload.kind === 'ice' && payload.candidate) {
          void current.pc.addIceCandidate(payload.candidate).catch(() => { /* 迟到 candidate 忽略 */ })
        }
      } else if (event.type === 'peer_leave' && event.peerId === hostId) {
        dropLink(hostId)
        emitPeer({ type: 'leave', id: hostId })
      }
    }))
    wireOffer(hostId, link)
  }

  // ── 真实路径探测：轮询 getStats() 读选中候选类型 ──
  async function pollPaths() {
    if (left) return
    for (const [peerId, link] of links) {
      if (!link.open || link.simRelay !== null) continue
      try {
        const stats = await link.pc.getStats()
        link.realRelay = selectedCandidateIsRelay(stats as Iterable<{ type: string; [key: string]: unknown }>)
      } catch {
        // 探测失败保持上一次结果，不误报切换。
      }
      syncPath(peerId, link)
    }
  }
  if (pathPollIntervalMs > 0) {
    pathTimer = setInterval(() => { void pollPaths() }, pathPollIntervalMs)
  }

  /** 测试钩子：注入一次 P2P → Relay →（可选）回 P2P 的切换。 */
  function simulateRelaySwitch(afterMs: number, durationMs = 0) {
    const run = () => {
      if (left) return
      const openIds = [...links.entries()].filter(([, link]) => link.open).map(([id]) => id)
      for (const id of openIds) {
        const link = links.get(id)!
        link.reconnecting = true
        emitPeer({ type: 'reconnecting', id })
      }
      for (const id of openIds) {
        const link = links.get(id)!
        link.reconnecting = false
        link.simRelay = true
        syncPath(id, link)
      }
      if (durationMs > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (left) return
          for (const id of openIds) {
            const link = links.get(id)
            if (!link) continue
            link.simRelay = null
            syncPath(id, link)
            emitPeer({ type: 'connecting', id })
          }
        }, durationMs)
        timers.add(timer)
      }
    }
    const delay = Math.max(0, afterMs)
    if (delay === 0) run()
    else {
      const timer = setTimeout(() => { timers.delete(timer); run() }, delay)
      timers.add(timer)
    }
  }

  function deliver(message: unknown, toPeerId?: string) {
    if (left) return
    const payload = JSON.stringify(message)
    if (toPeerId != null) {
      const link = links.get(toPeerId)
      if (link?.channel && link.channel.readyState === 'open') link.channel.send(payload)
      return
    }
    for (const link of links.values()) {
      if (link.channel && link.channel.readyState === 'open') link.channel.send(payload)
    }
  }

  const room = {
    roomId: signaling.roomId,
    peerId: signaling.peerId,
    topology: 'host',
    isHost,
    hostId: signaling.hostId,
    data: {} as VibeHubSDK.DataStore,
    state: {} as VibeHubSDK.StateManager,
    sync: {} as VibeHubSDK.SnapshotInterpolator,
    onMessage(callback: (message: unknown, fromPeerId: string) => void) {
      messageHandlers.push(callback)
      return room
    },
    onPeer(callback: (event: VibeHubSDK.PeerEvent) => void) {
      peerHandlers.push(callback)
      return room
    },
    send(message: unknown, toPeerId?: string) {
      deliver(message, toPeerId)
    },
    sendRealtime(message: unknown, toPeerId?: string) {
      deliver(message, toPeerId)
    },
    peers() {
      return [...links.entries()]
        .filter(([, link]) => link.open)
        .map(([id, link]) => makePeerInfo(id, link))
    },
    networkStats() {
      const open = [...links.values()].filter((link) => link.open)
      const anyRecovering = open.some((link) => link.reconnecting)
      const anyRelay = open.some((link) => effectiveRelay(link))
      return { state: anyRecovering ? 'recovering' : anyRelay ? 'relay' : 'direct' } as VibeHubSDK.NetworkStats
    },
    async diagnostics() {
      return { capturedAt: new Date().toISOString() } as VibeHubSDK.RoomDiagnostics
    },
    reconnect() { /* 由内部自动重连接管 */ },
    async announce(metadata = {}) {
      const meta: VibeHubSDK.RoomMetadata = {
        roomId: signaling.roomId,
        players: links.size + 1,
        hostPeerId: signaling.peerId,
        ...metadata,
      }
      signaling.send({ type: 'announce', meta })
      return { ok: true }
    },
    async close() {
      room.leave()
      return { ok: true }
    },
    leave() {
      if (left) return
      left = true
      if (pathTimer != null) {
        clearInterval(pathTimer)
        pathTimer = null
      }
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
      for (const peerId of [...links.keys()]) dropLink(peerId)
      links.clear()
      unsubscribes.forEach((unsubscribe) => unsubscribe())
      unsubscribes.length = 0
      signaling.close()
    },
    // 测试/联调专用扩展（非 SDK 类型）。
    simulateRelaySwitch,
  }

  return room as VibeHubSDK.Room & { simulateRelaySwitch(afterMs: number, durationMs?: number): void }
}
