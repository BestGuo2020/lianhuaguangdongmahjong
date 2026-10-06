import {expect,test} from '@playwright/test'

test('real evaluator worker exposes 34 self-draw waits in a non-winning chi response',async({page})=>{
 test.setTimeout(90_000)
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 let requests=0
 await page.route('https://model.example.test/**',async route=>{
  const body=route.request().postDataJSON(),data=JSON.parse(body.messages[1].content)
  requests++
  expect(data.currentWin).toBeNull()
  expect(data.readyState).toMatchObject({anyWait:true,selfDrawOnly:true,selfDrawWaitCount:34,discardWaitCount:0})
  expect(data.waits).toHaveLength(34)
  expect(data.waits.every((w:any)=>w.selfDrawPerPayer>0&&w.discardPerPayer===null)).toBe(true)
  const chi=data.candidates.find((c:any)=>c.label==='吃四筒五筒六筒')
  const pass=data.candidates.find((c:any)=>c.label==='过')
  expect(chi.features.waitComparison).toMatchObject({breaksAnyWait:true,requiresDiscard:true,after:{selfDrawWaitCount:3,discardWaitCount:1}})
  expect(pass.features.waitComparison.after.anyWait).toBe(true)
  expect(data.publicPlayers.every((p:any)=>!('hand' in p))).toBe(true)
  await route.fulfill({json:{choices:[{message:{content:JSON.stringify({choice:pass.id,message:''})},finish_reason:'stop'}]}})
 })
 await page.goto('/tests/e2e/fixtures/blood-flow-anywait-claim.html',{waitUntil:'domcontentloaded',timeout:60_000})
 await expect(page.locator('#result')).toHaveText('{"kind":"pass"}',{timeout:45_000})
 expect(requests).toBe(1)
 expect(errors).toEqual([])
})
