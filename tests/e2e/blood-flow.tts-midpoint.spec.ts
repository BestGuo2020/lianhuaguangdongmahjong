import {expect,test} from '@playwright/test'
import {mkdir,writeFile} from 'node:fs/promises'

// A real decoded four-second audio stream, not a timer pretending to be playback.
function wave(){
  const rate=8000,samples=rate*4,b=Buffer.alloc(44+samples*2)
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16)
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28)
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40)
  for(let i=0;i<samples;i++)b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*330/rate)*1800),44+i*2)
  return b
}
test.setTimeout(60000)
for(const mode of ['success','muted','synthesis-fail','media-fail','leave-synthesis','leave-playing','leave-tail','mute-playing','deadline']) {
  test(`blood-flow TTS gate: ${mode}`,async({page},testInfo)=>{
    let synthCalls=0,release!:()=>void
    const gate=new Promise<void>(r=>{release=r})
    await page.addInitScript(deadline=>{
      localStorage.setItem('llm.providers',JSON.stringify({configVersion:2,enabled:true,activeId:'test',
        seatIds:['test','test','test','test'],seatStyles:['话痨','话痨','话痨','话痨'],presets:[{
          id:'test',name:'test',apiKey:'fixture-only',baseUrl:'https://model.example.test/v1',model:'fixture',style:'话痨',timeoutMs:40000}]}))
      ;(window as any).__midpointCommands=[];(window as any).__ttsAudios=[]
      const play=HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play=function(){if(this.src.includes('/api/local-tts/audio/'))(window as any).__ttsAudios.push(this);return play.call(this)}
      const WorkerBase=window.Worker
      window.Worker=class extends WorkerBase {
        postMessage(message:any,transfer?:any){
          const records=(window as any).__midpointCommands
          if(deadline&&message.kind==='start')message.options.decisionMs=1500
          if(message.kind==='expire')(window as any).__midpointExpired=true
          // Freeze subsequent bots after the first actual command/result, so
          // this test observes one action and its playback tail in isolation.
          if((records.length||(window as any).__midpointExpired)&&message.kind==='view')return
          if(message.kind==='command'&&message.command.action.kind==='discard'){
            const audio=(window as any).__ttsAudios[0]
            records.push({id:message.command.windowId,seat:message.command.seat,time:audio?.currentTime??0,duration:audio?.duration??0})
          }
          super.postMessage(message,transfer??[])
        }
      } as typeof Worker
    },mode==='deadline')
    await page.route('https://model.example.test/**',async route=>{
      const payload=JSON.parse(route.request().postDataJSON().messages[1].content)
      const choice=payload.candidates.find((c:any)=>c.label.startsWith('打出'))?.id??payload.candidates[0].id
      await route.fulfill({json:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({choice,message:'先试试这边的牌路。'})}}]}})
    })
    await page.route('**/api/local-tts/synthesize',async route=>{
      synthCalls++;await gate
      await route.fulfill(mode==='synthesis-fail'?{status:503,body:'unavailable'}
        :{json:{audioUrl:`/api/local-tts/audio/${'a'.repeat(64)}.mp3`}}).catch(()=>{})
    })
    await page.route('**/api/local-tts/audio/**',route=>route.fulfill(mode==='media-fail'
      ?{status:404,body:'missing'}:{contentType:'audio/wav',body:wave()}))
    await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0&audio=1&theme=llm')
    await expect(page.locator('.table-loading')).toHaveCount(0)
    await page.locator('main').click({position:{x:8,y:8}})
    await page.evaluate(async muted=>{
      if(muted)(window as any).__bfAudio.soundOn.value=false
      const {useBloodFlowGame}=await import('/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts')
      const {buildRingWall}=await import('/src/game/variants/lotus/lotusWall.ts')
      const {seededRandom}=await import('/src/game/variants/lotus/bloodFlow/simulation.ts')
      const game=useBloodFlowGame({autoplay:true,paceMs:0,countdownEnabled:false,getThemeName:()=> 'llm',playSoundAndWait:async()=>{}})
      ;(window as any).__midpointGame=game
      await game.startGame('east',{initialWall:buildRingWall(seededRandom(23)),openingDice:[2,3],openingSecondDice:[1,4]})
    },mode==='muted')
    const commands=()=>page.evaluate(()=>(window as any).__midpointCommands)
    if(mode==='muted'){
      await expect.poll(async()=>(await commands()).length).toBe(1)
      expect(synthCalls).toBe(0)
    }else{
      await expect.poll(()=>synthCalls).toBe(1)
      expect(await commands()).toEqual([])
      expect(await page.evaluate(()=>Object.keys((window as any).__midpointGame.capabilities.value.bloodFlow.actionBubbles))).toEqual([])
      if(mode==='leave-synthesis')await page.evaluate(()=>(window as any).__midpointGame.returnToLobby())
      if(mode==='deadline')await page.waitForFunction(()=>(window as any).__midpointExpired)
      release()
      if(mode==='leave-synthesis'||mode==='deadline'){
        await page.waitForTimeout(300)
        expect(await commands()).toEqual([])
        expect(await page.evaluate(()=>(window as any).__ttsAudios.length)).toBe(0)
      }else if(mode==='synthesis-fail'||mode==='media-fail'){
        await expect.poll(async()=>(await commands()).length).toBe(1)
      }else{
        await page.waitForFunction(()=>{const a=(window as any).__ttsAudios[0];return a?.currentTime>=.5})
        expect(await commands()).toEqual([])
        expect(await page.evaluate(()=>Object.values((window as any).__midpointGame.capabilities.value.bloodFlow.actionBubbles).length)).toBe(1)
        if(mode==='leave-playing')await page.evaluate(()=>(window as any).__midpointGame.returnToLobby())
        if(mode==='mute-playing')await page.evaluate(()=>(window as any).__bfAudio.soundOn.value=false)
        if(mode==='leave-playing'){
          await page.waitForTimeout(200);expect(await commands()).toEqual([])
        }else{
          await expect.poll(async()=>(await commands()).length).toBe(1)
          const record=(await commands())[0]
          if(mode==='mute-playing')expect(record.time).toBeLessThan(record.duration/2)
          else expect(record.time).toBeGreaterThanOrEqual(record.duration/2)
          if(mode==='leave-tail')await page.evaluate(()=>(window as any).__midpointGame.returnToLobby())
        }
        if(mode.startsWith('leave-')||mode==='mute-playing'){
          expect(await page.evaluate(()=>(window as any).__ttsAudios[0].paused)).toBe(true)
        }
      }
      expect(synthCalls).toBe(1)
    }
    if(!mode.startsWith('leave-')&&mode!=='deadline'){
      await expect.poll(()=>page.evaluate(()=>(window as any).__midpointGame.view.value?.lastDiscardAction?.seat)).toBe((await commands())[0].seat)
      await page.waitForTimeout(200);expect((await commands()).length).toBe(1)
    }
    const evidence=JSON.stringify({mode,synthCalls,commands:await commands()})
    await mkdir('work/blood-flow-tts-midpoint',{recursive:true})
    await writeFile(`work/blood-flow-tts-midpoint/${mode}.json`,evidence)
    await testInfo.attach('midpoint-evidence',{body:evidence,contentType:'application/json'})
    await page.evaluate(()=>(window as any).__midpointGame.returnToLobby())
  })
}
