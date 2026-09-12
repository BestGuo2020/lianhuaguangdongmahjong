import { computed, ref } from 'vue'

export interface VibeUser {
  id: string
  name: string | null
  image: string | null
}

/** 作品 slug：VibeHub 试玩路径 https://vibeapps.lumigrav.space/B5AJupT1/ 的第一段。 */
export const VIBE_WORK_SLUG = 'B5AJupT1'

export type VibeStatus = 'idle' | 'initializing' | 'authenticating' | 'ready' | 'unavailable' | 'error'

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
let loginPromise: Promise<VibeUser | null> | null = null
let stopWatching: (() => void) | null = null

export function isLoggedIn(): boolean {
  return vibeUser.value != null
}

/** 取当前已初始化的 SDK 客户端（未登录/未初始化时为 null）。后续阶段用它访问 rooms/room/save/global。 */
export function getVibeClient(): VibeHubSDK.Client | null {
  return client
}

/**
 * 本地开发是否使用**真实 VibeHub SDK**（真 WebRTC + 真中继）。
 *
 * 默认 dev 走 `mockVibeHub`（BroadcastChannel，离线可跑，但传输层是假的）；`VITE_VIBE_REAL=1 pnpm dev`
 * 时走真 SDK：SDK 在 localhost/127.0.0.1 下用 `location.origin` 作 apiBase，因此 vite.config.ts 必须把
 * 平台 API（/api/sdk、/api/relay、/api/game-auth、/connect、/relay-worker.js）同源代理过去。
 *
 * 注意（2026-09-12 实测）：真 SDK 的 room/信令接口**一律要求登录凭证**——`_fetch` 在没有 token 时直接
 * `reject("请先登录")`，服务端 `POST /api/sdk/rooms` 也无条件 401。所以本开关只能用于"本地 + 真实登录"，
 * **不能**用于匿名联机；匿名仅适用于中继节点贡献。结论与证据见 docs/vibehub-adaptation-checklist.md §7。
 */
export const useRealVibeSdk = import.meta.env.VITE_VIBE_REAL === '1'

export async function initVibeHub(): Promise<VibeHubSDK.Client | null> {
  if (initPromise) return initPromise
  if (typeof window === 'undefined') {
    vibeStatus.value = 'unavailable'
    return Promise.resolve(null)
  }
  initPromise = (async () => {
    // 本地开发默认用 mock（BroadcastChannel 模拟房间/对端），同浏览器双窗口即可联调全部
    // 联机逻辑；VITE_VIBE_REAL=1 时改走真 SDK（真 WebRTC + 真中继），**但房间接口要求登录凭证**，
    // 匿名进房在 SDK 层就被拒绝（见上方 useRealVibeSdk 注释）。生产构建不受影响（DEV=false 恒走真实 SDK）。
    if (import.meta.env.DEV && !useRealVibeSdk) {
      const { createMockVibeClient } = await import('./mockVibeHub')
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
  if (loginPromise) return loginPromise

  vibeError.value = ''
  vibeStatus.value = 'authenticating'
  loginPromise = (async () => {
    try {
      const user = await client.login()
      vibeUser.value = user
      vibeError.value = ''
      return user
    } catch (error) {
      vibeError.value = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      vibeStatus.value = 'ready'
      loginPromise = null
    }
  })()
  return loginPromise
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
