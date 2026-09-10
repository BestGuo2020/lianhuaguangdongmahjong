import {expect,test} from '@playwright/test'
test.setTimeout(60_000)
for(const count of [12,24,40])test(`new win flies to its persistent level after ${count} earlier records`,async({page})=>{
  await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=${count}&motionScale=4`)
  await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30_000})
  await page.evaluate(()=>(window as any).__appendBloodFlowWin())
  const canvas=page.locator('canvas.mahjong-scene')
  const flights=()=>canvas.getAttribute('data-blood-flow-flights').then(s=>JSON.parse(s||'[]'))
  await expect.poll(async()=>(await flights()).length).toBe(1)
  const first=(await flights())[0]
  expect(first.level).toBe(count/4);expect(first.column).toBe(0)
  expect(first.target.y).toBeCloseTo(.31+count/4*.47)
  expect(first.source).not.toEqual(first.target)
  // The source now remains visible before takeoff; wait for actual flight,
  // including this fixture's 4x slow-motion scale, instead of the old 60ms hop.
  await expect.poll(async()=>(await flights())[0]?.current.progress??0,{timeout:2000}).toBeGreaterThan(0)
  const next=(await flights())[0]
  expect(next.current.progress).toBeLessThan(1)
  expect(next.current).not.toEqual(first.current)
  await page.screenshot({path:`test-results/blood-flow-flight-${count+1}.png`})
  await expect.poll(async()=>(await flights()).length,{timeout:5000}).toBe(0)
  await expect(page.locator('[data-pile-seat="0"]')).toContainText(`胡 ${count+1}次`)
  await page.evaluate(()=>(window as any).__restoreBloodFlow())
  await expect(canvas).toHaveAttribute('data-blood-flow-flights','[]')
  await expect(canvas).toHaveAttribute('data-blood-flow-cue','')
})
test('three flight references share one source and land in three distinct towers',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=12&motionScale=4')
  await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30_000})
  await page.evaluate(()=>(window as any).__appendBloodFlowMultiWin())
  const canvas=page.locator('canvas.mahjong-scene')
  const flights=()=>canvas.getAttribute('data-blood-flow-flights').then(s=>JSON.parse(s||'[]'))
  await expect.poll(async()=>(await flights()).length).toBe(3)
  const input=await flights()
  expect(new Set(input.map((f:any)=>f.sourceId)).size).toBe(1)
  expect(new Set(input.map((f:any)=>JSON.stringify(f.target))).size).toBe(3)
  // 12 次/家：本家/下家/对家 4 张/层 → 第 13 次落第 3 层；上家 3 张/层 → 落第 4 层。
  const bySeat=new Map(input.map((f:any)=>[f.target.x, f.level]))
  expect(bySeat.get(8)).toBe(3);expect(bySeat.get(-8)).toBe(3);expect(bySeat.get(-6.95)).toBe(4)
  // 一炮多响 intro 顺延起飞；本夹具 4 倍慢放，落定在 intro+readable 之后。
  await expect.poll(async()=>(await flights()).length,{timeout:30_000}).toBe(0)
})
for(const kind of ['draw','discard','added-kong'] as const)test(`${kind} uses its source region before landing`,async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=12&motionScale=4')
  await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30_000})
  await page.evaluate(kind=>(window as any).__playBloodFlowScenario(kind,kind==='draw'?0:1,[0]),kind)
  const canvas=page.locator('canvas.mahjong-scene')
  await expect.poll(async()=>JSON.parse(await canvas.getAttribute('data-blood-flow-flights')||'[]').length).toBe(1)
  const flight=JSON.parse(await canvas.getAttribute('data-blood-flow-flights')||'[]')[0]
  expect(flight.kind).toBe(kind)
  if(kind==='draw'){
    const expected=await page.evaluate(()=>(window as any).__bloodFlowPreparedScreen)
    expect(flight.sourceScreen.x).toBeCloseTo(expected.x,2)
    expect(flight.sourceScreen.y).toBeCloseTo(expected.y,2)
  }
  else if(kind==='discard')expect(flight.source.x).toBeCloseTo(2.64)
  else expect(flight.source.x).toBeGreaterThan(7)
  await page.screenshot({path:`test-results/blood-flow-source-${kind}.png`})
})
