declare namespace VibeHubSDK {
  interface User {
    id: string;
    name: string | null;
    image: string | null;
  }

  interface SetOptions {
    /** 生存时间（秒）；0 表示永久。room 数据默认 86400 秒。 */
    ttl?: number;
  }

  interface DataStore {
    set<T>(key: string, value: T, options?: SetOptions): Promise<{ ok: true }>;
    set<T>(
      key: string,
      value: T,
      namespace: string,
      options?: SetOptions,
    ): Promise<{ ok: true }>;
    get<T>(key: string, namespace?: string): Promise<T | null>;
    get<T>(keys: string[], namespace?: string): Promise<Record<string, T>>;
    all<T>(namespace?: string): Promise<Record<string, T>>;
    remove(key: string, namespace?: string): Promise<{ ok: true }>;
  }

  type PeerEvent =
    | { type: "join" | "leave" | "connecting" | "reconnecting"; id: string }
    | { type: "relay"; id: string; active: boolean }
    | { type: "error"; reason: string; detail: string };

  interface PeerInfo {
    id: string;
    open: boolean;
    latency: number;
    /** 最近一次端到端 RTT 抖动的平滑值（毫秒）。无样本时为 0。 */
    jitter: number;
    relay: boolean;
    /** 此连接的低延迟、不可靠 DataChannel 是否已打开。 */
    realtime: boolean;
    reconnecting: boolean;
    role?: "primary" | "warm" | "candidate";
    score?: number;
    connectionState?: RTCPeerConnectionState | null;
    iceConnectionState?: RTCIceConnectionState | null;
  }

  interface PeerPath {
    path: "direct" | "relay" | "unavailable";
    direct: boolean;
    commonRelayIds: string[];
  }

  interface CandidateDiagnostics {
    candidateType: "host" | "srflx" | "prflx" | "relay" | null;
    protocol: string | null;
    relayProtocol: string | null;
    tcpType: string | null;
    networkType: string | null;
  }

  interface PeerNetworkQuality {
    rttMs: number | null;
    jitterMs: number | null;
    sampledAt: number | null;
    stale: boolean;
    source: "end-to-end" | "ice" | "unavailable";
    availableOutgoingBitrate: number | null;
    localCandidate: CandidateDiagnostics | null;
    remoteCandidate: CandidateDiagnostics | null;
    reliableBufferedAmount: number;
    realtimeBufferedAmount: number;
  }

  interface NetworkStats {
    state: "direct" | "mixed" | "recovering" | "relay";
    pathEpoch: number;
    primaryRelayId: string | null;
    warmRelayId: string | null;
    switching: boolean;
    lastSwitchReason: string;
    duplicateSuppressed: number;
    targets: Record<string, PeerPath>;
    quality: {
      peers: Record<string, PeerNetworkQuality>;
      rttP50Ms: number | null;
      rttP95Ms: number | null;
      jitterP95Ms: number | null;
    };
    realtime: {
      enabled: boolean;
      directOpen: number;
      relayOpen: number;
      maxBufferedBytes: number;
      bufferedAmountLowThreshold: number;
      reliableBufferedAmount: number;
      realtimeBufferedAmount: number;
      pending: number;
      sent: number;
      received: number;
      deferred: number;
      dropped: number;
      fallback: number;
    };
    coverage: {
      targets: number;
      direct: number;
      relay: number;
      unavailable: number;
    };
    relays: {
      limit: number;
      desired: number;
      total: number;
      open: number;
      connecting: number;
      pending: number;
      consensus: string[];
      proposals: string[];
      cooldown: string[];
    };
    lifecycle: {
      authExpiresAt: number | null;
      authRefreshCount: number;
      turnExpiresAt: number | null;
      turnRefreshCount: number;
      roomCapabilityExpiresAt: number | null;
      roomCapabilityRefreshCount: number;
      lastRoomCapabilityRefreshAt: number | null;
      iceCredentialRotations: number;
      lastIceCredentialRotationAt: number | null;
      lastIceCredentialRotationError: string | null;
    };
    remoteRelayStates: Record<
      string,
      { relays: string[]; proposals: string[]; unavailable: string[]; ageMs: number }
    >;
  }

  interface RtcConnectionDiagnostics {
    id: string;
    relay: boolean;
    open: boolean;
    reason: string;
    connectionState: RTCPeerConnectionState | null;
    signalingState: RTCSignalingState | null;
    iceConnectionState: RTCIceConnectionState | null;
    iceGatheringState: RTCIceGatheringState | null;
    iceErrors: Array<{
      at: string;
      errorCode: number | null;
      errorText: string;
    }>;
    channels: {
      reliable: {
        open: boolean;
        bufferedAmount: number;
      };
      realtime: {
        supported: boolean;
        open: boolean;
        bufferedAmount: number;
      };
    };
    selectedCandidatePair: {
      state: string | null;
      nominated: boolean;
      currentRoundTripTime: number | null;
      availableOutgoingBitrate: number | null;
      bytesSent: number | null;
      bytesReceived: number | null;
      local: CandidateDiagnostics | null;
      remote: CandidateDiagnostics | null;
    } | null;
    dtlsState?: string;
    statsError?: string;
    capturedAt?: string;
  }

  interface RoomDiagnostics {
    capturedAt: string;
    network: NetworkStats;
    peers: PeerInfo[];
    serverRelay: {
      configured: boolean;
      available: boolean;
      expiresAt: number | null;
      transports: string[];
      forced: boolean;
      error: string | null;
    };
    connections: RtcConnectionDiagnostics[];
    history: RtcConnectionDiagnostics[];
  }

  interface StateManager {
    set<T>(key: string, value: T): this;
    get<T>(key: string): T | undefined;
    on<T>(key: string, callback: (value: T, previous: T | undefined) => void): () => void;
    off<T>(key: string, callback: (value: T, previous: T | undefined) => void): void;
    snapshot(): Record<string, unknown>;
  }

  interface Snapshot {
    _t?: number;
    [key: string]: unknown;
  }

  interface SnapshotInterpolator {
    push(key: string, snapshot: Snapshot): void;
    get<T extends Snapshot>(key: string, renderTime?: number): T | null;
    clear(key?: string): void;
  }

  interface RoomMetadata {
    roomId: string;
    players: number;
    owner?: string;
    hostPeerId?: string;
    open?: boolean;
    listed?: boolean;
    max?: number;
    [key: string]: unknown;
  }

  interface Room {
    readonly roomId: string;
    readonly peerId: string;
    readonly topology: "host" | "mesh";
    readonly isHost: boolean;
    readonly hostId: string | null;
    readonly data: DataStore;
    readonly state: StateManager;
    readonly sync: SnapshotInterpolator;
    onMessage(callback: (message: unknown, fromPeerId: string) => void): this;
    onPeer(callback: (event: PeerEvent) => void): this;
    /** 可靠、有序消息；用于开火、伤害、结算、聊天等不可丢事件。 */
    send(message: unknown, toPeerId?: string): void;
    /**
     * 低延迟、无序、允许丢包的最新状态通道；拥塞时按目标合并为最新一条。
     * 适用于输入和状态快照，不适用于伤害、道具、结算等可靠事件。
     * 对不支持该能力的旧 SDK 对端会自动回退到可靠通道。
     */
    sendRealtime(message: unknown, toPeerId?: string): void;
    /** 直连与 relay 列表；relay 的 role 标识主路径、暖备或候选。 */
    peers(): PeerInfo[];
    /** 只读诊断快照；路径选择由 SDK 自动管理。 */
    networkStats(): NetworkStats;
    /** 读取 RTC/ICE 与候选类型；不会返回候选 IP 地址。 */
    diagnostics(): Promise<RoomDiagnostics>;
    reconnect(peerId: string): void;
    announce(metadata?: Record<string, unknown>): Promise<{ ok: true }>;
    close(): Promise<{ ok: true }>;
    leave(): void;
  }

  interface JoinOptions {
    topology?: "host" | "mesh";
    sync?: { bufferSize?: number; interpDelayMs?: number };
    realtime?:
      | false
      | {
          /** 默认 true。false 时不协商低延迟 DataChannel。 */
          enabled?: boolean;
          /** 开始合并最新状态的发送缓冲阈值，默认 64 KiB。 */
          maxBufferedBytes?: number;
          /** DataChannel 低水位回调阈值，默认 16 KiB。 */
          bufferedAmountLowThreshold?: number;
          /** RTT/ICE 质量采样间隔，1000-10000ms，默认 2000ms。 */
          qualityIntervalMs?: number;
        };
  }

  interface Client {
    readonly work: string;
    readonly apiBase: string;
    readonly save: DataStore;
    readonly global: DataStore;
    readonly rooms: {
      list(): Promise<RoomMetadata[]>;
      get(roomId: string): Promise<RoomMetadata | null>;
      quickJoin(options?: {
        filter?: (room: RoomMetadata) => boolean;
      }): Promise<string | null>;
    };
    readonly room: {
      join(roomId: string, options?: JoinOptions): Promise<Room>;
    };
    readonly user: User | null;
    /** 打开 VibeHub 授权弹窗；与 VibeNet 贡献生命周期无关。 */
    login(): Promise<User>;
    /**
     * 同步清除当前 SDK 实例的 token、用户状态和当前玩家缓存。
     * 不退出 VibeHub 主站、不删除云存档、不自动离开 Room，也不启停 VibeNet 贡献。
     */
    logout(): void;
    isLoggedIn(): boolean;
    onAuthChange(callback: (user: User | null) => void): () => void;
  }
}

declare const VibeHub: {
  readonly version: string;
  readonly channel: "stable" | "beta" | "unknown";
  init(options: {
    /** 项目 slug，来自 vibeapps 试玩路径或 vibehub list；不是主站 /works/ 的作品 ID。 */
    work: string;
    apiBase?: string;
  }): Promise<VibeHubSDK.Client>;
};
