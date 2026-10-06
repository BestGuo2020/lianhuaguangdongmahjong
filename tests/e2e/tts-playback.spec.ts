import {expect,test} from '@playwright/test'

function silentWav(seconds:number){
 const samples=8000*seconds,bytes=Buffer.alloc(44+samples*2)
 bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8)
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22)
 bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34)
 bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);return bytes
}
for(const mode of ['discard','load'] as const){
 test(`real media: ${mode} startup delay does not truncate the utterance`,async({page})=>{
  test.setTimeout(60_000)
  await page.addInitScript(()=>{
   localStorage.setItem('lianhua-guangma:audio-preferences:v1',JSON.stringify({soundOn:true,bgmOn:false,effectsOn:true}))
   const NativeAudio=window.Audio,events:Array<{type:string;at:number;time:number}>=[]
   ;(window as any).__ttsEvents=events
   ;(window as any).Audio=function(src?:string){
    const audio=new NativeAudio(src)
    if(src?.includes('/api/local-tts/audio/')){
     for(const type of ['playing','ended','error'])audio.addEventListener(type,()=>events.push({type,at:performance.now(),time:audio.currentTime}))
     const pause=audio.pause.bind(audio)
     audio.pause=()=>{events.push({type:'pause',at:performance.now(),time:audio.currentTime});pause()}
    }
    return audio
   }
  })
  await page.route('**/audio/**',route=>route.abort())
  await page.route('**/api/local-tts/synthesize',async route=>{
   await new Promise(resolve=>setTimeout(resolve,3000))
   await route.fulfill({json:{audioUrl:`/api/local-tts/audio/${'a'.repeat(64)}.mp3`,cacheKey:'fixture',cached:false}})
  })
  await page.route('**/api/local-tts/audio/**',async route=>{
   if(mode==='load')await new Promise(resolve=>setTimeout(resolve,9000))
   await route.fulfill({contentType:'audio/wav',body:silentWav(mode==='load'?8:4)})
  })
  await page.goto('/tests/e2e/fixtures/tts-playback.html',{waitUntil:'domcontentloaded'})
  await page.locator(`#${mode}`).click()
  await expect(page.locator('#result')).toHaveText('midpoint',{timeout:25_000})
  const atMidpoint=await page.evaluate(()=>(window as any).__ttsEvents)
  expect(atMidpoint.some((e:any)=>e.type==='playing')).toBe(true)
  expect(atMidpoint.some((e:any)=>e.type==='pause'||e.type==='ended'||e.type==='error')).toBe(false)
  await expect.poll(()=>page.evaluate(()=>(window as any).__ttsEvents.some((e:any)=>e.type==='ended')),{timeout:15_000}).toBe(true)
  expect(await page.evaluate(()=>(window as any).__ttsEvents.filter((e:any)=>e.type==='pause'||e.type==='error'))).toEqual([])
 })
}
