import {getLocalTtsClient} from './localTtsClient'
import type {LlmStyle} from './config'
import type {LlmSpeechPriority} from './speechPolicy'
import type {LlmAudioPlaybackHooks} from '../core/presentation/llmAudioBus'

/** One synthesis/playback: playing shows text; the shared midpoint releases the caller. */
export interface DecisionSpeechPlaybackOptions {
  seat:number;text:string;voiceKey:string;style:LlmStyle;priority:LlmSpeechPriority
  showBubble():void;signal?:AbortSignal;isCurrent?:()=>boolean;waitForCompletion?:boolean;onStarted?:()=>void
}
export async function playDecisionSpeech(options:DecisionSpeechPlaybackOptions):Promise<boolean> {
  let shown=false
  const current=()=>!options.signal?.aborted&&options.isCurrent?.()!==false
  const show=()=>{if(shown||!current())return;shown=true;try{options.showBubble()}catch{/* display only */}}
  if(!current())return false
  const hooks:LlmAudioPlaybackHooks={signal:options.signal,isCurrent:options.isCurrent,
    onStarted:()=>{if(!current())return;try{options.onStarted?.()}catch{/* playback only */}show()},waitForCompletion:options.waitForCompletion}
  try{return await getLocalTtsClient().speak(options.seat,options.text,options.voiceKey,options.style,options.priority,hooks)}
  catch{return false}
  finally{show()} // Muted/unavailable audio still leaves readable text and releases the action.
}

/** Bound synthesis/queue/startup only; once speaking, the audio player owns its stall guard. */
export async function playDecisionSpeechWithStartupLimit(options:DecisionSpeechPlaybackOptions&{
  startupWaitMs:number;abort():void
}):Promise<boolean> {
  let timer:ReturnType<typeof setTimeout>|undefined
  const startup=new Promise<false>(resolve=>{
    timer=setTimeout(()=>{
      try{options.showBubble()}catch{/* display only */}
      options.abort();resolve(false)
    },options.startupWaitMs)
  })
  try{
    return await Promise.race([playDecisionSpeech({...options,onStarted:()=>{
      if(timer!==undefined){clearTimeout(timer);timer=undefined}
      options.onStarted?.()
    }}),startup])
  }finally{if(timer!==undefined)clearTimeout(timer)}
}
