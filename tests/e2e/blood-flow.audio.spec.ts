import {expect,test} from '@playwright/test'
test.setTimeout(60_000)
async function track(page:any){await page.addInitScript(()=>{
  const play=HTMLMediaElement.prototype.play;(window as any).__playedEffects=[]
  HTMLMediaElement.prototype.play=function(){if(this.dataset.effectName)(window as any).__playedEffects.push(this);return play.call(this)}
})}
for(const [theme,fixed] of [['jade',''],['llmAnime','fail'],['llmAnime','success']] as const)for(const kind of ['draw','discard','added-kong'] as const){
  test(`${theme}/${fixed||'legacy'} ${kind}: human voice and impact audio actually advance once`,async({page})=>{
    await track(page)
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=0&audio=1&theme=${theme}${fixed?`&fixedTts=${fixed}`:''}`)
    await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30_000});await page.locator('main.game-app').click({position:{x:8,y:8}})
    await page.evaluate(kind=>(window as any).__playBloodFlowScenario(kind,kind==='draw'?0:1,[0]),kind)
    const voice=kind==='draw'?'zimo.mp3':'hu.mp3'
    const played=()=>page.evaluate(()=>(window as any).__playedEffects.map((a:HTMLAudioElement)=>({name:a.dataset.effectName,volume:a.volume,time:a.currentTime,muted:a.muted})))
    await expect.poll(async()=>(await played()).filter((a:any)=>a.name==='hu_effect_sound.mp3'&&a.time>0&&a.volume>0&&!a.muted).length).toBe(1)
    await expect.poll(async()=>(await played()).filter((a:any)=>a.name===voice&&a.time>0&&a.volume>0&&!a.muted).length).toBe(1)
    expect((await played()).map((a:any)=>a.name).sort()).toEqual([voice,'hu_effect_sound.mp3'].sort())
    if(fixed)expect(await page.evaluate(()=>(window as any).__bfFixedCalls)).toBe(1)
    await page.evaluate(()=>(window as any).__restoreBloodFlow())
    expect((await played()).length).toBe(2)
  })
}
test('a three-win batch has three action voices but one impact, and mute suppresses both routes',async({page})=>{
  await track(page);await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0&audio=1')
  await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30_000});await page.locator('main.game-app').click({position:{x:8,y:8}})
  await page.evaluate(()=>(window as any).__appendBloodFlowMultiWin())
  const names=()=>page.evaluate(()=>(window as any).__playedEffects.map((a:HTMLAudioElement)=>a.dataset.effectName))
  await expect.poll(names).toEqual(['hu.mp3','hu.mp3','hu.mp3','hu_effect_sound.mp3'])
  await page.evaluate(()=>{(window as any).__bfAudio.soundOn.value=false;(window as any).__restoreBloodFlow()})
  await page.evaluate(()=>(window as any).__appendBloodFlowWin())
  await expect(page.locator('.blood-flow-cue')).toHaveCount(1)
  await page.waitForTimeout(1800)
  expect(await names()).toHaveLength(4)
  await page.evaluate(()=>(window as any).__bfAudio.soundOn.value=true)
  expect(await names()).toHaveLength(4)
})
