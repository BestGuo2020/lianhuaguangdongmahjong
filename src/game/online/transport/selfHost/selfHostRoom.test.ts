// 自托管房间的 host-topology 消息路由 / peer 事件 / announce 单测。
// 用可注入的 peerConnectionFactory 替换真实 RTCPeerConnection，配对两端 DataChannel，
// 在不依赖浏览器的前提下验证「客户端↔房主」的真实连接建立与消息投递时序。
import { describe, expect, it } from 'vitest'
import { createSelfHostRoom, selectedCandidateIsRelay } from './selfHostRoom'
import type { SignalingConnection, SignalingEvent } from './selfHostSignaling'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function peerIdOf(event: VibeHubSDK.PeerEvent): string {
  return 'id' in event ? event.id : ''
}

// ── 假信令：send(signal) 立即投递给已 link 的对端 ──
interface FakeSignaling {
  connection: SignalingConnection
  sent: Array<Record<string, unknown>>
  emit(event: SignalingEvent): void
  routeTo(peerId: string, other: FakeSignaling): void
}

function createFakeSignaling(peerId: string, hostId: string): FakeSignaling {
  const handlers = new Set<(event: SignalingEvent) => void>()
  const sent: Array<Record<string, unknown>> = []
  const routes = new Map<string, FakeSignaling>()
  const connection = {
    roomId: 'ROOM',
    peerId,
    hostId,
    send(message: Record<string, unknown>) {
      sent.push(message)
      if (message.type === 'signal') {
        routes.get(String(message.to))?.emit({ type: 'signal', from: peerId, data: message.data })
      }
    },
    onEvent(callback: (event: SignalingEvent) => void) {
      handlers.add(callback)
      return () => { handlers.delete(callback) }
    },
    onClose() { return () => {} },
    requestMeta: async () => null,
    close() {},
  } as SignalingConnection
  return {
    connection,
    sent,
    emit(event) { handlers.forEach((handler) => handler(event)) },
    routeTo(peerId, other) { routes.set(peerId, other) },
  }
}

// ── 假 RTC：DataChannel 两端配对，send 投递给对端 ──
class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  peer: FakeDataChannel | null = null
  sent: string[] = []

  send(data: string) {
    this.sent.push(data)
    this.peer?.deliver(data)
  }

  deliver(data: string) {
    if (this.readyState === 'open') this.onmessage?.({ data })
  }

  open() {
    this.readyState = 'open'
    this.onopen?.()
  }

  close() {
    this.readyState = 'closed'
    this.onclose?.()
  }
}

class FakePeerConnection {
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null
  onicecandidate: ((event: { candidate: { toJSON(): unknown } | null }) => void) | null = null
  localDescription: { type: string; sdp: string } | null = null
  channel: FakeDataChannel | null = null
  incomingChannel: FakeDataChannel | null = null
  closed = false

  createDataChannel(): FakeDataChannel {
    // 复用 wireChannels 里预连线的 channel，避免覆盖测试里的配对关系。
    if (!this.channel) this.channel = new FakeDataChannel()
    return this.channel
  }

  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' } }

  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' } }

  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description
  }

  async setRemoteDescription(_description: { type: string; sdp: string }) {
    // 模拟远端 DataChannel 随 SDP 到达（offerer 创建的 channel 在 answerer 侧 ondatachannel）
    if (this.incomingChannel) this.ondatachannel?.({ channel: this.incomingChannel })
  }

  async addIceCandidate(_candidate: unknown) { /* noop */ }

  close() { this.closed = true }
}

function wireChannels(clientPc: FakePeerConnection, hostPc: FakePeerConnection) {
  const clientChannel = new FakeDataChannel()
  const hostChannel = new FakeDataChannel()
  clientChannel.peer = hostChannel
  hostChannel.peer = clientChannel
  clientPc.channel = clientChannel
  hostPc.incomingChannel = hostChannel
  return { clientChannel, hostChannel }
}

function buildPair() {
  const hostSig = createFakeSignaling('host-peer', 'host-peer')
  const clientSig = createFakeSignaling('client-peer', 'host-peer')
  hostSig.routeTo('client-peer', clientSig)
  clientSig.routeTo('host-peer', hostSig)

  const hostPc = new FakePeerConnection()
  const clientPc = new FakePeerConnection()
  const { clientChannel, hostChannel } = wireChannels(clientPc, hostPc)

  const hostRoom = createSelfHostRoom({
    signaling: hostSig.connection,
    iceServers: [],
    peerConnectionFactory: () => hostPc as unknown as RTCPeerConnection,
  })
  const clientRoom = createSelfHostRoom({
    signaling: clientSig.connection,
    iceServers: [],
    peerConnectionFactory: () => clientPc as unknown as RTCPeerConnection,
  })

  return { hostRoom, clientRoom, hostSig, clientSig, clientChannel, hostChannel }
}

/** 房主 + 两个客户端：验证房主把 A 的广播转发给 B（并保留 A 的 fromPeerId）。 */
function buildTrio() {
  const hostSig = createFakeSignaling('host-peer', 'host-peer')
  const aSig = createFakeSignaling('peer-a', 'host-peer')
  const bSig = createFakeSignaling('peer-b', 'host-peer')
  hostSig.routeTo('peer-a', aSig)
  hostSig.routeTo('peer-b', bSig)
  aSig.routeTo('host-peer', hostSig)
  bSig.routeTo('host-peer', hostSig)

  const hostPcA = new FakePeerConnection()
  const hostPcB = new FakePeerConnection()
  const aPc = new FakePeerConnection()
  const bPc = new FakePeerConnection()
  const { clientChannel: aChannel, hostChannel: hostAChannel } = wireChannels(aPc, hostPcA)
  const { clientChannel: bChannel, hostChannel: hostBChannel } = wireChannels(bPc, hostPcB)

  const hostPcs = [hostPcA, hostPcB]
  let hostPcIndex = 0
  const hostRoom = createSelfHostRoom({
    signaling: hostSig.connection,
    iceServers: [],
    peerConnectionFactory: () => hostPcs[hostPcIndex++] as unknown as RTCPeerConnection,
  })
  const aRoom = createSelfHostRoom({
    signaling: aSig.connection,
    iceServers: [],
    peerConnectionFactory: () => aPc as unknown as RTCPeerConnection,
  })
  const bRoom = createSelfHostRoom({
    signaling: bSig.connection,
    iceServers: [],
    peerConnectionFactory: () => bPc as unknown as RTCPeerConnection,
  })

  return { hostRoom, aRoom, bRoom, aChannel, bChannel, hostAChannel, hostBChannel }
}

describe('createSelfHostRoom', () => {
  it('isHost/hostId 与信令一致', () => {
    const { hostRoom, clientRoom } = buildPair()
    expect(hostRoom.isHost).toBe(true)
    expect(clientRoom.isHost).toBe(false)
    expect(clientRoom.hostId).toBe('host-peer')
  })

  it('客户端 offer → 房主 answer 完成握手', async () => {
    const { clientSig, hostSig } = buildPair()
    await flush()
    expect(clientSig.sent.some((m) => m.type === 'signal' && (m.data as { kind: string }).kind === 'offer')).toBe(true)
    expect(hostSig.sent.some((m) => m.type === 'signal' && (m.data as { kind: string }).kind === 'answer')).toBe(true)
  })

  it('通道打开后双方各收到 join 事件，peers() 列出对端', async () => {
    const { hostRoom, clientRoom, clientChannel, hostChannel } = buildPair()
    await flush()
    const hostEvents: Array<{ type: string; id: string }> = []
    const clientEvents: Array<{ type: string; id: string }> = []
    hostRoom.onPeer((event) => hostEvents.push({ type: event.type, id: peerIdOf(event) }))
    clientRoom.onPeer((event) => clientEvents.push({ type: event.type, id: peerIdOf(event) }))

    clientChannel.open()
    hostChannel.open()

    expect(hostEvents).toContainEqual({ type: 'join', id: 'client-peer' })
    expect(clientEvents).toContainEqual({ type: 'join', id: 'host-peer' })
    expect(hostRoom.peers().map((p) => p.id)).toEqual(['client-peer'])
    expect(clientRoom.peers().map((p) => p.id)).toEqual(['host-peer'])
  })

  it('客户端广播 → 房主收到；房主广播/定向 → 客户端收到', async () => {
    const { hostRoom, clientRoom, clientChannel, hostChannel } = buildPair()
    await flush()
    clientChannel.open()
    hostChannel.open()

    const hostInbox: Array<{ message: unknown; from: string }> = []
    const clientInbox: Array<{ message: unknown; from: string }> = []
    hostRoom.onMessage((message, from) => hostInbox.push({ message, from }))
    clientRoom.onMessage((message, from) => clientInbox.push({ message, from }))

    clientRoom.send({ type: 'lobby_hello' })
    expect(hostInbox).toEqual([{ message: { type: 'lobby_hello' }, from: 'client-peer' }])

    hostRoom.send({ type: 'lobby_roster' })
    expect(clientInbox).toEqual([{ message: { type: 'lobby_roster' }, from: 'host-peer' }])

    hostRoom.send({ type: 'lobby_seat_token', seat: 1, token: 't' }, 'client-peer')
    expect(clientInbox[1]).toEqual({
      message: { type: 'lobby_seat_token', seat: 1, token: 't' },
      from: 'host-peer',
    })
  })

  it('通道关闭 → 双方进入 reconnecting（等待自动重连，而非立即 leave）', async () => {
    const { hostRoom, clientRoom, clientChannel, hostChannel } = buildPair()
    await flush()
    clientChannel.open()
    hostChannel.open()
    const hostEvents: Array<{ type: string; id: string }> = []
    const clientEvents: Array<{ type: string; id: string }> = []
    hostRoom.onPeer((event) => hostEvents.push({ type: event.type, id: peerIdOf(event) }))
    clientRoom.onPeer((event) => clientEvents.push({ type: event.type, id: peerIdOf(event) }))

    hostChannel.close()
    clientChannel.close()

    expect(hostEvents).toContainEqual({ type: 'reconnecting', id: 'client-peer' })
    expect(clientEvents).toContainEqual({ type: 'reconnecting', id: 'host-peer' })
    expect(hostRoom.peers()).toEqual([])
    // 收尾，避免后台重连循环残留
    hostRoom.leave()
    clientRoom.leave()
  })

  it('客户端通道关闭后自动重连：换新 generation 重新 offer', async () => {
    const sig = createFakeSignaling('client-peer', 'host-peer')
    const pcs: FakePeerConnection[] = []
    const room = createSelfHostRoom({
      signaling: sig.connection,
      iceServers: [],
      peerConnectionFactory: () => {
        const pc = new FakePeerConnection()
        pcs.push(pc)
        return pc as unknown as RTCPeerConnection
      },
      pathPollIntervalMs: 0,
    })
    await flush()
    expect(pcs.length).toBe(1)
    const offerGens = () => sig.sent
      .filter((m) => m.type === 'signal' && (m.data as { kind?: string }).kind === 'offer')
      .map((m) => (m.data as { generation?: number }).generation)

    // 初始 offer generation 0
    expect(offerGens()).toContain(0)

    // 打开初始通道，再关闭 → 触发重连
    pcs[0].channel!.open()
    pcs[0].channel!.close()
    await flush()

    // 重连发出 generation 1 的 offer，且创建了新的 RTCPeerConnection
    expect(pcs.length).toBe(2)
    expect(offerGens()).toContain(1)
    room.leave()
  })

  it('房主 announce 携带房间元数据', async () => {
    const { hostRoom, hostSig } = buildPair()
    await hostRoom.announce({ mode: 'east', rulesetId: 'lotus-classic' })
    const announce = hostSig.sent.find((m) => m.type === 'announce')
    expect(announce?.meta).toMatchObject({ roomId: 'ROOM', mode: 'east', rulesetId: 'lotus-classic', hostPeerId: 'host-peer' })
  })

  it('selectedCandidateIsRelay 识别选中候选类型', () => {
    expect(selectedCandidateIsRelay([
      { type: 'candidate-pair', selected: true, localCandidateId: 'lc1' },
      { type: 'local-candidate', id: 'lc1', candidateType: 'host' },
    ])).toBe(false)
    expect(selectedCandidateIsRelay([
      { type: 'candidate-pair', selected: true, localCandidateId: 'lc2' },
      { type: 'local-candidate', id: 'lc2', candidateType: 'relay' },
    ])).toBe(true)
    // nominated+succeeded 也算选中
    expect(selectedCandidateIsRelay([
      { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc3' },
      { type: 'local-candidate', id: 'lc3', candidateType: 'relay' },
    ])).toBe(true)
  })

  it('simulateRelaySwitch 注入 P2P→Relay→回 P2P 事件序列并更新 peers/networkStats', async () => {
    const { hostRoom, clientChannel, hostChannel } = buildPair()
    await flush()
    clientChannel.open()
    hostChannel.open()

    const hostEvents: Array<{ type: string; id: string; active?: boolean }> = []
    hostRoom.onPeer((event) => hostEvents.push({
      type: event.type,
      id: peerIdOf(event),
      ...('active' in event ? { active: event.active } : {}),
    }))

    const withSim = hostRoom as VibeHubSDK.Room & { simulateRelaySwitch(afterMs: number, durationMs?: number): void }
    withSim.simulateRelaySwitch(0, 20)

    // 立即：reconnecting → relay active
    expect(hostEvents).toContainEqual({ type: 'reconnecting', id: 'client-peer' })
    expect(hostEvents).toContainEqual({ type: 'relay', id: 'client-peer', active: true })
    expect(hostRoom.peers()[0]?.relay).toBe(true)
    expect((hostRoom.networkStats() as VibeHubSDK.NetworkStats).state).toBe('relay')

    // duration 过后：relay 停 + connecting
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(hostEvents).toContainEqual({ type: 'relay', id: 'client-peer', active: false })
    expect(hostEvents).toContainEqual({ type: 'connecting', id: 'client-peer' })
    expect(hostRoom.peers()[0]?.relay).toBe(false)
    expect((hostRoom.networkStats() as VibeHubSDK.NetworkStats).state).toBe('direct')
  })

  it('房主把客户端 A 的广播转发给客户端 B，并保留 A 的 fromPeerId', async () => {
    const { aRoom, bRoom, aChannel, bChannel, hostAChannel, hostBChannel } = buildTrio()
    await flush()
    aChannel.open()
    hostAChannel.open()
    bChannel.open()
    hostBChannel.open()

    const bInbox: Array<{ message: unknown; from: string }> = []
    bRoom.onMessage((message, from) => bInbox.push({ message, from }))

    aRoom.send({ type: 'shuffle_commit', roundId: 'r1', seat: 1, commitment: 'c1' })

    expect(bInbox).toEqual([{
      message: { type: 'shuffle_commit', roundId: 'r1', seat: 1, commitment: 'c1' },
      from: 'peer-a',
    }])
  })
})
