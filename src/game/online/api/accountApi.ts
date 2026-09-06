import { DISCLAIMER_VERSION } from '../../../content/disclaimer'
import { request } from './httpClient'

export interface PlayerStats {
  nickname?: string
  playerId?: string
  matches: number
  hands: number
  wins: number
  totalDelta: number
}

export interface DisclaimerAgreement {
  playerId: string
  agreed: boolean
  version?: number
  agreedAt?: string
}

export function getPlayerStats(nickname: string): Promise<PlayerStats> {
  return request<PlayerStats>(`/api/players/${encodeURIComponent(nickname)}/stats`)
}

export function getPlayerStatsById(playerId: string): Promise<PlayerStats> {
  return request<PlayerStats>(`/api/players/by-id/${encodeURIComponent(playerId)}/stats`)
}

/** 当前登录玩家的战绩（联机身份 wakudemo-<uid>）。 */
export function getMyStats(): Promise<PlayerStats> {
  return request<PlayerStats>('/api/me/stats')
}

export function getDisclaimerAgreement(playerId: string): Promise<DisclaimerAgreement> {
  return request<DisclaimerAgreement>(
    `/api/players/by-id/${encodeURIComponent(playerId)}/disclaimer-agreement`,
  )
}

export function agreeDisclaimer(
  playerId: string,
  version: number = DISCLAIMER_VERSION,
): Promise<DisclaimerAgreement> {
  return request<DisclaimerAgreement>(
    `/api/players/by-id/${encodeURIComponent(playerId)}/disclaimer-agreement`,
    {
      method: 'PUT',
      body: JSON.stringify({ version }),
    },
  )
}

/** 当前登录玩家的声明同意记录（联机身份 wakudemo-<uid>）。 */
export function getMyDisclaimerAgreement(): Promise<DisclaimerAgreement> {
  return request<DisclaimerAgreement>('/api/me/disclaimer-agreement')
}

/** 记录当前登录玩家同意声明（幂等）。 */
export function agreeMyDisclaimer(
  version: number = DISCLAIMER_VERSION,
): Promise<DisclaimerAgreement> {
  return request<DisclaimerAgreement>('/api/me/disclaimer-agreement', {
    method: 'PUT',
    body: JSON.stringify({ version }),
  })
}
