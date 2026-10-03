// Actual utility components with synthetic data; no room, game, model or account session.
import { createApp, h, ref } from 'vue'
import '../../../src/style.css'
import RulesPanel from '../../../src/components/RulesPanel.vue'
import StatsOverlay from '../../../src/components/account/StatsOverlay.vue'
import RoomPanel from '../../../src/components/lobby/RoomPanel.vue'
import ReplayListView from '../../../src/components/replay/ReplayListView.vue'
import LlmSettingsPanel from '../../../src/components/llm/LlmSettingsPanel.vue'
import GameShellHeader from '../../../src/components/shell/GameShellHeader.vue'
import BloodFlowRoundLedger from '../../../src/components/settlement/BloodFlowRoundLedger.vue'
import { TABLE_THEME_NAMES, type TableThemeName } from '../../../src/theme/themeIdentity'
import { themePresentationByName, themePresentationCssVariables } from '../../../src/theme/themePresentation'
import { useAudio } from '../../../src/game/core/presentation/useAudio'
import type { ReplayMatch } from '../../../src/game/replay/types'
import type { ReplayStorage } from '../../../src/game/replay/storage'
import type { AnalysisStorage } from '../../../src/game/replay/analysis/storage'
import type { GamePlayer } from '../../../src/game/core/contracts/types'
import type { BloodFlowPublicState } from '../../../src/game/variants/lotus/bloodFlow/types'

const theme = ref<TableThemeName>('jade')
const surface = ref('rules')
const llmActive = ref(false)
const futureMatch: ReplayMatch = { id: 'theme-warning', schemaVersion: 999, rulesetId: 'lotus-classic',
  rulesetName: '莲花广麻', matchType: 'east', matchName: '东风场', gameMode: 'local', themeName: 'jade',
  players: [], humanSeat: 0, startedAt: Date.now(), endedAt: Date.now(), status: 'aborted', roundCount: 1,
  summary: 'Theme warning fixture', analysisRecorded: true }
const replayStorage: ReplayStorage = { available: true, maxMatches: 10, list: async () => [futureMatch, { ...futureMatch, id: 'complete-record', schemaVersion: 1 }],
  setMaxMatches: async () => {}, saveMatch: async () => {}, saveRound: async () => {},
  loadMatch: async () => futureMatch, loadRounds: async () => [], remove: async () => {},
  clearAll: async () => {}, trim: async () => {} }
const analysisStorage = { available: () => true, status: async (id: string) => id === futureMatch.id ? 'partial' : 'complete' } as AnalysisStorage
const players: GamePlayer[] = [0, 1, 2, 3].map(seat => ({ seat, name: `玩家${seat + 1}`, avatar: '',
  score: 2000, hand: [], melds: [], discards: [], redCount: 0, drawnTileIndex: -1 }))
const ledger: BloodFlowPublicState = { ruleVersion: 'lotus-blood-flow-v1', roundId: 'theme-fixture', status: 'settled',
  seats: [0, 1, 2, 3].map(() => ({ winCount: 0, locked: false, recordIds: [] })) as BloodFlowPublicState['seats'], batches: [],
  roundResult: { ruleVersion: 'lotus-blood-flow-v1', roundId: 'theme-fixture', reason: 'wall-exhausted',
    openingScores: [2000, 2000, 2000, 2000], endingScores: [2000, 2000, 2000, 2000],
    winNet: [0, 0, 0, 0], kongNet: [0, 0, 0, 0], winCounts: [0, 0, 0, 0], ranks: [1, 1, 1, 1], ledger: [] } }

createApp({ setup() { useAudio(); return () => h('main', { class: 'game-app', 'data-table-theme': theme.value,
  style: themePresentationCssVariables(themePresentationByName(theme.value)) }, [
  h('div', { style: { position: 'fixed', top: '70px', left: '12px', zIndex: 1000, display: 'grid', gap: '8px' } }, [
    h('select', { 'data-testid': 'utility-theme', 'aria-label': 'Fixture theme', value: theme.value,
      onChange: (event: Event) => { theme.value = (event.target as HTMLSelectElement).value as TableThemeName } },
    TABLE_THEME_NAMES.map(name => h('option', { value: name }, name))),
    h('select', { 'data-testid': 'utility-surface', 'aria-label': 'Fixture surface', value: surface.value,
      onChange: (event: Event) => { surface.value = (event.target as HTMLSelectElement).value } },
    ['rules', 'stats', 'replay', 'llm', 'ledger', 'room', 'audio'].map(name => h('option', { value: name }, name))),
    h('button', { 'data-testid': 'utility-room-state', onClick: () => { llmActive.value = !llmActive.value } }, 'Toggle room LLM'),
  ]),
  h(GameShellHeader, { gameMode: 'local', phase: 'discard', hasPlayers: true, matchName: '东风场', roundLabel: '东一局',
    honba: 0, roomId: '', signalQuality: 3, themeName: theme.value,
    onChangeTheme: (value: TableThemeName) => { theme.value = value } }),
  h(RulesPanel, { open: surface.value === 'rules', variant: 'lotus-legacy' }),
  h(StatsOverlay, { open: surface.value === 'stats', playerId: 'theme-fixture', nickname: '主题测试', fallbackNickname: '' }),
  h(ReplayListView, { open: surface.value === 'replay', storage: replayStorage, available: true, analysis: analysisStorage }),
  h(LlmSettingsPanel, { open: surface.value === 'llm', themeName: theme.value, messages: [], stats: { requests: 0, successes: 0, fallbacks: 0, messages: 0, invalidActions: 0 } }),
  h(BloodFlowRoundLedger, { open: surface.value === 'ledger', state: ledger, players, localSeat: 0, themeName: theme.value }),
  surface.value === 'room' ? h('div', { style: { padding: '140px 20px 20px' } }, [h(RoomPanel, {
    roomId: 'STYLE1', roomTimeLimit: null, roomStatus: 'lobby', roomSeats: [null, null, null, null], reservedSeats: [], mySeat: -1,
    isCreator: true, sessionStatus: 'connected', allOccupiedReady: false, matchStarting: false, copied: false, leaving: false, closing: false,
    matchName: '东风场', ruleName: '莲花广麻', llmEnabled: true, effectiveLlmEnabled: llmActive.value, llmAvailable: llmActive.value,
    llmProviders: [], tableThemeName: theme.value, characterId: 'qwen',
  })]) : null,
]) } }).mount('#app')
