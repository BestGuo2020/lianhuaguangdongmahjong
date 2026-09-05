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
import {useAudio} from '../../../src/game/core/presentation/useAudio'
import {createBloodFlowAudioBridge} from '../../../src/game/variants/lotus/bloodFlow/audioBridge'
import {animeFallbackAudioForAction} from '../../../src/game/llm/animeFixedTtsExecutor'
import type {PatternId} from '../../../src/game/variants/lotus/patterns/types'

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
  characterId:['deepseek','qwen','kimi','glm'][(relative+viewer)%4],
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
const livePlayers=shallowRef(players),liveLastDiscard=shallowRef<{tile:TileType;from:number;id:number}|null>(null)
const hudState = shallowRef<Record<string, unknown>>({})
// Compare the exact HUD with ordinary rules, without running an unrelated AI turn.
;(window as any).__setCommonPresentation = (value: Record<string, unknown>) => { hudState.value = value }
const waitInfo = { discard: 'm1', tiles: [{tile:'s2',remaining:3},{tile:'s3',remaining:2},{tile:'s4',remaining:0},{tile:'s6',remaining:1}], total:6 }
function showHudState(state: 'waiting'|'selection'|'preview') {
  const waits = waitInfo.tiles.map(item=>({tile:item.tile as TileType,selfDraw:score,discard:score}))
  liveState.value = { ...liveState.value, preview: score, waits, discardWaitScores:{m1:waits} }
  hudState.value = { flipTile:'red',secondDice:[2,4], userCurrentWaits:waitInfo,
    userDiscardWaits:state==='selection'?waitInfo:null,selectedIndex:state==='selection'?0:-1,
    isUserTurn:state==='selection',userCanHu:state==='preview',
    actionPrompt:state==='preview'?{type:'claim',canHu:true,canPeng:true,canGang:true,chiOptions:[{tiles:['m1','m2','m3']}]}:null }
}
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
;(window as any).__settleBloodFlowRanking = () => {
  const state=liveState.value, id='ranking-final-win', source={id:`${id}-tile`,seat:2 as Seat,tile:'s2' as TileType,kind:'draw' as const}
  const deltas=vector(s=>s===2?600:-200)
  const batch:WinBatch={authorityEpoch:'fixture',sequence:1,roundId:state.roundId,ruleVersion:state.ruleVersion,batchId:id,windowId:id,source,
    deltas,scoresAfter:[1500,2700,2300,1500],nextAction:{kind:'finish-round',reason:'wall-exhausted'},
    winners:[{id:`${id}-record`,batchId:id,winner:2,ordinal:1,sourceEventId:source.id,score,deltas}]}
  liveFinished.value=true
  liveState.value={...state,status:'settled',preview:null,batches:[batch],seats:vector(s=>({...state.seats[s],winCount:s===2?1:0})),
    roundResult:summarizeRound(state.ruleVersion,state.roundId,[1700,2900,1700,1700],[1500,2700,2300,1500],[0,0,1,0],[{kind:'win',batch}])}
}
;(window as any).__setBloodFlowContinuation = (ready:boolean, readySeats:Seat[]=[]) => { liveState.value={...liveState.value,continuation:{ready,readySeats,requiredSeats:[0,1]}} }
;(window as any).__setBloodFlowBubbles = (kind:'action'|'round') => {
  const bubbles=Object.fromEntries(livePlayers.value.map((p,i)=>[i,{id:i+1,text:`${p.name}${kind==='round'?'本局小结':'先打这张'}`,persistent:kind==='round'}]))
  liveState.value={...liveState.value,...(kind==='round'?{roundBubbles:bubbles}:{actionBubbles:bubbles})}
}
;(window as any).__nextBloodFlowFixtureRound = () => {
  liveFinished.value = false
  liveState.value = { ...bloodFlow, roundId: 'fixture-next-round', roundResult: null, status: 'playing' }
}
let serial = batches.length, restore = 0
let actionAudio:ReturnType<typeof createBloodFlowAudioBridge>|null=null,voiceSerial=0
function announceBatch(batch:WinBatch){for(const record of batch.winners)actionAudio?.present({id:++voiceSerial,actorIndex:(record.winner-viewer+4)%4,
  type:batch.source.kind==='draw'?'self-draw':batch.source.kind==='added-kong'?'robbed-kong-win':'discard-win',sourceIndex:batch.source.kind==='draw'?null:(batch.source.seat-viewer+4)%4,tile:batch.source.tile,meldIndex:-1})}
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
  announceBatch(batch)
}
;(window as any).__restoreBloodFlow = () => { liveState.value = { ...liveState.value, presentationKey: `restore-${++restore}` } }
;(window as any).__appendBloodFlowMultiWin = (winnerSeats:Seat[]=[1,2,3], sourceSeat:Seat=0) => {
  const id = `multi-${++serial}`
  const source = { id: `${id}-tile`, seat: sourceSeat, tile: 'm1' as TileType, kind: 'discard' as const }
  const winners = winnerSeats.map((winner,index) => {const winScore=scorePatterns([(['pure-suit','big-three-dragons','thirteenOrphans'] as const)[index]],true,'discard');return ({ id: `${id}-${winner}`, batchId: id, winner,
    ordinal: liveState.value.seats[winner].winCount + 1, sourceEventId: source.id, score: winScore,
    deltas: vector(s => s === winner ? winScore.paymentPerPayer : s === sourceSeat ? -winScore.paymentPerPayer : 0) })})
  const batch: WinBatch = { authorityEpoch: 'fixture', sequence: serial, roundId: 'fixture-round', ruleVersion: 'lotus-blood-flow-v1',
    batchId: id, windowId: id, source, winners, deltas: vector(s => winners.reduce((n,w) => n + w.deltas[s], 0)),
    scoresAfter: [2000,2000,2000,2000], nextAction: {kind:'draw',seat:((sourceSeat+1)%4) as Seat} }
  liveState.value = { ...liveState.value, batches: [...liveState.value.batches, batch], seats: vector(s => ({
    ...liveState.value.seats[s], winCount: liveState.value.seats[s].winCount + (winnerSeats.includes(s) ? 1 : 0) })) }
  announceBatch(batch)
}
;(window as any).__appendBloodFlowKong = (actor:Seat=0) => {
  const event={kind:'kong' as const,authorityEpoch:'fixture',roundId:liveState.value.roundId,sequence:++serial,id:`kong-${serial}`,actor,kongKind:'concealed' as const,sourceSeat:null,
    deltas:vector(s=>s===actor?60:-20),scoresAfter:[2000,2000,2000,2000] as [number,number,number,number]}
  liveState.value={...liveState.value,kongEvents:[...(liveState.value.kongEvents??[]),event]}
}
;(window as any).__playBloodFlowScenario = async (kind:'draw'|'discard'|'added-kong'='draw',seat:Seat=0,winners:Seat[]=[seat],patterns:PatternId[]=['all-green'],hard=true) => {
  const id=`scenario-${++serial}`,source={id:`${id}-source`,kind,seat,tile:'s2' as TileType},relative=(seat-viewer+4)%4
  livePlayers.value=livePlayers.value.map((p,i)=>i!==relative?p:{...p,
    ...(kind==='draw'?{drawnTileIndex:13,concealedTileCount:14,hand:i===0?[...p.hand.slice(0,13),'s2' as TileType]:[]}
      :kind==='discard'?{discards:[...p.discards,'s2' as TileType],drawnTileIndex:-1}
      :{melds:[{type:'peng' as const,tile:'s2' as TileType,tiles:['s2','s2','s2'] as TileType[],from:(relative+1)%4}],concealedTileCount:10,drawnTileIndex:-1})})
  if(kind==='discard')liveLastDiscard.value={tile:'s2',from:relative,id:serial}
  liveState.value={...liveState.value,sourceEvent:source}
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
  if(kind==='draw'&&relative===0){
    const tile=document.querySelector('.hand-tile-slot.drawn')!.getBoundingClientRect(),canvas=document.querySelector('canvas')!.getBoundingClientRect()
    ;(window as any).__bloodFlowPreparedScreen={x:(tile.x+tile.width/2-canvas.x)/canvas.width,y:(tile.y+tile.height/2-canvas.y)/canvas.height}
  }
  livePlayers.value=livePlayers.value.map((p,i)=>i!==relative?p:kind==='discard'?{...p,discards:p.discards.slice(0,-1)}
    :kind==='draw'?{...p,hand:i===0?p.hand.slice(0,-1):[],concealedTileCount:13,drawnTileIndex:-1}:p)
  const winScore=scorePatterns(patterns,hard,kind==='draw'?'self-draw':kind==='added-kong'?'robbed-kong':'discard')
  const records=winners.map(winner=>({id:`${id}-${winner}`,batchId:id,winner,ordinal:liveState.value.seats[winner].winCount+1,sourceEventId:source.id,score:winScore,
    deltas:vector(s=>s===winner?winScore.paymentPerPayer*(kind==='draw'?3:1):kind==='draw'||s===seat?-winScore.paymentPerPayer:0)}))
  const batch:WinBatch={authorityEpoch:'fixture',sequence:serial,roundId:liveState.value.roundId,ruleVersion:liveState.value.ruleVersion,batchId:id,windowId:id,source,winners:records,
    deltas:vector(s=>records.reduce((n,r)=>n+r.deltas[s],0)),scoresAfter:[2000,2000,2000,2000],nextAction:{kind:'draw',seat:((seat+1)%4) as Seat}}
  liveState.value={...liveState.value,sourceEvent:undefined,batches:[...liveState.value.batches,batch],seats:vector(s=>({...liveState.value.seats[s],winCount:liveState.value.seats[s].winCount+(winners.includes(s)?1:0)}))}
  announceBatch(batch)
}
createApp({setup(){
  if(query.get('audio')==='1'){
    const audio=useAudio();audio.bgmOn.value=false;(window as any).__bfAudio=audio;(window as any).__bfFixedCalls=0
    const fixed=query.has('fixedTts')?{cancel:()=>{},executeAction:async({action}:any)=>{(window as any).__bfFixedCalls++;if(query.get('fixedTts')==='fail')throw new Error('fixture TTS unavailable');const file=animeFallbackAudioForAction(action);if(file)audio.playEffect(file);return {fallbackAudioFile:null}}}:undefined
    actionAudio=createBloodFlowAudioBridge({theme:()=>theme,epoch:()=>liveState.value.roundId,player:i=>livePlayers.value[i],play:audio.playEffect,fixed:fixed as any})
  }
  return () => h('main', { class: 'game-app', 'data-theme': theme, 'data-table-theme': theme, style: css }, [h('div', { class: 'has-three-scene' }, [h(GameTableHud, {
  ...props, players:livePlayers.value,user:livePlayers.value[0],lastDiscard:liveLastDiscard.value,bloodFlow: liveState.value, tableActionEvent: liveAction.value,
  phase: liveState.value.roundResult ? 'settled' : props.phase,
  revealHands: Boolean(liveState.value.roundResult), matchFinished: liveFinished.value,
  isUserTurn: !liveState.value.roundResult && !query.has('controls'), userCanHu: !liveState.value.roundResult && !query.has('controls'),
  ...hudState.value,
  ...(query.has('common') ? {bloodFlow:null,rulesetId:'lotus-legacy'} : {}),
  onNextRound: () => { navigation.nextRoundCalls++ },
  onReturnToLobby: () => { navigation.returnToLobbyCalls++ },
})]), ...(query.has('controls') ? [h('nav', {style:'position:fixed;left:2px;top:2px;z-index:100;display:flex;gap:3px'}, [
  h('button', {style:'font-size:10px;padding:2px',onClick:()=> (window as any).__playBloodFlowScenario('draw',0,[0],['pinghu'],false)}, '普通自摸'),
  h('button', {style:'font-size:10px;padding:2px',onClick:()=> (window as any).__playBloodFlowScenario('discard',1,[0],['pinghu'],false)}, '普通点炮'),
  h('button', {style:'font-size:10px;padding:2px',onClick:()=> (window as any).__playBloodFlowScenario('draw',0,[0],['all-green'],true)}, '高番自摸'),
  h('button', {style:'font-size:10px;padding:2px',onClick:()=> (window as any).__appendBloodFlowMultiWin()}, '三响'),
  ...(query.has('hudStates') ? (['waiting','selection','preview'] as const).map((state,index)=>h('button', {
    style:'font-size:10px;padding:2px',onClick:()=>showHudState(state),
  }, ['等待画面','选牌画面','可胡画面'][index])) : []),
])] : [])]) }}).mount('#app')
// Shared layout stress input; the same players are used in ordinary and continuous-win modes.
;(window as any).__setCornerLayout = (meldCount:number, winner:number|null=null) => {
  const layoutPlayers:GamePlayer[]=[0,1,2,3].map(seat=>({seat,name:['东家','南家','西家','北家'][seat],avatar:defaultAvatarForSeat(seat),score:2000,redCount:0,
    drawnTileIndex:-1,hand:Array(13-meldCount*3).fill('m2'),concealedTileCount:13-meldCount*3,discards:Array(28).fill('p1'),
    melds:Array.from({length:meldCount},(_,i)=>({type:i===0?'gang':'peng',added:i===0,tile:'s2',tiles:Array(i===0?4:3).fill('s2'),from:(seat+1)%4}))}))
  hudState.value={players:layoutPlayers,user:layoutPlayers[0],isUserTurn:winner===null,userCanHu:winner===null,
    actionPrompt:winner===null?{type:'claim',canHu:true,canPeng:true,canGang:true,chiOptions:[]}:null,
    ...(winner===null?{}:{bloodFlow:null,rulesetId:'lotus-legacy',revealHands:true,
      winPresentation:{winnerIndex:winner,tile:'m5',discardWin:true,robbedKong:false,sourceIndex:-1}})}
}
