// Opt-in audit, separate from the ordinary unit suite:
// BLOOD_FLOW_SHUFFLE_AUDIT=1 vitest run --dir scripts blood-flow-shuffle-audit.test.ts
// Fixed sample sizes and a predeclared conservative 4.5-sigma investigation threshold.
import { test, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { toRaw } from 'vue'
import { buildRingWall, resolveFlip, resolveOpeningStack, buildDrawOrderWall } from '../src/game/variants/lotus/lotusWall'
import { sortTilesWithJokers, TILE_TYPES } from '../src/game/core/rules/tiles'
import { dealInitialHands } from '../src/game/shared/runtime/localOpening'
import { createLotusOpening } from '../src/game/variants/lotus/lotusOpening'
import { createLotusGameState } from '../src/game/variants/lotus/lotusState'
import { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'
import { seededRandom } from '../src/game/variants/lotus/bloodFlow/simulation'
import { lotusDiscardCandidates } from '../src/game/variants/lotus/lotusAi'
import type { GamePlayer, TileType } from '../src/game/core/contracts/types'
import type { Seat } from '../src/game/variants/lotus/bloodFlow/types'

const OUT = 'work/blood-flow-shuffle-audit-20261030'
const OPENINGS_PER_SOURCE = 200_000
const FULL_ROUNDS = 2048
const IDENTITY_WALLS = 256
const Z_THRESHOLD = 4.5
const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]
const wait = async () => {}
const roll = (random: () => number): [number, number] => [1 + Math.floor(random() * 6), 1 + Math.floor(random() * 6)]
const count = (hand: readonly TileType[], jokers: readonly TileType[]) => hand.filter(t => jokers.includes(t)).length
const makePlayers = (): GamePlayer[] => [0, 1, 2, 3].map(seat => ({ seat, name: `seat-${seat}`, avatar: '',
  hand: [], melds: [], discards: [], score: 2000, redCount: 0, drawnTileIndex: -1,
  playerKind: seat === 0 ? 'human' : 'bot' }))
const same = (a: unknown, b: unknown, label: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(label)
}
const moment = () => ({ n: 0, sum: 0, sumSquares: 0 })
type Moment = ReturnType<typeof moment>
function add(m: Moment, v: number) { m.n++; m.sum += v; m.sumSquares += v * v }
function summary(m: Moment, expected?: number) {
  const mean = m.sum / m.n
  const variance = (m.sumSquares - m.sum * m.sum / m.n) / (m.n - 1)
  const se = Math.sqrt(Math.max(0, variance) / m.n)
  return { n: m.n, mean, se, ci99: [mean - 2.575829 * se, mean + 2.575829 * se],
    ...(expected === undefined ? {} : { expected,
      z: se ? (mean - expected) / se : mean === expected ? 0 : Infinity }) }
}
function zeroProbability(n: number) {
  let p = 1
  for (let i = 0; i < n; i++) p *= (128 - i) / (135 - i)
  return p
}
function accumulator() {
  const seats = [0, 1, 2, 3].map(() => ({ count: moment(), zero: moment(), hist: Array(9).fill(0) }))
  const byDealer = [0, 1, 2, 3].map(() => [0, 1, 2, 3].map(() => ({ count: moment(), zero: moment() })))
  const contrasts = pairs.map(() => ({ count: moment(), zero: moment() }))
  const humanVsAi = { count: moment(), zero: moment() }
  return { seats, byDealer, contrasts, humanVsAi }
}
type Accumulator = ReturnType<typeof accumulator>
function observe(a: Accumulator, counts: number[], dealer: number) {
  counts.forEach((v, seat) => {
    add(a.seats[seat].count, v); add(a.seats[seat].zero, Number(v === 0)); a.seats[seat].hist[v]++
    add(a.byDealer[dealer][seat].count, v); add(a.byDealer[dealer][seat].zero, Number(v === 0))
  })
  pairs.forEach(([i, j], k) => {
    add(a.contrasts[k].count, counts[i] - counts[j])
    add(a.contrasts[k].zero, Number(counts[i] === 0) - Number(counts[j] === 0))
  })
  add(a.humanVsAi.count, counts[0] - counts.slice(1).reduce((s, n) => s + n, 0) / 3)
  add(a.humanVsAi.zero, Number(counts[0] === 0) - counts.slice(1).filter(n => n === 0).length / 3)
}
function finish(a: Accumulator, opening: boolean) {
  const checks: { label: string; z: number }[] = []
  const pairResults = a.contrasts.map((v, i) => {
    const result = { seats: pairs[i], count: summary(v.count, 0), zero: summary(v.zero, 0) }
    checks.push({ label: `pair-${pairs[i]}-count`, z: result.count.z }, { label: `pair-${pairs[i]}-zero`, z: result.zero.z })
    return result
  })
  const byDealer = a.byDealer.map((row, dealer) => row.map((v, seat) => {
    const n = dealer === seat ? 14 : 13
    const result = { dealer, seat, count: summary(v.count, n * 7 / 135), zero: summary(v.zero, zeroProbability(n)) }
    if (opening) checks.push({ label: `dealer-${dealer}-seat-${seat}-count`, z: result.count.z },
      { label: `dealer-${dealer}-seat-${seat}-zero`, z: result.zero.z })
    return result
  }))
  return { seats: a.seats.map((v, seat) => ({ seat, count: summary(v.count), zero: summary(v.zero), histogram: v.hist })),
    byDealer: opening ? byDealer : undefined, pairResults,
    humanVsAi: { count: summary(a.humanVsAi.count, 0), zero: summary(a.humanVsAi.zero, 0) },
    checks, flagged: checks.filter(v => Math.abs(v.z) > Z_THRESHOLD) }
}
async function dealLocal(ring: TileType[], dealer: Seat, firstDice: [number, number], secondDice: [number, number]) {
  const flip = resolveFlip(ring, dealer, firstDice)
  const wall = buildDrawOrderWall(ring, resolveOpeningStack(flip.flipStack, secondDice), flip.flipStack)
  const state = { players: makePlayers(), dealer: { value: dealer }, openingStage: { value: null as any },
    dealAnimation: { value: { playerIndex: -1, count: 0, serial: 0 } } }
  await dealInitialHands({ state, takeTile: () => wall.shift() ?? null, wait, playSound: () => {},
    sortHand: hand => sortTilesWithJokers(hand, flip.jokers) })
  return { players: state.players, wall, flip }
}

test.skipIf(process.env.BLOOD_FLOW_SHUFFLE_AUDIT !== '1')('fixed-budget blood-flow deal and draw fairness audit', async () => {
  mkdirSync(OUT, { recursive: true })
  const started = Date.now()
  const sourceFiles = ['src/game/core/rules/tiles.ts', 'src/game/shared/runtime/localOpening.ts',
    'src/game/variants/lotus/lotusWall.ts', 'src/game/variants/lotus/lotusOpening.ts',
    'src/game/variants/lotus/bloodFlow/engine.ts', 'src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts']
  const report: any = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(sourceFiles.map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])),
    protocol: { openingsPerSource: OPENINGS_PER_SOURCE, fullRounds: FULL_ROUNDS, identityWalls: IDENTITY_WALLS,
      seed: 0xa27aea38, fullWallSeed: 0x10302026, fullPolicySeed: 0x52379461, threshold: Z_THRESHOLD,
      maxPlannedComparisons: 128, dealer: 'i % 4; equal counts per seat',
      decision: 'Any absolute z > 4.5 triggers investigation; no optional extra sampling or seed search.',
      uncertainty: 'Normal-approximation z; threshold 4.5 has a Bonferroni family false-positive bound below 0.1% for up to 128 comparisons. Reported 99% confidence intervals are marginal, not simultaneous.',
      theory: { nonDealerMean: 13 * 7 / 135, dealerMean: 14 * 7 / 135, balancedMean: 13.25 * 7 / 135,
        nonDealerZero: zeroProbability(13), dealerZero: zeroProbability(14),
        balancedZero: (3 * zeroProbability(13) + zeroProbability(14)) / 4 },
      limitations: ['Opening trials execute the production wall/flip/deal functions without rendering delays.',
        'Complete rounds use the same legal stress policy in all seats, not human or production AI strategy.',
        'This audits local dealing and the shared TS engine, not deployed WS server or real P2P transport.',
        'Finite samples constrain detectable seat bias; they do not prove perfect randomness.'] },
    openingRuns: [],
  }
  writeFileSync(`${OUT}/protocol.json`, JSON.stringify(report, null, 2))

  // Match the complete local opening orchestration to the engine path, then vary only identities.
  const identityRandom = seededRandom(0x438f2901)
  for (let i = 0; i < IDENTITY_WALLS; i++) {
    const dealer = (i % 4) as Seat, ring = buildRingWall(identityRandom)
    const firstDice = roll(identityRandom), secondDice = roll(identityRandom)
    const engine = new BloodFlowEngine({ authorityEpoch: 'identity', roundId: `${i}`, dealer,
      initialWall: ring, firstDice, secondDice, now: () => 0, winBeatMs: 0 })
    const expected = engine.players.map(p => [...p.hand].sort())
    for (let human = 0; human < 4; human++) {
      const state = createLotusGameState()
      const kinds = [0, 1, 2, 3].map(s => s === human ? 'human' : (s + i) % 2 ? 'llm' : 'bot') as ('human' | 'llm' | 'bot')[]
      const seeds = kinds.map((kind, seat) => ({ name: `${kind}-${seat}`, avatar: '', playerKind: kind, isLlm: kind === 'llm' }))
      let begun = false
      const opening = createLotusOpening({ state, automaticOpeningWin: false, clearTimers: () => {},
        takeTile: () => { state.wallHeadDrawn.value++; return state.wall.value.shift() ?? null }, wait,
        later: callback => { callback(); return 0 }, playSound: () => {}, playSoundAndWait: wait,
        announce: () => {}, getRoundLabel: () => 'audit', beginTurn: () => { begun = true },
        endGame: () => { throw new Error('Unexpected ordinary-mode win') }, humanPlayerSeed: seeds[0], playerSeeds: seeds.slice(1) })
      await opening.start('east', { initialWall: ring, openingDice: firstDice, openingSecondDice: secondDice, dealer })
      expect(begun).toBe(true)
      same(state.players.map(p => [...p.hand].sort()), expected, `Identity hand mismatch ${i}/${human}`)
      same(toRaw(state.wall.value), engine.wall, `Identity wall mismatch ${i}/${human}`)
      same(state.jokerTiles.value, engine.jokers, `Identity joker mismatch ${i}/${human}`)
      same(state.players.map(p => p.playerKind), kinds, 'Identity fixture was not applied')
    }
  }
  report.identityChecks = IDENTITY_WALLS * 4
  console.log(`Identity checks passed: ${report.identityChecks}`)

  for (const name of ['Math.random', 'seeded-xorshift32']) {
    const random = name === 'Math.random' ? Math.random : seededRandom(report.protocol.seed)
    const a = accumulator()
    const wallDigest = createHash('sha256')
    const samples: any[] = []
    let flipBottomJokers = 0
    for (let i = 0; i < OPENINGS_PER_SOURCE; i++) {
      const dealer = (i % 4) as Seat
      const ring = name === 'Math.random' ? buildRingWall() : buildRingWall(random)
      const firstDice = roll(random), secondDice = roll(random)
      const dealt = await dealLocal(ring, dealer, firstDice, secondDice)
      const counts = dealt.players.map(p => count(p.hand, dealt.flip.jokers))
      observe(a, counts, dealer)
      const physical = [...dealt.wall, ...dealt.players.flatMap(p => p.hand), ring[dealt.flip.flipStack * 2], ring[dealt.flip.flipStack * 2 + 1]]
      const frequency = new Map<TileType, number>()
      for (const t of physical) frequency.set(t, (frequency.get(t) ?? 0) + 1)
      if (physical.length !== 136 || TILE_TYPES.some(t => frequency.get(t) !== 4)) throw new Error(`Non-conserving opening ${name}/${i}`)
      if (dealt.wall.length !== 81 || dealt.players.some((p, s) => p.hand.length !== (s === dealer ? 14 : 13))) throw new Error('Invalid deal sizes')
      const bottomIsJoker = dealt.flip.jokers.includes(ring[dealt.flip.flipStack * 2 + 1])
      flipBottomJokers += Number(bottomIsJoker)
      if (counts.reduce((s, n) => s + n, 0) + count(dealt.wall, dealt.flip.jokers) !== (bottomIsJoker ? 6 : 7)) throw new Error('Lost joker')
      wallDigest.update(`${ring.join(',')}/${firstDice}/${secondDice}/${dealer}\n`)
      if (i < 4) samples.push({ ring, firstDice, secondDice, dealer, counts })
      if ((i + 1) % 50_000 === 0) console.log(`${name} openings ${i + 1}/${OPENINGS_PER_SOURCE}, elapsed ${Date.now() - started} ms`)
    }
    const result = { name, rounds: OPENINGS_PER_SOURCE, flipBottomJokers,
      wallDigest: wallDigest.digest('hex'), samples, ...finish(a, true) }
    report.openingRuns.push(result)
    writeFileSync(`${OUT}/progress.json`, JSON.stringify(report, null, 2))
  }

  const wallRandom = seededRandom(report.protocol.fullWallSeed), policyRandom = seededRandom(report.protocol.fullPolicySeed)
  const full = accumulator(), drawsPerSeat = [0, 0, 0, 0], jokerDraws = [0, 0, 0, 0]
  let totalCommands = 0, tailDraws = 0
  for (let i = 0; i < FULL_ROUNDS; i++) {
    const dealer = (i % 4) as Seat
    const e = new BloodFlowEngine({ authorityEpoch: 'full', roundId: `${i}`, dealer, random: wallRandom,
      now: () => 0, winBeatMs: 0 })
    const acquired = e.players.map(p => count(p.hand, e.jokers))
    const originalDraw = (e as any).draw.bind(e)
    ;(e as any).draw = (seat: Seat, tail = false) => {
      const before = e.wall.length
      originalDraw(seat, tail)
      if (before > e.wall.length) {
        drawsPerSeat[seat]++; if (tail) tailDraws++
        if (e.jokers.includes(e.players[seat].hand.at(-1)!)) { acquired[seat]++; jokerDraws[seat]++ }
      }
    }
    let commands = 0
    while (!e.result) {
      if (++commands > 2000) throw new Error(`Stalled round ${i}`)
      const w = e.window!
      const seat = [0, 1, 2, 3].find(s => w.options[s].length && !w.decisions[s])! as Seat
      const moves = w.options[seat]
      const discards = moves.filter(a => a.kind === 'discard')
      const claims = moves.filter(a => ['peng', 'chi', 'gang', 'wind-kong', 'concealed-kong', 'added-kong'].includes(a.kind))
      let action = moves.find(a => a.kind === 'win')
      if (!action && claims.length && policyRandom() < 0.25) action = claims[Math.floor(policyRandom() * claims.length)]
      if (!action && discards.length) {
        const candidates = lotusDiscardCandidates(e.players[seat].hand, e.jokers, discards.map(a => a.index))
        const index = candidates[Math.floor(policyRandom() * candidates.length)].index
        action = discards.find(a => a.index === index)
      }
      action ??= moves.find(a => a.kind === 'pass') ?? moves[0]
      if (!e.submit(e.command(seat, action))) throw new Error(`Rejected action ${i}/${commands}`)
    }
    e.assertConservation()
    if (e.wall.length || acquired.reduce((s, n) => s + n, 0) !== 8 - count(e.flipTiles, e.jokers)) throw new Error('Invalid end inventory')
    observe(full, acquired, dealer); totalCommands += commands
    if ((i + 1) % 256 === 0) console.log(`Full rounds ${i + 1}/${FULL_ROUNDS}, elapsed ${Date.now() - started} ms`)
  }
  report.fullRounds = { rounds: FULL_ROUNDS, policy: 'same seat-blind legal stress policy: accept wins, retain jokers when possible, random discards, 25% meld/kong acceptance',
    drawsPerSeat, jokerDraws, tailDraws, totalCommands, ...finish(full, false) }
  report.flagged = [...report.openingRuns, report.fullRounds].flatMap(r => r.flagged)
  report.actualComparisons = [...report.openingRuns, report.fullRounds].reduce((n, r) => n + r.checks.length, 0)
  report.elapsedMs = Date.now() - started
  writeFileSync(`${OUT}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ opening: report.openingRuns.map(r => ({ name: r.name, seats: r.seats,
    humanVsAi: r.humanVsAi, flagged: r.flagged })), fullRounds: report.fullRounds.seats,
    flagged: report.flagged, elapsedMs: report.elapsedMs }, null, 2))
  expect(report.actualComparisons).toBeLessThanOrEqual(report.protocol.maxPlannedComparisons)
  expect(report.flagged, 'Statistical flags require investigation; do not resample until they disappear').toEqual([])
}, 900_000)
