import { request } from './httpClient'

export interface ReportRequest {
  roomId?: string
  reporterPlayerId: string
  targetPlayerId?: string
  targetName?: string
  reason?: string
}

export function reportPlayer(body: ReportRequest): Promise<{ reported: boolean }> {
  return request<{ reported: boolean }>('/api/reports', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
