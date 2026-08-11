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
