import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

// Complement the normal-speed lobby game with reproducible small-screen frames.
// These injected display scenarios are not evidence of a completed rules game.
for (const [width,height] of [[844,390],[568,320]]) test.describe(`${width}x${height} win readability`,()=>{
  test.use({viewport:{width,height}})
  test('captures ordinary/high wins at real speed for visual review',async({page})=>{
    test.setTimeout(60000)
    const dir='work/blood-flow-playability'
    await mkdir(dir,{recursive:true})
    for(const theme of ['jade','llmAnime']) {
      await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=3&controls=1&theme=${theme}`)
      await expect(page.locator('.table-loading')).toHaveCount(0)
      expect(await page.evaluate(()=>[innerWidth,innerHeight])).toEqual([width,height])
      for(const [label,kind] of [['普通点炮','normal'],['高番自摸','high']]){
        const prefix=`verified-${width}-${theme}-${kind}`
        await page.getByRole('button',{name:label,exact:true}).click()
        const start=Date.now(),times:number[]=[]
        for(let frame=0;frame<13;frame++){
          times.push(Date.now()-start)
          await page.screenshot({path:`${dir}/${prefix}-${String(frame).padStart(3,'0')}.png`})
          await page.waitForTimeout(150)
        }
        await writeFile(`${dir}/${prefix}-times.json`,JSON.stringify(times))
        await expect(page.locator('.blood-flow-cue')).toHaveCount(0)
        await expect(page.locator('.blood-flow-preview')).toHaveCount(0)
      }
    }
  })
})
