import {useAudio} from '../../../src/game/core/presentation/useAudio'
import {playDecisionSpeechWithStartupLimit} from '../../../src/game/llm/decisionSpeechPlayback'
const audio=useAudio()
const result=document.querySelector('#result')!
document.querySelector('#discard')!.addEventListener('click',()=>{
 const controller=new AbortController()
 void playDecisionSpeechWithStartupLimit({seat:1,text:'这张先走，好戏在后头。',voiceKey:'kimi',style:'话痨',priority:'normal',
   showBubble:()=>{},onStarted:()=>{result.textContent='playing'},signal:controller.signal,startupWaitMs:4000,
   abort:()=>controller.abort()}).then(played=>{result.textContent=played?'midpoint':'cancelled'})
})
document.querySelector('#load')!.addEventListener('click',()=>{
 void audio.playLocalLlmAudioUntilMidpoint(`/api/local-tts/audio/${'b'.repeat(64)}.mp3`,1,2,'normal',
   {onStarted:()=>{result.textContent='playing'}}).then(played=>{result.textContent=played?'midpoint':'cancelled'})
})
