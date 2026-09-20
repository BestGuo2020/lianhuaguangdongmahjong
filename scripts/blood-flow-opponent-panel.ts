/** Offline robustness panel. Every decision receives only the acting seat's observable view. */
import { BloodFlowEngine } from '../src/game/variants/lotus/bloodFlow/engine'
import { decideBloodFlowAction, decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'
import { BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG, type BloodFlowAiConfig } from '../src/game/variants/lotus/bloodFlow/config'
import { bloodFlowEvContext } from '../src/game/variants/lotus/bloodFlow/evContext'
import { waitingTilesCached } from '../src/game/variants/lotus/bloodFlow/patternPotentials'
import { bloodFlowSeatView, type BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { seededRandom } from '../src/game/variants/lotus/bloodFlow/simulation'
import { SEATS, vector, type BloodFlowAction } from '../src/game/variants/lotus/bloodFlow/state'
import type { Seat } from '../src/game/variants/lotus/bloodFlow/types'
import { BASELINE_AI, baseline, nextSeatToAct, restoreEngine, snapshotEngine, submit, type Policy } from './blood-flow-counterfactual'

// Historical panel/control/opponents stay at the accepted experiment's pre-promotion policy.
export const PANEL_CURRENT_CONFIG = Object.freeze({ ...BLOOD_FLOW_AI, chainForecast:'legacy' as const, opportunityCalibration:undefined, routeOpportunityGuard:true, claimMeldProjection:true, claimReadyNetGuard:true })
export const panelCurrent: Policy = view => decideBloodFlowActionEv(view,PANEL_CURRENT_CONFIG)
export const PANEL_BASE_CONFIG = BASELINE_AI
export const ATTACK_CONFIG: BloodFlowAiConfig = Object.freeze({ ...PANEL_CURRENT_CONFIG,
  defense:Object.freeze({...BLOOD_FLOW_AI.defense,mode:'off' as const}),opponentPatternRisk:'off',
  safetyCostNone:0,safetyCostOne:0,safetyCostSafe:0,bigHandRoute:Object.freeze({...BLOOD_FLOW_AI.bigHandRoute,mode:'off' as const}),
  firstWinFloorEarly:0,firstWinFloorMid:0,firstWinFloorLate:0 })
export const DEFENSIVE_CONFIG: BloodFlowAiConfig = Object.freeze({ ...PANEL_CURRENT_CONFIG,
  safetyCostNone:BLOOD_FLOW_AI.safetyCostNone*2,safetyCostOne:BLOOD_FLOW_AI.safetyCostOne*2,
  riskFactorTier1:BLOOD_FLOW_AI.riskFactorTier1*2,riskFactorTier2:BLOOD_FLOW_AI.riskFactorTier2*2,
  riskFactorTier3:BLOOD_FLOW_AI.riskFactorTier3*2 })
export const OPPONENTS: Record<string,Policy> = {
  legacy:view=>decideBloodFlowAction(view,0),
  attack:view=>view.ownActions.find(a=>a.kind==='win')??decideBloodFlowActionEv(view,ATTACK_CONFIG),
  defensive:view=>decideBloodFlowActionEv(view,DEFENSIVE_CONFIG),
}
export type PanelId='legacy'|'attack'|'defensive'|'mixed'
export function opponentFor(panel:PanelId,seed:number,focal:Seat,seat:Seat):Policy {
  if(seat===focal)throw new Error('Focal seat is not an opponent')
  if(panel!=='mixed')return OPPONENTS[panel]
  const relative=(seat-focal+4)%4-1
  return OPPONENTS[['legacy','attack','defensive'][(relative+seed%3)%3]]
}
function roundEngine(seed:number,round:number,scores:readonly[number,number,number,number]) {
  return new BloodFlowEngine({authorityEpoch:'opponent-panel',roundId:`${seed}/${round}`,
    dealer:(round%4) as Seat,scores,random:seededRandom((Math.imul(seed,4)+round)>>>0),now:()=>0,winBeatMs:0,paced:false})
}
function actionFor(engine:BloodFlowEngine,seat:Seat,policy:Policy) {
  const view=bloodFlowSeatView(engine,seat)
  if(view.players.some(p=>p.seat!==seat&&p.hand.length))throw new Error('Opponent hand leaked')
  const action=policy(view)
  if(!action)throw new Error('Policy returned no action')
  return {view,action}
}
const key=(action:BloodFlowAction)=>JSON.stringify(action)

interface Income {gross:number;payments:number;kongNet:number;wins:number}
function income(engine:BloodFlowEngine,seat:Seat,start:number):Income {
  let gross=0,payments=0,kongNet=0,wins=0
  for(const entry of engine.ledger.slice(start)) {
    if(entry.kind==='kong'){kongNet+=entry.deltas[seat];continue}
    for(const winner of entry.batch.winners) {
      const delta=winner.deltas[seat]
      if(delta>0)gross+=delta
      if(delta<0)payments-=delta
      if(winner.winner===seat)wins++
    }
  }
  return {gross,payments,kongNet,wins}
}
export interface CalibrationObservation {
  panel:PanelId;seed:number;focal:Seat;round:number;windowId:string;wall:number;stage:string;anyWait:boolean
  predictedChain:number;immediate:number;ownDrawsObserved:number;horizonStopped:boolean
  horizonGross:number;horizonPayments:number;horizonKongNet:number;horizonNet:number
  fullRemainingGross:number;fullRemainingNet:number
}

/** Observes the first ACTUAL self-draw win of an unlocked focal seat, not a selected successful alternative.
 * Fixed target: subsequent income before the ninth own draw (including replacement draws), or round end.
 * This is an operational calibration target, not an assertion that the heuristic models all these events.
 */
export function calibrationTracker(panel:PanelId,seed:number,focal:Seat,round:number) {
  let active: {prediction:Omit<CalibrationObservation,'ownDrawsObserved'|'horizonStopped'|'horizonGross'|'horizonPayments'|'horizonKongNet'|'horizonNet'|'fullRemainingGross'|'fullRemainingNet'>;
    start:number;draws:Set<string>;horizon:Income|null;stopped:boolean}|null=null
  return {
    before(engine:BloodFlowEngine,seat:Seat,view:BloodFlowSeatView,action:BloodFlowAction){
      if(active&&seat===focal&&view.window?.kind==='turn'&&view.window.source.kind==='draw'&&!active.horizon){
        active.draws.add(view.window.source.id)
        if(active.draws.size>8){active.horizon=income(engine,focal,active.start);active.stopped=true}
      }
      if(!active&&seat===focal&&action.kind==='win'&&!view.public.seats[focal].locked
        &&view.window?.kind==='turn'&&view.window.source.kind==='draw'){
        const ev=bloodFlowEvContext(view,PANEL_CURRENT_CONFIG),p=view.players[focal]
        const locked=p.hand.filter((_,i)=>i!==p.drawnTileIndex)
        active={prediction:{panel,seed,focal,round,windowId:view.window.id,wall:view.wallCount,stage:ev.floorStage,
          anyWait:waitingTilesCached(locked,p.melds.length,view.jokers).length>=34,
          predictedChain:ev.chainAfterWin,immediate:ev.immediateTotal},start:engine.ledger.length,draws:new Set(),horizon:null,stopped:false}
      }
    },
    finish(engine:BloodFlowEngine):CalibrationObservation|null {
      if(!active)return null
      const full=income(engine,focal,active.start),h=active.horizon??full,immediate=active.prediction.immediate
      if(h.gross<immediate)throw new Error('First self-draw income missing')
      return {...active.prediction,ownDrawsObserved:Math.min(8,active.draws.size),horizonStopped:active.stopped,
        horizonGross:h.gross-immediate,horizonPayments:h.payments,horizonKongNet:h.kongNet,
        horizonNet:h.gross-immediate-h.payments+h.kongNet,
        fullRemainingGross:full.gross-immediate,fullRemainingNet:full.gross-immediate-full.payments+full.kongNet}
    },
  }
}

export interface PanelPair {
  panel:PanelId;seed:number;focal:Seat;rounds:number;controlNet:number;currentNet:number;delta:number
  controlRank:number;currentRank:number;changed:boolean;changes:{round:number;wall:number;from:BloodFlowAction;to:BloodFlowAction}[]
  calibration:CalibrationObservation[];actualCommands:number
}

/** Same four deals, same fixed opponent policies in BOTH arms. Absolute score and paired improvement
 * are distinct here: the four control focal seats play different tables and need not average to zero.
 */
export function panelPair(panel:PanelId,seed:number,focal:Seat,rounds=4,optimized=true,
  candidate:Policy=panelCurrent,control:Policy=baseline,collectCalibration=true):PanelPair {
  const initial=vector(()=>BLOOD_FLOW_CONFIG.initialScore)
  let scores=initial,commands=0
  let fork:{round:number;state:Record<string,unknown>}|null=null
  const controlObservations:CalibrationObservation[]=[]
  for(let round=0;round<rounds;round++){
    const engine=roundEngine(seed,round,scores),tracker=calibrationTracker(panel,seed,focal,round)
    let step=0
    while(!engine.result){
      if(++step>2000)throw new Error('Control stalled')
      const seat=nextSeatToAct(engine),policy=seat===focal?control:opponentFor(panel,seed,focal,seat)
      const {view,action}=actionFor(engine,seat,policy)
      if(optimized&&!fork&&seat===focal){
        const next=candidate(view)
        if(!next)throw new Error('No candidate action')
        if(key(next)!==key(action))fork={round,state:snapshotEngine(engine)}
      }
      // Only observations strictly before divergence can be reused as candidate observations.
      if(collectCalibration&&!fork)tracker.before(engine,seat,view,action)
      submit(engine,seat,action);commands++
    }
    if(collectCalibration&&!fork){const observation=tracker.finish(engine);if(observation)controlObservations.push(observation)}
    scores=vector(s=>engine.players[s].score)
  }
  const controlNet=scores[focal]-initial[focal],controlRank=1+scores.filter(score=>score>scores[focal]).length
  if(optimized&&!fork)return {panel,seed,focal,rounds,controlNet,currentNet:controlNet,delta:0,controlRank,currentRank:controlRank,
    changed:false,changes:[],calibration:controlObservations,actualCommands:commands}
  const observations:CalibrationObservation[]=[]
  const changes:PanelPair['changes']=[]
  let candidateScores=initial
  const start=optimized?fork!.round:0
  if(optimized)observations.push(...controlObservations.filter(o=>o.round<start))
  for(let round=start;round<rounds;round++){
    const engine=optimized&&round===start?restoreEngine(fork!.state):roundEngine(seed,round,candidateScores)
    const tracker=calibrationTracker(panel,seed,focal,round)
    let step=0
    while(!engine.result){
      if(++step>2000)throw new Error('Candidate stalled')
      const seat=nextSeatToAct(engine),policy=seat===focal?candidate:opponentFor(panel,seed,focal,seat)
      const {view,action}=actionFor(engine,seat,policy)
      if(seat===focal){const old=control(view);if(!old)throw new Error('No control action');
        if(key(old)!==key(action))changes.push({round,wall:view.wallCount,from:old,to:action})}
      if(collectCalibration)tracker.before(engine,seat,view,action)
      submit(engine,seat,action);commands++
    }
    candidateScores=vector(s=>engine.players[s].score)
    if(collectCalibration){const observation=tracker.finish(engine);if(observation)observations.push(observation)}
  }
  const currentNet=candidateScores[focal]-initial[focal]
  return {panel,seed,focal,rounds,controlNet,currentNet,delta:currentNet-controlNet,controlRank,
    currentRank:1+candidateScores.filter(score=>score>candidateScores[focal]).length,changed:changes.length>0,changes,
    calibration:observations,actualCommands:commands}
}
