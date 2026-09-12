import {buildCandidateFeatures, buildPublicDecisionSnapshot, unknownCandidateFeatures, type DecisionInput} from './candidates'
import {candidateLine} from './prompt'
import type {Candidate, CanonicalAction} from './schema'
import {tileName} from '../core/rules/tiles'
import {bloodFlowAiActions, decideBloodFlowAction, decideBloodFlowActionEv} from '../variants/lotus/bloodFlow/ai'
import type {BloodFlowAiConfig} from '../variants/lotus/bloodFlow/config'
import {BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG} from '../variants/lotus/bloodFlow/config'
import {bloodFlowEvContext} from '../variants/lotus/bloodFlow/evContext'
import {visibleTiles, type BloodFlowSeatView} from '../variants/lotus/bloodFlow/seatView'
import type {BloodFlowAction} from '../variants/lotus/bloodFlow/state'

export interface BloodFlowDecisionMetadata {roundIndex?:number;dealerIndex?:number;seatWind?:string;roundWind?:string}
export const BLOOD_FLOW_PROMPT_RULES = '莲花麻将血流：沿用翻精、白板受限替代、数牌吃和字牌顺；支持平胡、七对、十三幺、十三烂、七星十三烂及清一色、混一色、碰碰胡、大小三元、大小四喜、九莲宝灯、绿一色、清幺九、混幺九、三暗刻、四暗刻、字一色、三杠、四杠。自然成立硬胡×2；真实倍率、封顶和收益以 currentWin 为准。可点炮、多响和抢补杠，胡后继续；首次胡锁手，之后只能处理新摸牌，已胡仍付款；牌墙耗尽才结算。候选 features.ev 为本地期望收益估算（自摸按 2 倍×3 家、锁手连锁、首胡门槛、改张/单吊任意听、抢杠两值），仅作依据；早局低番胡会锁手，可结合潜力考虑改张或过。点炮赔付=底分10×番型倍率×事件倍率（点炮×1、自摸/抢杠×2、杠上开花×4），单家封顶64倍；同一张牌打给在做大牌（清一色/三元/四喜等）的对手，代价可达平胡的8~32倍；候选 features.opponentRisk 给出该牌按公共信息估算的赔付档与信号。'

function label(action:BloodFlowAction,view:BloodFlowSeatView):string {
  const player=view.players[view.seat]
  if(action.kind==='discard')return `打出${tileName(player.hand[action.index])}`
  if(action.kind==='chi')return `吃${action.tiles.map(tileName).join('')}`
  if(action.kind==='concealed-kong')return `暗杠${tileName(action.tile)}`
  if(action.kind==='added-kong')return `补杠${tileName(player.melds[action.meldIndex].tile)}`
  return {win:'胡牌（首次胡后锁手）',pass:'过',peng:'碰',gang:'直杠','wind-kong':'风杠'}[action.kind]
}

/** Adapt authoritative candidates, never re-enumerate or prune them using old end-of-round rules. */
export function buildBloodFlowDecisionInput(view:BloodFlowSeatView,requestId:string,metadata:BloodFlowDecisionMetadata={},aiConfig:BloodFlowAiConfig=BLOOD_FLOW_AI) {
  const player=view.players[view.seat],actions=bloodFlowAiActions(view),source=view.window?.source
  const chiActions=actions.filter((a):a is Extract<BloodFlowAction,{kind:'chi'}>=>a.kind==='chi')
  const canonical=(a:BloodFlowAction):CanonicalAction=>a.kind==='discard'?{kind:'discard',handIndex:a.index}
    :a.kind==='chi'?{kind:'chi',optionIndex:chiActions.indexOf(a)}:a
  const claim=view.window?.kind!=='turn'
  const lastAction=view.actionEvents.at(-1)
  const turnOrigin=player.drawnTileIndex<0&&lastAction?.actorIndex===view.seat
    ?lastAction.type==='chi'?'chi':lastAction.type==='peng'?'peng':'draw':'draw'
  const publicTiles=[view.flipTile,...view.players.flatMap(p=>[...p.discards,...p.melds.flatMap(m=>m.tiles)]),...view.public.batches.map(b=>b.source.tile)]
  const deltaFor=(action:CanonicalAction):number|null=>{
    const kind=action.kind==='gang'?'discard':action.kind==='added-kong'?'added':action.kind==='concealed-kong'?'concealed':action.kind==='wind-kong'?'wind':null
    return kind?BLOOD_FLOW_CONFIG.basePoints*BLOOD_FLOW_CONFIG.kongPayments[kind]*(kind==='discard'?1:3):null
  }
  // The tile-structure evaluator is the existing lotus evaluator; only scoring
  // is overridden. The public request below carries the actual blood-flow ID.
  const input:DecisionInput={ruleCode:'lotus-legacy',decision:claim?'claim':'turn',playerIndex:view.seat,
    hand:player.hand,melds:player.melds,exposedMelds:player.melds.length,jokerTiles:view.jokers,wildcardTiles:['white'],
    visibleTiles:visibleTiles(view),publicTiles,peers:view.players.map(player=>({...player,
      winCount:view.public.seats[player.seat]?.winCount??0,locked:view.public.seats[player.seat]?.locked??false})),scores:view.players.map(p=>p.score),
    tile:claim?source?.tile:undefined,from:claim?source?.seat:undefined,
    chiOptions:chiActions.map(a=>({kind:/^[mps]/.test(a.tiles[0])?'sequence':['east','south','west','north'].includes(a.tiles[0])?'wind':'dragon',tiles:a.tiles})),
    upperLastDiscard:view.players[(view.seat+3)%4].discards.at(-1),wallCount:view.wallCount,
    opponentPatternRisk:aiConfig.opponentPatternRisk,
    earlyRound:player.discards.length<2,turnOrigin,drawnTile:player.hand[player.drawnTileIndex]??null,
    requestId,stateVersion:String(view.version),scoreDeltaForAction:deltaFor,
    seatWind:metadata.dealerIndex==null?undefined:['东','南','西','北'][(view.seat-metadata.dealerIndex+4)%4],
    roundWind:metadata.roundIndex==null?undefined:metadata.roundIndex<=4?'东':'南',...metadata}
  const validShape=[13,14].includes(player.hand.length+3*player.melds.length)
  // EV 特征与默认推荐同源：本地贪婪决策的结果就是 engineSuggestion；llmEvFeatures 关闭时回退旧提示词。
  const useEv=aiConfig.llmEvFeatures&&validShape
  const evCtx=useEv?bloodFlowEvContext(view,aiConfig):null
  const recommended=validShape?(useEv?decideBloodFlowActionEv(view,aiConfig):decideBloodFlowAction(view)):actions[0]
  const candidates=actions.map((action,index)=>{
    const mapped=canonical(action)
    const features=validShape&&action.kind!=='win'?buildCandidateFeatures(input,mapped,'unknown'):unknownCandidateFeatures()
    if(action.kind==='win'){
      features.ready=true
      if(view.ownScore){
        features.scoreDelta=view.ownScore.paymentPerPayer*(source?.kind==='draw'?3:1)
        features.scoreDeltaBand=features.scoreDelta>=400?'高':features.scoreDelta>0?'中':'n/a'
      }
      features.specialPattern=view.ownScore?.items.map(p=>p.label).join('、')??'n/a'
      if(!view.public.seats[view.seat].locked)features.risks.push('首次胡后锁手，不能再改手或吃碰杠；比较当前收益和后续听口')
    }
    if(evCtx){
      if(action.kind==='win'){
        const declined=Boolean(view.ownScore&&view.ownScore.paymentPerPayer<evCtx.floor&&evCtx.potentialTotal>=aiConfig.potentialFloor)
        features.ev={win:{immediateTotal:evCtx.immediateTotal,lockedChain:Math.round(evCtx.chainAfterWin),
          floor:evCtx.floor,floorStage:evCtx.floorStage,
          ...(declined?{declinedReason:evCtx.topDirections.map(d=>BLOOD_FLOW_CONFIG.patterns[d.id].label).join('、')||'牌型潜力'}:{})},
        ...(evCtx.robEv?{rob:evCtx.robEv}:{})}
      } else if(action.kind==='discard'){
        const reform=evCtx.reformCandidates.find(c=>c.index===action.index)
        if(reform)features.ev={reform:{chain:Math.round(reform.ev),anyWait:reform.anyWait,waitCount:reform.waitCount,patterns:reform.patterns}}
      } else if(action.kind==='pass'&&evCtx.winOffered){
        features.ev={developEv:Math.round(evCtx.developEv),...(evCtx.robEv?{rob:evCtx.robEv}:{})}
      }
    }
    const common:Candidate={id:`A${index}`,label:label(action,view),action:mapped,features,legalityKey:JSON.stringify(action)}
    return {...common,action,canonical:common,summary:candidateLine(common,'lotus-blood-flow')}
  })
  const state={...buildPublicDecisionSnapshot(input),ruleCode:'lotus-blood-flow' as const}
  const request={ruleCode:'lotus-blood-flow',state,candidates:candidates.map(c=>c.canonical),
    engineSuggestion:candidates.find(c=>JSON.stringify(c.action)===JSON.stringify(recommended))?.id}
  return {candidates,request}
}
