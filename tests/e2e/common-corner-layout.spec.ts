import {expect,test} from '@playwright/test'
import {mkdir} from 'node:fs/promises'
for(const [width,height] of [[1280,720],[844,390],[568,320]]) for(const theme of ['jade','rosewood','happyMahjong','llm','llmAnime']) {
 test(`public corners ${width} ${theme}`,async({page})=>{
  test.setTimeout(180000)
  await page.setViewportSize({width,height})
  const dir=`work/common-corner-layout/matrix/${width}-${theme}`;await mkdir(dir,{recursive:true})
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  for(const count of [1,4,5,13,25,41]){
   await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=${count}&theme=${theme}`)
   await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30000})
   for(const melds of [0,1,4]){
    await page.evaluate(m=>(window as any).__setCornerLayout(m),melds)
    await page.waitForTimeout(100)
    for(const button of await page.locator('.action-bar button').all()) await expect(button).toBeVisible()
    const controls=await page.locator('.action-bar button,.blood-flow-preview').evaluateAll(es=>es.map(e=>({rect:e.getBoundingClientRect().toJSON(),scroll:e.scrollWidth,width:e.clientWidth})))
    for(const control of controls){expect(control.rect.left).toBeGreaterThanOrEqual(0);expect(control.rect.right).toBeLessThanOrEqual(width);expect(control.rect.bottom).toBeLessThanOrEqual(height);expect(control.scroll).toBeLessThanOrEqual(control.width+1)}
    await page.screenshot({path:`${dir}/blood-${count}-melds-${melds}.png`})
   }
  }
  for(const melds of [0,1,4])for(const seat of [0,1,2,3]){
   await page.evaluate(({melds,seat})=>(window as any).__setCornerLayout(melds,seat),{melds,seat})
   await page.waitForTimeout(100)
   await page.screenshot({path:`${dir}/ordinary-${seat}-melds-${melds}.png`})
  }
  expect(errors).toEqual([])
 })
}
