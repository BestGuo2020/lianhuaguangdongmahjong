import { BloodFlowEngine } from './engine'
import { SEATS, vector } from './state'
import type { Seat } from './types'

export function seededRandom(seed: number) {
  let value = seed >>> 0 || 1
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296 }
}

/** Deterministic legal-action stress policy. E04 replaces discard choice with rule AI;
 * this policy's statistics are not claims about player strength or game balance. */
export function simulateRound(seed: number, scores: readonly [number, number, number, number] = [2000, 2000, 2000, 2000], dealer: Seat = 0) {
  const random = seededRandom(seed)
  const engine = new BloodFlowEngine({ authorityEpoch: 'simulation', roundId: `seed-${seed}`, random, scores, dealer, now: () => 0 })
  let commands = 0, firstWinWall: number | null = null
  while (!engine.result) {
    if (++commands > 2000) throw new Error(`Stalled seed ${seed}`)
    const window = engine.window!
    const seat = SEATS.find(s => window.options[s].length && !window.decisions[s])!
    const moves = window.options[seat]
    const win = moves.find(a => a.kind === 'win')
    const discards = moves.filter(a => a.kind === 'discard')
    const action = win ?? (discards.length ? discards[Math.floor(random() * discards.length)] : moves[0])
    if (!engine.submit(engine.command(seat, action))) throw new Error(`Rejected legal action in seed ${seed}`)
    if (firstWinWall === null && engine.archives.length) firstWinWall = engine.wall.length
    engine.assertConservation()
  }
  const records = engine.publicState().batches.flatMap(b => b.winners)
  return { seed, commands, firstWinWall, result: engine.result, records, endingScores: vector(s => engine.players[s].score) }
}
