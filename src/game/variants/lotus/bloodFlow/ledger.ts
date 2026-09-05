import type { BloodFlowLedgerEntry, SeatVector } from './types'
import { vector } from './state'

export function assertZeroSum(deltas: SeatVector<number>): void {
  if (deltas.some(n => !Number.isSafeInteger(n)) || deltas.reduce((a, b) => a + b, 0) !== 0) throw new Error('Invalid zero-sum payment')
}

export function sumLedger(entries: readonly BloodFlowLedgerEntry[], kind: 'win' | 'kong') {
  const total = vector(() => 0)
  for (const entry of entries) {
    if (entry.kind !== kind) continue
    const deltas = entry.kind === 'win' ? entry.batch.deltas : entry.deltas
    assertZeroSum(deltas)
    deltas.forEach((n, i) => { total[i] += n })
  }
  return total
}
