import { computed, ref } from 'vue'

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

export const vibeStatus = ref<VibeStatus>('idle')
export const vibeError = ref('')
export const vibeUser = ref<VibeUser | null>(null)

/** 是否要求登录：仅在 lumigrav.space 且尚未登录时为 true。 */
export const loginRequired = computed(() => isVibeHost && !vibeUser.value)

let client: VibeHubSDK.Client | null = null
let initPromise: Promise<VibeHubSDK.Client | null> | null = null
let stopWatching: (() => void) | null = null

export function isLoggedIn(): boolean {
  return vibeUser.value != null
}

export async function initVibeHub(): Promise<VibeHubSDK.Client | null> {
  if (initPromise) return initPromise
  if (!isVibeHost || typeof window === 'undefined' || !('VibeHub' in window)) {
    vibeStatus.value = 'unavailable'
    return Promise.resolve(null)
  }
  vibeStatus.value = 'initializing'
  initPromise = (async () => {
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
