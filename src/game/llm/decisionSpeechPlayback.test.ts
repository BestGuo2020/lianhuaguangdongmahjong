import {afterEach,expect,it,vi} from 'vitest'
import {playDecisionSpeechWithStartupLimit} from './decisionSpeechPlayback'
const speak=vi.hoisted(()=>vi.fn())
vi.mock('./localTtsClient',()=>({getLocalTtsClient:()=>({speak})}))
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks()})
const options=()=>{const controller=new AbortController();return {seat:1,text:'这张先走，好戏在后头。',voiceKey:'kimi',style:'话痨' as const,
 priority:'normal' as const,showBubble:vi.fn(),signal:controller.signal,startupWaitMs:4000,abort:()=>controller.abort()}}

it('slow synthesis followed by speech is not cancelled at the old total four-second limit',async()=>{
 vi.useFakeTimers()
 speak.mockImplementation((_seat,_text,_voice,_style,_priority,hooks)=>new Promise(resolve=>{
   setTimeout(()=>hooks.onStarted(),3000)
   setTimeout(()=>resolve(true),5000)
   hooks.signal.addEventListener('abort',()=>resolve(false))
 }))
 const input=options(),done=playDecisionSpeechWithStartupLimit(input)
 let released=false;void done.then(()=>{released=true})
 await vi.advanceTimersByTimeAsync(3000);expect(input.showBubble).toHaveBeenCalledOnce()
 await vi.advanceTimersByTimeAsync(1000);expect(input.signal.aborted).toBe(false);expect(released).toBe(false)
 await vi.advanceTimersByTimeAsync(1000);await expect(done).resolves.toBe(true)
 expect(input.signal.aborted).toBe(false)
})

it('unstarted synthesis or queued audio still times out and leaves a bubble',async()=>{
 vi.useFakeTimers();speak.mockImplementation(()=>new Promise(()=>{}))
 const input=options(),done=playDecisionSpeechWithStartupLimit(input)
 await vi.advanceTimersByTimeAsync(4000)
 await expect(done).resolves.toBe(false);expect(input.signal.aborted).toBe(true)
 expect(input.showBubble).toHaveBeenCalledOnce()
})

it('muted/failing audio immediately releases the action and does not create a later abort',async()=>{
 vi.useFakeTimers();speak.mockResolvedValue(false)
 const input=options()
 await expect(playDecisionSpeechWithStartupLimit(input)).resolves.toBe(false)
 expect(input.showBubble).toHaveBeenCalledOnce()
 await vi.advanceTimersByTimeAsync(4000);expect(input.signal.aborted).toBe(false)
})

it('synchronous start clears the startup timer and cleanup cancellation still reaches the utterance',async()=>{
 vi.useFakeTimers();speak.mockImplementation((_s,_t,_v,_style,_priority,hooks)=>new Promise(resolve=>{
   hooks.onStarted();hooks.signal.addEventListener('abort',()=>resolve(false))
 }))
 const input=options(),done=playDecisionSpeechWithStartupLimit(input)
 await vi.advanceTimersByTimeAsync(5000);expect(input.signal.aborted).toBe(false)
 input.abort();await expect(done).resolves.toBe(false)
 expect(input.showBubble).toHaveBeenCalledOnce()
})
