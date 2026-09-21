import { expect, test } from '@playwright/test'

test.setTimeout(180_000)

test('quota pause is visible, reconnect sends one probe and game calls resume after success', async ({ page }) => {
  let calls = 0, exhausted = true
  await page.route('https://quota-ui.test/**', async route => {
    calls++
    if (exhausted) return route.fulfill({status:403,contentType:'application/json',body:'{"error":{"message":"Free quota exhausted"}}'})
    return route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"choice":"A0","message":""}'}}]})})
  })
  await page.goto('/?theme=llmAnime')
  await page.evaluate(async () => {
    const { saveLlmSettings } = await import('/src/game/llm/config.ts')
    const c = { id:'quota-ui',name:'额度测试',baseUrl:'https://quota-ui.test/v1',apiKey:'mock-only',model:'quota-ui',style:'稳健',timeoutMs:40000 }
    ;(window as any).__quotaConfig=c
    saveLlmSettings({enabled:true,presets:[c],activeId:c.id,seatIds:[null,c.id,c.id,c.id],seatStyles:[null,null,null,null]})
    const { requestLlmDecision } = await import('/src/game/llm/client.ts')
    try { await requestLlmDecision({config:c,messages:{system:'',user:''},candidateIds:['A0']}) } catch { /* expected quota */ }
  })
  await page.getByTestId('llm-fab').click()
  await expect(page.getByRole('status').filter({hasText:'额度耗尽'})).toBeVisible()
  await expect(page.getByTestId('llm-test')).toHaveText('重新连接')
  await page.evaluate(async () => {
    const { requestLlmDecision } = await import('/src/game/llm/client.ts')
    for(let i=0;i<4;i++)try{await requestLlmDecision({config:(window as any).__quotaConfig,messages:{system:'',user:''},candidateIds:['A0']})}catch{/* paused */}
  })
  expect(calls).toBe(1)
  exhausted=false
  await page.getByTestId('llm-test').click()
  await expect(page.getByTestId('llm-test')).toHaveText('测试连接')
  await expect(page.getByRole('status').filter({hasText:'额度耗尽'})).toHaveCount(0)
  expect(calls).toBe(2)
  const result=await page.evaluate(async()=>{
    const { requestLlmDecision }=await import('/src/game/llm/client.ts')
    return requestLlmDecision({config:(window as any).__quotaConfig,messages:{system:'',user:''},candidateIds:['A0']})
  })
  expect(result.choice).toBe('A0');expect(calls).toBe(3)
})

test('three LLM seats finish an east match locally after quota exhaustion without retrying each round', async ({page}) => {
  let calls=0
  await page.addInitScript(()=>localStorage.setItem('llm.providers',JSON.stringify({configVersion:2,enabled:true,
    activeId:'quota-game',seatIds:[null,null,null,null],seatStyles:[null,null,null,null],presets:[{
      id:'quota-game',name:'Quota fixture',providerType:'custom',apiKey:'mock-only',baseUrl:'https://quota-game.test/v1',
      model:'quota-fixture',style:'稳健',timeoutMs:40000,
    }]})))
  await page.route('https://quota-game.test/**',route=>{calls++;return route.fulfill({status:403,contentType:'application/json',body:'{"error":{"message":"Free quota exhausted"}}'})})
  await page.route('**/api/local-tts/**',route=>route.fulfill({status:503,body:'disabled for test'}))
  await page.goto('/?bloodFlow=1')
  await page.evaluate(async()=>{
    const {useBloodFlowGame}=await import('/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts')
    const {buildRingWall}=await import('/src/game/variants/lotus/lotusWall.ts')
    const {seededRandom}=await import('/src/game/variants/lotus/bloodFlow/simulation.ts')
    const game=useBloodFlowGame({autoplay:true,paceMs:0,lockedAutoPlayMs:0,getThemeName:()=> 'llmAnime',playSoundAndWait:async()=>{},
      aiPlayerSeeds:[1,2,3].map(seat=>({name:`Quota${seat}`,avatar:'',isLlm:true,characterId:'deepseek',playerKind:'llm'}))})
    ;(window as any).__quotaGame=game
    await game.startGame('east',{initialWall:buildRingWall(seededRandom(83)),openingDice:[2,3],openingSecondDice:[1,4]})
  })
  await expect.poll(()=>page.evaluate(()=>(window as any).__quotaGame.phase.value),{timeout:90000}).toBe('settled')
  expect(calls).toBeGreaterThan(0);expect(calls).toBeLessThanOrEqual(3)
  const firstRoundCalls=calls
  for(let round=2;round<=4;round++){
    await page.evaluate(async round=>{
      const {buildRingWall}=await import('/src/game/variants/lotus/lotusWall.ts')
      const {seededRandom}=await import('/src/game/variants/lotus/bloodFlow/simulation.ts')
      await (window as any).__quotaGame.nextRound({initialWall:buildRingWall(seededRandom(83+round)),openingDice:[2,3],openingSecondDice:[1,4]})
    },round)
    await expect.poll(()=>page.evaluate(()=>(window as any).__quotaGame.phase.value),{timeout:90000}).toBe('settled')
    expect(calls).toBe(firstRoundCalls)
  }
  const end=await page.evaluate(()=>{
    const game=(window as any).__quotaGame,result={finished:game.matchFinished.value,round:game.round.value,sum:game.players.reduce((n:number,p:any)=>n+p.score,0)}
    game.returnToLobby();return result
  })
  expect(end).toEqual({finished:true,round:4,sum:8000})
})
