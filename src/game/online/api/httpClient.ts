// 远程 REST 基础设施：统一服务地址、JSON 编解码与错误模型。
const API_HOST = typeof location !== 'undefined' ? location.host : 'localhost'

export const API_BASE = import.meta.env.VITE_API_BASE || `http://${API_HOST}`

export class RemoteApiError extends Error {
  code: string
  status: number

  constructor(code: string, status: number) {
    super(code)
    this.name = 'RemoteApiError'
    this.code = code
    this.status = status
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    let code = `HTTP_${response.status}`
    try {
      const body = await response.json()
      if (body?.detail?.code) code = body.detail.code
    } catch {
      // 非 JSON 错误体，保留 HTTP 状态码。
    }
    throw new RemoteApiError(code, response.status)
  }
  return response.json() as Promise<T>
}
