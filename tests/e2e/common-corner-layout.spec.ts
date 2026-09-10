import {expect,test} from '@playwright/test'
import {mkdir} from 'node:fs/promises'
for(const [width,height] of [[1280,720],[844,390],[568,320]]) for(const theme of ['jade','rosewood','happyMahjong','llm','llmAnime']) {
 test(`public corners ${width} ${theme}`,async({page})=>{
  test.setTimeout(180000)
  await page.setViewportSize({width,height})
  const dir=`work/outward-corner-layout/matrix/${width}-${theme}`;await mkdir(dir,{recursive:true})
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
  for(const count of [1,4,5,13,25,41]){
   await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=${count}&theme=${theme}&cameraLab=1`)
   await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30000})
   const expectedPosition=theme==='llmAnime'?'0.000000,20.800000,14.000000':'0.000000,17.200000,11.800000'
   const camera=page.locator('canvas.mahjong-scene')
   await expect(camera).toHaveAttribute('data-camera-position',expectedPosition)
   const baseFov=theme==='llmAnime'?40:45
   const expectedFov=2*Math.atan(Math.tan(baseFov*Math.PI/360)*Math.max(1,(16/9)/(width/height)))*180/Math.PI
   expect(Number(await camera.getAttribute('data-camera-fov'))).toBeCloseTo(expectedFov,5)
   const y=theme==='llmAnime'?20.8:17.2,z=theme==='llmAnime'?14:11.8,lookZ=theme==='llmAnime'?-.2:.4
   const direction=(await camera.getAttribute('data-camera-direction'))!.split(',').map(Number),length=Math.hypot(y,lookZ-z)
   expect(direction[0]).toBeCloseTo(0,6);expect(direction[1]).toBeCloseTo(-y/length,6);expect(direction[2]).toBeCloseTo((lookZ-z)/length,6)
   for(const melds of [0,1,4]){
    await page.evaluate(m=>(window as any).__setCornerLayout(m),melds)
    await page.waitForTimeout(100)
    for(const button of await page.locator('.action-bar button').all()) await expect(button).toBeVisible()
    const controls=await page.locator('.action-bar button,.blood-flow-preview').evaluateAll(es=>es.map(e=>({rect:e.getBoundingClientRect().toJSON(),scroll:e.scrollWidth,width:e.clientWidth})))
    for(const control of controls){expect(control.rect.left).toBeGreaterThanOrEqual(0);expect(control.rect.right).toBeLessThanOrEqual(width);expect(control.rect.bottom).toBeLessThanOrEqual(height);expect(control.scroll).toBeLessThanOrEqual(control.width+1)}
    await page.screenshot({path:`${dir}/blood-${count}-melds-${melds}.png`})
   }
   await page.evaluate(()=>(window as any).__setCornerLayout(1,null,true))
   await page.waitForTimeout(100)
   await page.screenshot({path:`${dir}/empty-wall-${count}.png`})
  }
  for(const melds of [0,1,4])for(const seat of [0,1,2,3]){
   await page.evaluate(({melds,seat})=>(window as any).__setCornerLayout(melds,seat),{melds,seat})
   await page.waitForTimeout(100)
   await expect(page.locator('canvas.mahjong-scene')).toHaveAttribute('data-camera-position',theme==='llmAnime'?'0.000000,20.800000,14.000000':'0.000000,17.200000,11.800000')
   await page.screenshot({path:`${dir}/ordinary-${seat}-melds-${melds}.png`})
  }
  expect(errors).toEqual([])
 })
}
