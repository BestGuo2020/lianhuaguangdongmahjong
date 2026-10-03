// Real header/HUD/3D components with deterministic presentation state, without network mocks.
import { createApp, h, shallowRef } from 'vue'
import '../../../src/style.css'
import GameTableHud from '../../../src/components/table/GameTableHud.vue'
import GameShellHeader from '../../../src/components/shell/GameShellHeader.vue'
import { defaultAvatarForSeat } from '../../../src/game/core/presentation/avatar'
import { themePresentationByName, themePresentationCssVariables } from '../../../src/theme/themePresentation'
import type { TableThemeName } from '../../../src/components/table/three/tableTheme'
import type { GamePlayer, TileType } from '../../../src/game/core/contracts/types'
import type { BloodFlowTableState } from '../../../src/game/variants/lotus/bloodFlow/types'
import { vector } from '../../../src/game/variants/lotus/bloodFlow/state'
import { useAudio } from '../../../src/game/core/presentation/useAudio'

const query = new URLSearchParams(location.search)
const theme = (query.get('theme') || 'jade') as TableThemeName
const rule = (query.get('rule') || 'lotus-classic') as 'lotus-classic' | 'lotus-legacy' | 'lotus-blood-flow'
const online = query.get('mode') === 'remote'
const revealed = shallowRef(false), signal = shallowRef(0), honba = shallowRef(1)
const hand: TileType[] = ['m1','m2','m3','p1','p2','p3','s1','s2','s3','m4','m5','m6','east','white']
function layoutPlayers(meldCount = 0, count = 14): GamePlayer[] {
  return [0,1,2,3].map(seat => ({ seat, name: ['本家','下家','对家','上家'][seat], avatar: defaultAvatarForSeat(seat),
    characterId: ['deepseek','qwen','kimi','glm'][seat], score: 2000, hand: hand.slice(0, count - 3 * meldCount),
    concealedTileCount: count - 3 * meldCount, discards: Array(28).fill('p1'), redCount: 0, drawnTileIndex: -1,
    melds: Array.from({length: meldCount}, () => ({ type: 'peng' as const, tile: 's2' as const, tiles: ['s2','s2','s2'] as TileType[], from: (seat+1)%4 })) }))
}
const players = shallowRef(layoutPlayers())
const blood: BloodFlowTableState = { ruleVersion: 'lotus-blood-flow-v1', roundId: 'inspection', status: 'playing', batches: [],
  seats: vector(() => ({ winCount: 0, locked: false, firstWinSequence: null, recordIds: [] })), roundResult: null, waits: [] }
;(window as any).__setRevealHud = (value: { reveal?: boolean; melds?: number; count?: number; signal?: number; honba?: number }) => {
  if (value.reveal !== undefined) revealed.value = value.reveal
  if (value.melds !== undefined || value.count !== undefined) players.value = layoutPlayers(value.melds, value.count)
  if (value.signal !== undefined) signal.value = value.signal
  if (value.honba !== undefined) honba.value = value.honba
}
const props = {
  themeName: theme, wall: [] as TileType[], wallHeadDrawn: 136, wallCount: 0, currentPlayer: -1, selectedIndex: -1, turnSeconds: 0,
  lastDiscard: null, actionPrompt: null, announcement: null, tableActionEvent: null, scoreFlowEvent: null, result: null,
  winEffect: null, winPresentation: null, matchFinished: false, winningPlayerIndex: -1, dealer: 0, isUserTurn: false, userCanHu: false,
  matchName: '东风场', roundLabel: '东4局', dealAnimation: { playerIndex: -1, count: 0, serial: 0 }, openingStage: null,
  diceValues: [1,2], diceThrowerIndex: 0, userCurrentWaits: null, userTingOptions: [], userDiscardWaits: null,
  userKongs: [], userHasWindKong: false, rulesetId: rule, online,
  bloodFlow: rule === 'lotus-blood-flow' ? blood : null,
  flipTile: rule === 'lotus-classic' ? null : 'red' as const,
  secondDice: rule === 'lotus-classic' ? undefined : [2,4],
  jokerTiles: (rule === 'lotus-classic' ? ['white'] : ['red','green']) as TileType[],
  wildcardTiles: (rule === 'lotus-classic' ? [] : ['white']) as TileType[],
}
createApp({ setup() {
  const audio = useAudio()
  audio.bgmOn.value = false
  return () => h('main', { class: 'game-app', 'data-table-theme': theme,
  style: themePresentationCssVariables(themePresentationByName(theme)) }, [h('div', { class: 'has-three-scene' }, [
    h(GameShellHeader, { gameMode: online ? 'remote' : 'local', phase: revealed.value ? 'revealing' : 'discard', hasPlayers: true,
      matchName: '东风场', roundLabel: '东4局', honba: honba.value, baseScore: 100, roomId: online ? 'ABC234' : '',
      signalQuality: signal.value, signalWarningThreshold: 1, themeName: theme, themeLocked: online,
      onOpenRules: () => { (window as any).__rulesClicked = true } }),
    h(GameTableHud, { ...props, players: players.value, user: players.value[0], revealHands: revealed.value,
      phase: revealed.value ? 'revealing' : 'discard' }),
  ])]) } }).mount('#app')
