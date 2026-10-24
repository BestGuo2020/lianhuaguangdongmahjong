// 自托管 P2P 客户端：实现与 VibeHubSDK.Client 同形的入口，替换真实 SDK / mock。
// - room.join 走 openSignaling + createSelfHostRoom（真实 WebRTC DataChannel）。
// - save/global 用 localStorage（个人战绩等本地数据；不做跨玩家全服榜）。
// - 无真实 VibeHub 账号：login 返回本机身份，DEV/自托管环境本就不强制登录。

import type { SelfHostConfig } from './selfHostConfig'
import { openSignaling, type SignalingConnection } from './selfHostSignaling'
import { createSelfHostRoom } from './selfHostRoom'

function createLocalDataStore(namespace: string): VibeHubSDK.DataStore {
  const memory = new Map<string, string>()
  const storage = (() => {
    try {
      return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null
    } catch {
      return null
    }
  })()
  const rawKey = (key: string) => `selfhost:${namespace}:${key}`
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
        const prefix = `selfhost:${namespace}:`
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

export function createSelfHostClient(config: SelfHostConfig): VibeHubSDK.Client {
  const clientId = (() => {
    if (config.peerId) return config.peerId
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return `p-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  })()

  // 每次 room.join 都是新连接 → 新 peerId（对齐真实 SDK 刷新/重进换 peerId 的行为，
  // 触发应用层的 seatToken 座位恢复路径）。
  function freshPeerId(): string {
    if (config.peerId) return config.peerId
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return `p-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  }

  let lastSignaling: SignalingConnection | null = null

  return {
    work: 'self-host',
    apiBase: config.signalingUrl,
    save: createLocalDataStore('save'),
    global: createLocalDataStore('global'),
    rooms: {
      async list() {
        return []
      },
      async get(roomId) {
        const id = roomId.toUpperCase()
        // 元数据只在「已加入的当前房间」可查（业务上 getRoomMeta 总是在 join 之后调用）。
        if (lastSignaling?.roomId === id) {
          const meta = await lastSignaling.requestMeta()
          return (meta as VibeHubSDK.RoomMetadata | null) ?? null
        }
        return null
      },
      async quickJoin() {
        return null
      },
    },
    room: {
      async join(roomId) {
        const id = roomId.toUpperCase()
        const signaling = await openSignaling(config.signalingUrl, id, freshPeerId())
        lastSignaling = signaling
        const room = createSelfHostRoom({
          signaling,
          iceServers: config.iceServers,
          forceRelay: config.forceRelay,
        })
        // 联调开关：?selfHostRelay / ?selfHostRelayAfter 自动触发一次 P2P→Relay 切换。
        if (config.relayAfterMs != null) {
          ;(room as VibeHubSDK.Room & { simulateRelaySwitch(afterMs: number, durationMs?: number): void })
            .simulateRelaySwitch(config.relayAfterMs, config.relayDurationMs ?? 0)
        }
        return room
      },
    },
    user: null,
    async login() {
      return { id: clientId, name: '本机玩家', image: null }
    },
    logout() { /* 自托管无登录态 */ },
    isLoggedIn() {
      return false
    },
    onAuthChange() {
      return () => {}
    },
  }
}
