// A layout fixture using the real blood-flow engine's opening projection.
import { createApp, h } from 'vue'
import '../../../src/style.css'
import GameTableHud from '../../../src/components/table/GameTableHud.vue'
import { BloodFlowEngine } from '../../../src/game/variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../../../src/game/variants/lotus/bloodFlow/seatView'
import { createWall } from '../../../src/game/core/rules/tiles'
import type { GamePlayer, Meld, TileType } from '../../../src/game/core/contracts/types'
import { defaultAvatarForSeat } from '../../../src/game/core/presentation/avatar'
import { themePresentationByName, themePresentationCssVariables } from '../../../src/theme/themePresentation'

const query = new URLSearchParams(location.search)
const count = Number(query.get('count') ?? 14)
if (![14, 11, 8, 5, 2].includes(count)) throw new Error('Unsupported fixture size')
const blood = query.get('variant') !== 'legacy'
const revealed = query.get('revealed') === '1'
const pool = createWall()
const take = (tile: TileType) => { const i = pool.indexOf(tile); if (i < 0) throw new Error('Exhausted fixture tile'); return pool.splice(i, 1)[0] }
const flipTiles: [TileType, TileType] = [take('p9'), take('white')]
const melds: Meld[] = Array.from({ length: (14 - count) / 3 }, (_, index) => {
  const tile = `p${index + 1}` as TileType
  return { type: 'peng', tile, from: 1, tiles: [take(tile), take(tile), take(tile)] }
})
const sorted: TileType[] = ['m1','m2','m3','m4','m5','m6','m7','m8','m9','s1','s2','s3','s4','s5'].slice(0, count) as TileType[]
const players: GamePlayer[] = [0,1,2,3].map(seat => ({ seat, name: `玩家${seat+1}`, avatar: defaultAvatarForSeat(seat), score: 2000,
  hand: seat === 0 ? sorted.map(take) : pool.splice(0, 13), melds: seat === 0 ? melds : [], discards: [], redCount: 0, drawnTileIndex: -1 }))
const engine = new BloodFlowEngine({ authorityEpoch: 'gap-fixture', roundId: 'gap-round', now: () => 0,
  opening: { players, wall: pool, flipTiles, jokers: ['red','green'], headDrawn: 134-pool.length,
    dealerDrawnIndex: 0, flipStack: 0, flipSeat: 0, wallBreakIndex: 2 } })
const view = bloodFlowSeatView(engine, 0)
if (!blood) {
  // Ordinary post-claim fallback: sorted hand, no explicit newly drawn index.
  view.players[0].hand = [...sorted]
  view.players[0].drawnTileIndex = -1
}
const bloodFlow = blood ? { ...view.public, preview: null, waits: [] } : null
const props = { themeName: 'jade' as const, players: view.players, user: view.players[0], phase: 'discard' as const,
  wall: Array(view.wallCount).fill('east') as TileType[], wallHeadDrawn: view.headDrawn, wallCount: view.wallCount,
  currentPlayer: 0, selectedIndex: -1, turnSeconds: 0, lastDiscard: null, actionPrompt: null, announcement: null,
  tableActionEvent: null, scoreFlowEvent: null, result: null, winEffect: null, winPresentation: null,
  revealHands: revealed, matchFinished: false, winningPlayerIndex: -1, dealer: 0, isUserTurn: !revealed,
  userCanHu: false, matchName: '东风场', roundLabel: '东一局', dealAnimation: { playerIndex: -1, count: 0, serial: 0 },
  openingStage: null, diceValues: [1,2], diceThrowerIndex: 0, userCurrentWaits: null, userTingOptions: [],
  userDiscardWaits: null, userKongs: [], userHasWindKong: false, bloodFlow,
  rulesetId: blood ? 'lotus-blood-flow' as const : 'lotus-legacy' as const,
  jokerTiles: ['red','green'] as TileType[], wildcardTiles: ['white'] as TileType[] }
createApp({ render: () => h('main', { class: 'game-app', 'data-table-theme': 'jade',
  style: themePresentationCssVariables(themePresentationByName('jade')) },
  [h('div', { class: 'has-three-scene' }, [h(GameTableHud, props)])]) }).mount('#app')
