import type {BloodFlowSeatView} from '../variants/lotus/bloodFlow/seatView'
import type {BloodFlowAction} from '../variants/lotus/bloodFlow/state'
import type {Seat} from '../variants/lotus/bloodFlow/types'
import type {TableActionEvent,TileType} from '../core/contracts/types'
import type {CanonicalAction} from './schema'
import type {LlmProviderPreset,LlmStyle,LlmTtsVoiceKey} from './config'
import {LlmSpeechPolicy} from './speechPolicy'
import {resolveDecisionSpeech} from './decisionSpeech'
import {resolveLocalTtsVoiceKey} from './localTtsClient'
import {tileName} from '../core/rules/tiles'

export interface BloodFlowActionSpeech {
  id:string;authorityEpoch:string;roundId:string;seat:Seat;stateVersion:number
  eventKind:'discard'|'action';eventId:string;actionType:string;text:string;style:LlmStyle
  voiceKey:Exclude<LlmTtsVoiceKey,'auto'>;theme:'llm'|'llmAnime'
}
const allowed=(theme:string):theme is BloodFlowActionSpeech['theme']=>theme==='llm'||theme==='llmAnime'
const actionEventType=(action:BloodFlowAction):TableActionEvent['type']|null=>action.kind==='peng'?'peng':action.kind==='chi'?'chi':action.kind==='gang'?'discard-gang'
  :action.kind==='added-kong'?'added-gang':action.kind==='concealed-kong'?'concealed-gang':action.kind==='wind-kong'?'wind-kong':null
export function actionSpeechMatches(line:BloodFlowActionSpeech,view:BloodFlowSeatView){
  if(view.authorityEpoch!==line.authorityEpoch||view.roundId!==line.roundId||view.public.status!=='playing'||view.public.roundResult||view.version<line.stateVersion)return false
  return line.eventKind==='discard'?view.lastDiscardAction?.id===line.eventId&&view.lastDiscardAction.seat===line.seat
    :view.actionEvents.some(e=>String(e.id)===line.eventId&&e.actorIndex===line.seat&&e.type===line.actionType)
}
/** Store only a proposed line; emit nothing until a public action proves that choice executed. */
export function createBloodFlowActionSpeech(theme:()=>string,now:()=>number=Date.now){
  const policy=new LlmSpeechPolicy(now)
  const pending=new Map<string,{before:BloodFlowSeatView;action:BloodFlowAction;message:string;style:LlmStyle;voiceKey:Exclude<LlmTtsVoiceKey,'auto'>;theme:BloodFlowActionSpeech['theme']}>()
  let sequence=0
  return {
    plan(id:string,before:BloodFlowSeatView,action:BloodFlowAction,provider:LlmProviderPreset,message:string|undefined,requestedTheme:string){
      if(!allowed(requestedTheme)||theme()!==requestedTheme||before.ownScore||before.ownActions.some(a=>a.kind==='win')||before.public.seats[before.seat].locked||action.kind==='win'||action.kind==='pass')return
      pending.set(id,{before,action,message:message??'',style:provider.style,voiceKey:resolveLocalTtsVoiceKey(provider),theme:requestedTheme})
    },
    observe(after:BloodFlowSeatView):BloodFlowActionSpeech[]{
      const lines:BloodFlowActionSpeech[]=[]
      if(after.public.status!=='playing'){if(after.public.status!=='paused')pending.clear();return lines}
      for(const [id,p] of pending){
        const b=p.before,seat=b.seat
        if(after.authorityEpoch!==b.authorityEpoch||after.roundId!==b.roundId||after.public.roundResult||theme()!==p.theme||now()>=(b.window?.deadlineAt??0)){pending.delete(id);continue}
        let eventKind:BloodFlowActionSpeech['eventKind']='action',eventId='',actionType=''
        if(p.action.kind==='discard'){
          const d=after.lastDiscardAction
          if(d&&d.id!==b.lastDiscardAction?.id&&d.seat===seat&&d.tile===b.players[seat].hand[p.action.index]){eventKind='discard';eventId=d.id;actionType='discard'}
        }else{
          const wanted=actionEventType(p.action),baseline=b.actionEvents.at(-1)?.id??0
          const expectedTile=p.action.kind==='concealed-kong'?p.action.tile:p.action.kind==='wind-kong'?'east':p.action.kind==='added-kong'?b.players[seat].melds[p.action.meldIndex]?.tile:b.window?.source.tile
          const event=after.actionEvents.find(e=>e.id>baseline&&e.actorIndex===seat&&e.type===wanted&&e.tile===expectedTile)
          if(event){eventId=String(event.id);actionType=event.type}
        }
        if(!eventId){
          const awaitingAdded=p.action.kind==='added-kong'&&after.window?.source.kind==='added-kong'&&after.window.source.seat===seat
          if(after.window?.id!==b.window?.id&&!awaitingAdded)pending.delete(id)
          continue
        }
        pending.delete(id)
        if(!policy.admit({seat,style:p.style,priority:eventKind==='discard'?'normal':'important'}))continue
        const canonical:CanonicalAction=p.action.kind==='discard'?{kind:'discard',handIndex:p.action.index}:p.action.kind==='chi'?{kind:'chi',optionIndex:0}:p.action
        const discarded=p.action.kind==='discard'?tileName(b.players[seat].hand[p.action.index]):undefined
        // Ordinary action lines cannot turn into Hu commentary or unsupported dealer claims.
        const message=/胡|自摸|赢了|输了|封顶|庄家|本庄/.test(p.message)?'':p.message
        const last=b.lastDiscardAction,relative=last?(last.seat-seat+4)%4:0
        const text=resolveDecisionSpeech(message,canonical,p.style,++sequence,{discardedTile:discarded,
          currentDiscard:last&&relative?{from:({1:'下家',2:'对家',3:'上家'} as const)[relative as 1|2|3],tile:tileName(last.tile)}:null,
          concealedTiles:b.players[seat].hand.map(tileName),publicMeldTypes:{上家:after.players[(seat+3)%4].melds.map(m=>m.type),对家:after.players[(seat+2)%4].melds.map(m=>m.type),下家:after.players[(seat+1)%4].melds.map(m=>m.type)}})
        if(text)lines.push({id,authorityEpoch:b.authorityEpoch,roundId:b.roundId,seat,stateVersion:after.version,eventKind,eventId,actionType,text,style:p.style,voiceKey:p.voiceKey,theme:p.theme})
      }
      return lines
    },
    reset(){pending.clear();policy.reset()},
  }
}
