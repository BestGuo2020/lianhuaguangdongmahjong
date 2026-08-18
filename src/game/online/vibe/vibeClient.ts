import { computed, ref } from 'vue'
import { createMockVibeClient } from './mockVibeHub'
import { getSelfHostConfig } from '../transport/selfHost/selfHostConfig'
import { createSelfHostClient } from '../transport/selfHost/selfHostClient'

export interface VibeUser {
  id: string
  name: string | null
  image: string | null
}

/** 作品 slug：VibeHub 试玩路径 https://vibeapps.lumigrav.space/B5AJupT1/ 的第一段。 */
export const VIBE_WORK_SLUG = 'B5AJupT1'

export type VibeStatus = 'idle' | 'initializing' | 'ready' | 'unavailable' | 'error'

/** 是否部署在 lumigrav.space 生产域（仅生产域强制登录）。 */
export const isVibeHost = typeof window !== 'undefined'
  && window.location.hostname.endsWith('lumigrav.space')

/**
 * 是否允许初始化 VibeHub SDK：生产域 + 本地开发。
 * 本地（vite dev 任意主机名，或 localhost/127.0.0.1 的 preview）保持匿名联机，
 * 不上线即可本地联调 WebRTC；loginRequired 仍只由 isVibeHost 决定（本地不强制登录）。
 */
export const canInitVibeHub = isVibeHost
  || import.meta.env.DEV
  || (typeof window !== 'undefined'
    && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))

export const vibeStatus = ref<VibeStatus>('idle')
export const vibeError = ref('')
export const vibeUser = ref<VibeUser | null>(null)

/** 是否要求登录：仅生产域（且非本地开发）且尚未登录时为 true；本地开发保持匿名联机。 */
export const loginRequired = computed(() => (
  !import.meta.env.DEV
  && isVibeHost
  && !vibeUser.value
))

let client: VibeHubSDK.Client | null = null
let initPromise: Promise<VibeHubSDK.Client | null> | null = null
let stopWatching: (() => void) | null = null

export function isLoggedIn(): boolean {
  return vibeUser.value != null
}

/** 取当前已初始化的 SDK 客户端（未登录/未初始化时为 null）。后续阶段用它访问 rooms/room/save/global。 */
export function getVibeClient(): VibeHubSDK.Client | null {
  return client
}

export async function initVibeHub(): Promise<VibeHubSDK.Client | null> {
  if (initPromise) return initPromise
  if (typeof window === 'undefined') {
    vibeStatus.value = 'unavailable'
    return Promise.resolve(null)
  }
  initPromise = (async () => {
    // 自托管 staging：?selfHost=ws://… 或 VITE_SELF_HOST_SIGNALING 时，用自建
    // 信令 + 真实 WebRTC DataChannel 联调（测真 NAT/TURN/relay/跨设备），无需上线。
    // 仅在未配置时回退到本地 mock / 真实 SDK。
    const selfHostConfig = getSelfHostConfig()
    if (selfHostConfig) {
      const selfHost = createSelfHostClient(selfHostConfig)
      client = selfHost
      vibeUser.value = null
      vibeStatus.value = 'ready'
      return selfHost
    }
    // 本地开发：真实 VibeHub 云端对本地来源有 CORS + 来源校验（浏览器无法绕过），
    // 直接使用本地 mock（BroadcastChannel 模拟房间/对端），同浏览器双窗口即可
    // 联调全部联机逻辑，无需发布。生产构建不受影响（DEV=false 走真实 SDK）。
    if (import.meta.env.DEV) {
      const mock = createMockVibeClient()
      client = mock
      vibeUser.value = null
      vibeStatus.value = 'ready'
      return mock
    }
    if (!canInitVibeHub || !('VibeHub' in window)) {
      vibeStatus.value = 'unavailable'
      return null
    }
    vibeStatus.value = 'initializing'
    try {
      const instance = await window.VibeHub.init({ work: VIBE_WORK_SLUG })
      client = instance
      vibeUser.value = instance.user
      stopWatching = instance.onAuthChange((user) => {
        vibeUser.value = user ?? null
      })
      vibeStatus.value = 'ready'
      return instance
    } catch (error) {
      vibeStatus.value = 'error'
      vibeError.value = error instanceof Error ? error.message : String(error)
      return null
    }
  })()
  return initPromise
}

export async function login(): Promise<VibeUser | null> {
  if (!client) return null
  try {
    const user = await client.login()
    vibeUser.value = user
    return user
  } catch (error) {
    vibeError.value = error instanceof Error ? error.message : String(error)
    return null
  }
}

export function logout(): void {
  if (!client) return
  client.logout()
  vibeUser.value = null
}

export function stopVibeAuthWatch(): void {
  stopWatching?.()
  stopWatching = null
}
