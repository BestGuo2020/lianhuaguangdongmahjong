// 独立站账号接口，与麻将房间的 P2P/WS 传输无关。
const PAGE_ORIGIN = typeof location !== 'undefined' ? location.origin : 'http://localhost'
const API_BASE = (import.meta.env.VITE_API_BASE || PAGE_ORIGIN).replace(/\/$/, '')

export interface WakuDemoAccount {
  id: string | null
  displayName: string | null
  avatarUrl: string | null
}

export type WakuDemoLoginSession =
  | { authenticated: false }
  | { authenticated: true; account: WakuDemoAccount }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    let code = `HTTP_${response.status}`
    try {
      const body = await response.json()
      if (body?.detail?.code) code = body.detail.code
    } catch { /* 非 JSON 错误保留 HTTP 状态码 */ }
    throw new Error(code)
  }
  return response.json() as Promise<T>
}

export function beginWakuDemoLogin(): void {
  window.location.assign(`${API_BASE}/api/login/wakudemo`)
}

export function getWakuDemoLoginSession(): Promise<WakuDemoLoginSession> {
  return request('/api/login/session')
}

export function logoutWakuDemo(): Promise<{ authenticated: false }> {
  return request('/api/login/logout', { method: 'POST' })
}
