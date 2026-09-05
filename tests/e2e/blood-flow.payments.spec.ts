import {expect,test} from '@playwright/test'
test.setTimeout(60_000)
test.use({viewport:{width:1280,height:720}})
test('three winners retain their own patterns and the payer shows the whole payment',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=12&motionScale=3')
  await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30_000})
  await page.evaluate(()=>(window as any).__appendBloodFlowMultiWin())
  await expect(page.locator('.blood-flow-source')).toContainText('三响')
  await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-phase')==='readable')
  for(const [seat,pattern] of [[1,'清一色'],[2,'大三元'],[3,'十三幺']]){
    await expect(page.locator(`[data-title-seat="${seat}"]`)).toContainText(String(pattern))
  }
  await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-phase')==='score')
  for(const [seat,amount] of [[1,80],[2,160],[3,320]]){
    await expect(page.locator(`[data-winner-seat="${seat}"]`)).toHaveText(`+${amount}`)
  }
  await expect(page.locator('[data-payment-seat="0"]')).toBeVisible()
  expect(await page.locator('[data-payment-seat]').evaluateAll(es=>es.sort((a,b)=>Number(a.getAttribute('data-payment-seat'))-Number(b.getAttribute('data-payment-seat'))).map(e=>Number(e.getAttribute('data-payment-amount'))))).toEqual([-560,80,160,320])
  await page.screenshot({path:'test-results/blood-flow-different-patterns-three-win.png'})
})
test('kong receipts create one four-seat score cue and never masquerade as a win',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0&motionScale=3')
  await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30_000})
  await page.evaluate(()=>(window as any).__appendBloodFlowKong(3))
  await expect(page.locator('[data-payment-seat="3"]')).toContainText('暗杠')
  expect(await page.locator('[data-payment-seat]').evaluateAll(es=>es.sort((a,b)=>Number(a.getAttribute('data-payment-seat'))-Number(b.getAttribute('data-payment-seat'))).map(e=>Number(e.getAttribute('data-payment-amount'))))).toEqual([-20,-20,-20,60])
  await expect(page.locator('.blood-flow-central')).toHaveCount(0)
  await page.evaluate(()=>(window as any).__restoreBloodFlow())
  await expect(page.locator('[data-payment-seat]')).toHaveCount(0)
})
test('a merged cue preserves zero net changes when the same winners also paid',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0')
  await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30_000})
  await page.evaluate(async()=>{(window as any).__appendBloodFlowWin();for(const seat of [0,1,2,3])await (window as any).__playBloodFlowScenario('draw',seat,[seat])})
  await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-cue-id')?.includes('|'))
  await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-phase')==='score')
  await expect(page.locator('[data-payment-seat="0"]')).toContainText('合计')
  expect(await page.locator('[data-payment-seat]').evaluateAll(es=>es.sort((a,b)=>Number(a.getAttribute('data-payment-seat'))-Number(b.getAttribute('data-payment-seat'))).map(e=>Number(e.getAttribute('data-payment-amount'))))).toEqual([0,0,0,0])
})
