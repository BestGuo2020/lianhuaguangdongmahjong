import {expect,test} from '@playwright/test'
import {mkdir} from 'node:fs/promises'

const dir='work/blood-flow-refinement'
for(const [width,height] of [[1280,720],[844,390],[568,320]]) test.describe(`${width}x${height}`,()=>{
  test.use({viewport:{width,height},isMobile:width<900,hasTouch:width<900})
  for(const theme of ['jade','rosewood','happyMahjong','llm','llmAnime']) test(`${theme} normal/high/multi and operation layout`,async({page})=>{
    test.setTimeout(60000)
    await mkdir(dir,{recursive:true})
    const prefix=`${width}-${theme}`
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=3&theme=${theme}&controls=1&hudStates=1`)
    await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:30000})
    expect(await page.evaluate(()=>[innerWidth,innerHeight])).toEqual([width,height])
    for(const [label,scene] of [['普通点炮','normal'],['高番自摸','high'],['三响','multi']]) {
      await page.getByRole('button',{name:label,exact:true}).click()
      if(scene==='high'&&theme==='llmAnime') {
        await page.waitForFunction(()=>document.querySelectorAll('[data-actor-seat]').length>0)
        await page.screenshot({path:`${dir}/${prefix}-actor.png`})
      }
      await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-phase')==='readable')
      await page.screenshot({path:`${dir}/${prefix}-${scene}.png`})
      const titles=await page.locator('[data-title-seat]').evaluateAll(es=>es.map(el=>{const r=el.getBoundingClientRect();return {seat:Number(el.getAttribute('data-title-seat')),x:r.x,y:r.y,w:r.width,h:r.height}}))
      for(const r of titles){expect(r.x).toBeGreaterThanOrEqual(0);expect(r.x+r.w).toBeLessThanOrEqual(width);expect(r.y).toBeGreaterThanOrEqual(0);expect(r.y+r.h).toBeLessThan(height)}
      if(scene!=='multi') expect(titles[0].y+titles[0].h/2).toBeGreaterThan(height*.58)
      await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-phase')==='score')
      await page.screenshot({path:`${dir}/${prefix}-${scene}-payment.png`})
      const sizes=await page.locator('.blood-flow-winner-payment').evaluateAll(es=>es.map(el=>({scroll:el.scrollWidth,width:el.clientWidth,lines:el.children.length})))
      for(const size of sizes){expect(size.scroll).toBeLessThanOrEqual(size.width);expect(size.lines).toBe(1)}
      await expect(page.locator('.blood-flow-cue')).toHaveCount(0)
    }
    await page.getByRole('button',{name:'可胡画面',exact:true}).click()
    await page.screenshot({path:`${dir}/${prefix}-buttons.png`})
    for(const label of ['胡','碰','杠','吃','过']) await expect(page.locator('.action-bar').getByRole('button',{name:label,exact:true})).toBeVisible()
    const actions=await page.locator('.action-bar').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,right:r.right,bottom:r.bottom}})
    expect(actions.x).toBeGreaterThanOrEqual(0);expect(actions.right).toBeLessThanOrEqual(width);expect(actions.bottom).toBeLessThanOrEqual(height)
    await page.getByRole('button',{name:'选牌画面',exact:true}).click()
    await page.screenshot({path:`${dir}/${prefix}-waits.png`})
    await expect(page.locator('.blood-flow-wait-tile')).toHaveCount(4)
  })
})
