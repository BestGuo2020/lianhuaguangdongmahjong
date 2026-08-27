import { API_BASE, request } from './httpClient'

export interface WakuDemoAccount {
  id: string | null
  displayName: string | null
  avatarUrl: string | null
}

export type WakuDemoLoginSession =
  | { authenticated: false }
  | { authenticated: true; account: WakuDemoAccount }

export function beginWakuDemoLogin(): void {
  window.location.assign(`${API_BASE}/api/login/wakudemo`)
}

export function getWakuDemoLoginSession(): Promise<WakuDemoLoginSession> {
  return request<WakuDemoLoginSession>('/api/login/session')
}

export function logoutWakuDemo(): Promise<{ authenticated: false }> {
  return request('/api/login/logout', { method: 'POST' })
}

