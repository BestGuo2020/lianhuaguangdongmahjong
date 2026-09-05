import {getLocalTtsClient} from './localTtsClient'
import type {LlmStyle} from './config'
import type {LlmSpeechPriority} from './speechPolicy'
import type {LlmAudioPlaybackHooks} from '../core/presentation/llmAudioBus'

/** One synthesis/playback: playing shows text; the shared midpoint releases the caller. */
export async function playDecisionSpeech(options:{
  seat:number;text:string;voiceKey:string;style:LlmStyle;priority:LlmSpeechPriority
  showBubble():void;signal?:AbortSignal;isCurrent?:()=>boolean;waitForCompletion?:boolean
}):Promise<boolean> {
  let shown=false
  const current=()=>!options.signal?.aborted&&options.isCurrent?.()!==false
  const show=()=>{if(shown||!current())return;shown=true;try{options.showBubble()}catch{/* display only */}}
  if(!current())return false
  const hooks:LlmAudioPlaybackHooks={signal:options.signal,isCurrent:options.isCurrent,
    onStarted:show,waitForCompletion:options.waitForCompletion}
  try{return await getLocalTtsClient().speak(options.seat,options.text,options.voiceKey,options.style,options.priority,hooks)}
  catch{return false}
  finally{show()} // Muted/unavailable audio still leaves readable text and releases the action.
}
