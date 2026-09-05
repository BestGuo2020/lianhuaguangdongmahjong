import {expect,test} from '@playwright/test'
import {writeFile} from 'node:fs/promises'
test.use({viewport:{width:1000,height:480}})
test('captures the representative anime lettering material',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow-lettering.html')
  await expect(page.locator('svg')).toBeVisible()
  await page.screenshot({path:`work/blood-flow-refinement/material-${process.env.BF_LETTERING_STAGE??'after'}.png`})
})
test('records anime big three dragons at normal speed',async({browser},testInfo)=>{
  const dir='work/blood-flow-refinement'
  const context=await browser.newContext({baseURL:testInfo.project.use.baseURL,viewport:{width:1280,height:720},recordVideo:{dir:`${dir}/material-video`,size:{width:1280,height:720}}})
  const page=await context.newPage()
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=3&theme=llmAnime&controls=1')
  await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30000})
  await page.evaluate(()=>(window as any).__playBloodFlowScenario('draw',0,[0],['big-three-dragons'],true))
  const start=Date.now(),times:number[]=[]
  for(let i=0;i<12;i++) {
    times.push(Date.now()-start)
    await page.screenshot({path:`${dir}/material-motion-${String(i).padStart(2,'0')}.png`})
    await page.waitForTimeout(75)
  }
  await writeFile(`${dir}/material-motion-times.json`,JSON.stringify(times))
  await page.getByRole('button',{name:'三响',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-phase')==='readable')
  await page.screenshot({path:`${dir}/material-multi-after.png`})
  await expect(page.locator('.blood-flow-cue')).toHaveCount(0)
  await context.close()
  await page.video()!.saveAs(`${dir}/material-normal.webm`)
})
