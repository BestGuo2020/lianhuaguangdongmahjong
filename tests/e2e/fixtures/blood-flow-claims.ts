// Real authority -> seat projection -> shared Vue adapter -> existing HUD buttons.
import { createApp, h, unref } from 'vue'
import '../../../src/style.css'
import GameTableHud from '../../../src/components/table/GameTableHud.vue'
import { BloodFlowEngine } from '../../../src/game/variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../../../src/game/variants/lotus/bloodFlow/seatView'
import { useBloodFlowGame } from '../../../src/game/variants/lotus/bloodFlow/useBloodFlowGame'
import { createWall } from '../../../src/game/core/rules/tiles'
import type { GamePlayer, TileType } from '../../../src/game/core/contracts/types'
import type { EngineCommand } from '../../../src/game/variants/lotus/bloodFlow/state'
import { SEATS } from '../../../src/game/variants/lotus/bloodFlow/state'
import { defaultAvatarForSeat } from '../../../src/game/core/presentation/avatar'
import { themePresentationByName, themePresentationCssVariables } from '../../../src/theme/themePresentation'

const pool = createWall()
const take = (tile: TileType) => { const index = pool.indexOf(tile); if (index < 0) throw new Error(`Missing ${tile}`); return pool.splice(index, 1)[0] }
const flipTiles: [TileType, TileType] = [take('p9'), take('white')]
const hands: TileType[][] = [
  ['m7','m8','m9','p7','p8','p9','s7','s8','s9','north','west','south','p4','m5'],
  ['m3','m4','m5','m5','m5','p1','p2','p3','s1','s2','s3','east','east'],
]
if(new URLSearchParams(location.search).has('multiChi')) hands[1]=['m3','m4','m5','m5','m5','m6','m7','p1','p2','p3','east','east','east']
hands.forEach(hand => hand.forEach(take))
const players = SEATS.map((seat): GamePlayer => ({ seat, name: `玩家${seat+1}`, avatar: defaultAvatarForSeat(seat), score: 2000,
  hand: hands[seat] ?? pool.splice(0, 13), melds: [], discards: [], redCount: 0, drawnTileIndex: -1 }))
const engine = new BloodFlowEngine({ authorityEpoch: 'claims-fixture', roundId: 'claims-round', winBeatMs: 0, decisionMs: Infinity,
  paced: new URLSearchParams(location.search).has('paced'),
  opening: { players, wall: pool, flipTiles, jokers: ['red','green'], headDrawn: 134-pool.length,
    dealerDrawnIndex: 13, flipStack: 0, flipSeat: 0, wallBreakIndex: 2 } })
engine.submit(engine.command(0, {kind:'discard',index:13}))
const commands: EngineCommand[] = []
const sounds: string[] = []
const meta = { round: 1, dealer: 0, mode: 'east' as const }
createApp({ setup() {
  const game = useBloodFlowGame({ countdownEnabled: false, playSound: name => sounds.push(name), externalAuthority: {
    send(command) {
      commands.push(command)
      if (!engine.submit(command)) throw new Error('HUD submitted an unavailable action')
      for (const seat of SEATS) if (engine.window?.id === command.windowId && engine.window.options[seat].length && !engine.window.decisions[seat]) {
        engine.submit(engine.command(seat, {kind:'pass'}))
      }
      engine.assertConservation()
      void game.acceptRemoteView(bloodFlowSeatView(engine, 1), meta)
    }, nextRound() {}, leave() {}, openingDone() {},
  } })
  void game.acceptRemoteView(bloodFlowSeatView(engine, 1), meta)
  if (new URLSearchParams(location.search).has('paced')) window.setInterval(() => {
    const stage = engine.transition
    let changed = Boolean(stage && engine.advance(stage.id))
    if (engine.window && engine.window.kind !== 'turn') for (const seat of SEATS) {
      if (seat !== 1 && engine.window?.options[seat].length && !engine.window.decisions[seat]) {
        changed = engine.submit(engine.command(seat, {kind:'pass'})) || changed
      }
    }
    if (changed) void game.acceptRemoteView(bloodFlowSeatView(engine, 1), meta)
  }, 25)
  ;(window as any).__refreshClaimView = () => game.acceptRemoteView(bloodFlowSeatView(engine,1),meta)
  ;(window as any).__claimEvidence = () => ({commands, sounds, selectedIndex:game.selectedIndex.value, melds:engine.players[1].melds, wins:engine.seats[1].winCount,
    window:engine.window?.kind, source:engine.window?.source, discards:engine.players[0].discards})
  const keys = ['players','user','phase','wall','wallHeadDrawn','wallCount','currentPlayer','selectedIndex','turnSeconds','lastDiscard',
    'actionPrompt','announcement','tableActionEvent','scoreFlowEvent','result','winEffect','winPresentation','revealHands','matchFinished',
    'winningPlayerIndex','dealer','isUserTurn','userCanHu','matchName','roundLabel','dealAnimation','openingStage','diceValues',
    'diceThrowerIndex','userCurrentWaits','userTingOptions','userDiscardWaits','userKongs'] as const
  return () => h('main', {class:'game-app','data-table-theme':'jade',style:themePresentationCssVariables(themePresentationByName('jade'))},
    [h('div',{class:'has-three-scene'},[h(GameTableHud,{
      ...Object.fromEntries(keys.map(key => [key, unref(game[key])])), themeName:'jade',rulesetId:'lotus-blood-flow',
      bloodFlow:game.capabilities.value.bloodFlow,jokerTiles:['red','green'],wildcardTiles:['white'],userHasWindKong:false,
      onPeng:game.userPeng,onGangFromDiscard:game.userGangFromDiscard,onHu:game.userHu,onPass:game.userPass,
      onGang:game.userGang,onSelectTile:game.selectTile,onClearSelection:game.clearUserSelection,onDiscard:game.userDiscard,
      onChi:(index:number)=>game.capabilities.value.chi.choose(index),
    })])])
} }).mount('#app')
