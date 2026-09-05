// Visual capacity fixture only. Deliberately not a rules or physical-tile simulation.
import { createApp, h, shallowRef } from 'vue'
import '../../../src/style.css'
import GameTableHud from '../../../src/components/table/GameTableHud.vue'
import { scorePatterns } from '../../../src/game/variants/lotus/patterns/score'
import { themePresentationByName, themePresentationCssVariables } from '../../../src/theme/themePresentation'
import type { TableThemeName } from '../../../src/components/table/three/tableTheme'
import type { BloodFlowTableState, Seat, WinBatch } from '../../../src/game/variants/lotus/bloodFlow/types'
import { vector } from '../../../src/game/variants/lotus/bloodFlow/state'
import { summarizeRound } from '../../../src/game/variants/lotus/bloodFlow/roundLifecycle'
import type { GamePlayer, TileType } from '../../../src/game/core/contracts/types'
import { defaultAvatarForSeat } from '../../../src/game/core/presentation/avatar'

const query = new URLSearchParams(location.search)
const count = Number(query.get('count') ?? 12)
const viewer = Number(query.get('viewer') ?? 0)
const theme = (query.get('theme') ?? 'jade') as TableThemeName
const score = scorePatterns(['pure-suit', 'all-triplets'], true, 'self-draw')
const batches: WinBatch[] = []
for (let ordinal = 1; ordinal <= count; ordinal++) for (const seat of [0, 1, 2, 3] as Seat[]) {
  const batchId = `fixture-${ordinal}-${seat}`, sequence = batches.length + 1
  const source = { id: `${batchId}-tile`, seat, tile: (['m1', 'p9', 's3', 'east'] as TileType[])[seat], kind: 'draw' as const }
  const deltas = vector(s => s === seat ? 600 : -200)
  batches.push({ authorityEpoch: 'fixture', sequence, roundId: 'fixture-round', ruleVersion: 'lotus-blood-flow-v1', batchId,
    windowId: 'fixture-window', source, deltas, scoresAfter: [2000, 2000, 2000, 2000], nextAction: { kind: 'draw', seat: ((seat + 1) % 4) as Seat },
    winners: [{ id: `${batchId}-win`, batchId, winner: seat, ordinal, sourceEventId: source.id, score, deltas }] })
}
const players: GamePlayer[] = [0, 1, 2, 3].map(relative => ({ seat: (relative + viewer) % 4, name: ['东家', '南家', '西家', '北家'][(relative + viewer) % 4],
  avatar: defaultAvatarForSeat(relative), score: 2000, melds: [], discards: [], redCount: 0, drawnTileIndex: relative === 0 ? 13 : -1,
  concealedTileCount: relative === 0 ? 14 : 13,
  hand: relative === 0 ? ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'm4', 'm5', 'm6', 'east', 'east'] : [] }))
const bloodFlow: BloodFlowTableState = { ruleVersion: 'lotus-blood-flow-v1', roundId: 'fixture-round', status: 'playing', batches,
  seats: vector(s => ({ winCount: count, locked: count > 0, firstWinSequence: 1, recordIds: batches.flatMap(b => b.winners.filter(w => w.winner === s).map(w => w.id)) })),
  roundResult: null, preview: score, waits: [] }
const props = { themeName: theme, players, user: players[0], phase: 'discard' as const, wall: Array(30).fill('east') as TileType[],
  wallHeadDrawn: 60, wallCount: 30, currentPlayer: 0, selectedIndex: -1, turnSeconds: 0, lastDiscard: null,
  actionPrompt: null, announcement: null, tableActionEvent: null, scoreFlowEvent: null, result: null,
  winEffect: null, winPresentation: null, revealHands: false, matchFinished: false, winningPlayerIndex: -1,
  dealer: 0, isUserTurn: true, userCanHu: true, matchName: '东风场', roundLabel: '东一局',
  dealAnimation: { playerIndex: -1, count: 0, serial: 0 }, openingStage: null, diceValues: [1, 2], diceThrowerIndex: 0,
  userCurrentWaits: null, userTingOptions: [], userDiscardWaits: null, userKongs: [], userHasWindKong: false,
  rulesetId: 'lotus-blood-flow' as const, bloodFlow, jokerTiles: ['red', 'green'] as TileType[], wildcardTiles: ['white'] as TileType[] }
const css = themePresentationCssVariables(themePresentationByName(theme))
const liveState = shallowRef(bloodFlow), liveAction = shallowRef(null)
const liveFinished = shallowRef(false)
const navigation = { nextRoundCalls: 0, returnToLobbyCalls: 0 }
;(window as any).__bloodFlowNavigation = navigation
;(window as any).__settleBloodFlow = (finished = false) => {
  const state = liveState.value
  const opening = vector(() => 2000)
  const ending = vector(s => 2000 + state.batches.reduce((sum, batch) => sum + batch.deltas[s], 0))
  liveFinished.value = finished
  liveState.value = { ...state, status: 'settled', preview: null,
    roundResult: summarizeRound(state.ruleVersion, state.roundId, opening, ending,
      vector(s => state.seats[s].winCount), state.batches.map(batch => ({ kind: 'win' as const, batch }))) }
}
;(window as any).__refreshBloodFlowResult = () => {
  // P2P snapshots replace objects without starting another round.
  liveState.value = JSON.parse(JSON.stringify(liveState.value))
}
;(window as any).__nextBloodFlowFixtureRound = () => {
  liveFinished.value = false
  liveState.value = { ...bloodFlow, roundId: 'fixture-next-round', roundResult: null, status: 'playing' }
}
let serial = batches.length, restore = 0
;(window as any).__appendBloodFlowWin = () => {
  const id = `live-${++serial}`, winScore = scorePatterns(['all-green'], true, 'self-draw')
  const deltas = vector(s => s === 0 ? winScore.paymentPerPayer * 3 : -winScore.paymentPerPayer)
  const ordinal = liveState.value.seats[0].winCount + 1
  const source = { id: `${id}-source`, seat: 0 as Seat, tile: 's2' as TileType, kind: 'draw' as const }
  const batch: WinBatch = { authorityEpoch: 'fixture', sequence: serial, roundId: 'fixture-round', ruleVersion: 'lotus-blood-flow-v1', batchId: id,
    windowId: id, source, deltas, scoresAfter: [2000, 2000, 2000, 2000], nextAction: { kind: 'draw', seat: 1 },
    winners: [{ id: `${id}-record`, batchId: id, winner: 0, ordinal, sourceEventId: source.id, score: winScore, deltas }] }
  liveState.value = { ...liveState.value, batches: [...liveState.value.batches, batch],
    seats: [{ ...liveState.value.seats[0], winCount: ordinal, locked: true }, liveState.value.seats[1], liveState.value.seats[2], liveState.value.seats[3]] }
  liveAction.value = { id: serial, type: 'self-draw', actorIndex: 0, sourceIndex: null, tile: 's2', meldIndex: -1 }
}
;(window as any).__restoreBloodFlow = () => { liveState.value = { ...liveState.value, presentationKey: `restore-${++restore}` } }
;(window as any).__appendBloodFlowMultiWin = () => {
  const id = `multi-${++serial}`, winScore = scorePatterns(['all-green'], true, 'discard')
  const source = { id: `${id}-tile`, seat: 0 as Seat, tile: 's2' as TileType, kind: 'discard' as const }
  const winners = ([1, 2, 3] as Seat[]).map(winner => ({ id: `${id}-${winner}`, batchId: id, winner,
    ordinal: liveState.value.seats[winner].winCount + 1, sourceEventId: source.id, score: winScore,
    deltas: vector(s => s === winner ? winScore.paymentPerPayer : s === 0 ? -winScore.paymentPerPayer : 0) }))
  const batch: WinBatch = { authorityEpoch: 'fixture', sequence: serial, roundId: 'fixture-round', ruleVersion: 'lotus-blood-flow-v1',
    batchId: id, windowId: id, source, winners, deltas: vector(s => winners.reduce((n,w) => n + w.deltas[s], 0)),
    scoresAfter: [2000,2000,2000,2000], nextAction: {kind:'draw',seat:1} }
  liveState.value = { ...liveState.value, batches: [...liveState.value.batches, batch], seats: vector(s => ({
    ...liveState.value.seats[s], winCount: liveState.value.seats[s].winCount + (s === 0 ? 0 : 1) })) }
}
createApp({ render: () => h('main', { class: 'game-app', 'data-theme': theme, style: css }, [h('div', { class: 'has-three-scene' }, [h(GameTableHud, {
  ...props, bloodFlow: liveState.value, tableActionEvent: liveAction.value,
  phase: liveState.value.roundResult ? 'settled' : props.phase,
  revealHands: Boolean(liveState.value.roundResult), matchFinished: liveFinished.value,
  isUserTurn: !liveState.value.roundResult, userCanHu: !liveState.value.roundResult,
  onNextRound: () => { navigation.nextRoundCalls++ },
  onReturnToLobby: () => { navigation.returnToLobbyCalls++ },
})])]) }).mount('#app')
