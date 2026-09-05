import type { BloodFlowEventIdentity, BloodFlowRuleVersion, Seat, SeatVector, SourceTileEvent, WinBatch, WinEvaluation } from './types'
import { SEATS, vector } from './state'
import { assertZeroSum } from './ledger'

export function resolveWinBatch(input: BloodFlowEventIdentity & {
  ruleVersion: BloodFlowRuleVersion; windowId: string; source: SourceTileEvent
  winners: readonly { seat: Seat; evaluation: WinEvaluation; ordinal: number }[]
  scores: SeatVector<number>; wallEmpty: boolean
}): WinBatch {
  if (!input.winners.length || new Set(input.winners.map(w => w.seat)).size !== input.winners.length) throw new Error('Invalid winner batch')
  const batchId = `${input.authorityEpoch}/${input.roundId}/batch/${input.sequence}`
  const totals = vector(() => 0)
  const winners = input.winners.map(({ seat, evaluation, ordinal }) => {
    const selfDraw = evaluation.score.source === 'self-draw' || evaluation.score.source === 'kong-bloom'
    if (selfDraw ? seat !== input.source.seat : seat === input.source.seat) throw new Error('Invalid winner source')
    const payers = selfDraw ? SEATS.filter(s => s !== seat) : [input.source.seat]
    const deltas = vector(() => 0)
    for (const payer of payers) { deltas[payer] -= evaluation.score.paymentPerPayer; deltas[seat] += evaluation.score.paymentPerPayer }
    assertZeroSum(deltas)
    deltas.forEach((n, i) => { totals[i] += n })
    return { id: `${batchId}/seat/${seat}`, batchId, winner: seat, ordinal, sourceEventId: input.source.id,
      score: structuredClone(evaluation.score), deltas }
  })
  assertZeroSum(totals)
  return { authorityEpoch: input.authorityEpoch, roundId: input.roundId, sequence: input.sequence,
    ruleVersion: input.ruleVersion, batchId, windowId: input.windowId, source: { ...input.source }, winners,
    deltas: totals, scoresAfter: vector(s => input.scores[s] + totals[s]),
    nextAction: input.wallEmpty ? { kind: 'finish-round', reason: 'wall-exhausted' }
      : { kind: 'draw', seat: ((input.source.seat + 1) % 4) as Seat } }
}
