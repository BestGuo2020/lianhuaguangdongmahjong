import type { BloodFlowLedgerEntry, BloodFlowRoundResult, BloodFlowRuleVersion, SeatVector } from './types'
import { sumLedger } from './ledger'
import { vector } from './state'

export function summarizeRound(ruleVersion: BloodFlowRuleVersion, roundId: string, openingScores: SeatVector<number>,
  endingScores: SeatVector<number>, winCounts: SeatVector<number>, ledger: readonly BloodFlowLedgerEntry[]): BloodFlowRoundResult {
  const winNet = sumLedger(ledger, 'win'), kongNet = sumLedger(ledger, 'kong')
  for (let i = 0; i < 4; i++) if (openingScores[i] + winNet[i] + kongNet[i] !== endingScores[i]) throw new Error('Round ledger mismatch')
  return { ruleVersion, roundId, reason: 'wall-exhausted', openingScores: [...openingScores], endingScores: [...endingScores],
    winNet, kongNet, winCounts: [...winCounts], ranks: vector(s => 1 + endingScores.filter(n => n > endingScores[s]).length),
    ledger: structuredClone(ledger) }
}
