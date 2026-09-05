// Visual capacity fixture only. Deliberately not a rules or physical-tile simulation.
import { createApp, h, shallowRef } from 'vue'
import '../../../src/style.css'
import GameTableHud from '../../../src/components/table/GameTableHud.vue'
import { scorePatterns } from '../../../src/game/variants/lotus/patterns/score'
import { themePresentationByName, themePresentationCssVariables } from '../../../src/theme/themePresentation'
import type { TableThemeName } from '../../../src/components/table/three/tableTheme'
import type { BloodFlowTableState, Seat, WinBatch } from '../../../src/game/variants/lotus/bloodFlow/types'
import { vector } from '../../../src/game/variants/lotus/bloodFlow/state'
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
createApp({ render: () => h('main', { class: 'game-app', 'data-theme': theme, style: css }, [h('div', { class: 'has-three-scene' }, [h(GameTableHud, { ...props, bloodFlow: liveState.value, tableActionEvent: liveAction.value })])]) }).mount('#app')
