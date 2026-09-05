import {expect,test} from '@playwright/test'
import {mkdir} from 'node:fs/promises'

const dir='work/blood-flow-common/package5'
for(const [width,height] of [[1280,720],[844,390],[568,320]])for(const theme of ['jade','rosewood','happyMahjong','llm','llmAnime']) {
  test(`${theme} settlement navigation at ${width}x${height}`,async({page})=>{
    await mkdir(dir,{recursive:true});await page.setViewportSize({width,height})
    const url=`/tests/e2e/fixtures/blood-flow.html?count=2&theme=${theme}`
    await page.goto(url)
    await expect(page.locator('.table-loading')).toHaveCount(0)
    await page.evaluate(()=>(window as any).__settleBloodFlow(false))
    const round=page.getByRole('dialog',{name:'血流本局结算'})
    await expect(round).toBeVisible()
    await page.screenshot({animations:'disabled',path:`${dir}/${width}-${theme}-round.png`})
    await round.getByRole('button',{name:'查看流水',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'血流公开流水'})).toBeVisible()
    await page.getByRole('button',{name:'返回结算',exact:true}).click()
    await round.getByRole('button',{name:'查看牌桌',exact:true}).click()
    await page.evaluate(()=>(window as any).__refreshBloodFlowResult())
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button',{name:'返回结算',exact:true}).click()
    await round.getByRole('button',{name:'继续下一局',exact:true}).click()
    expect(await page.evaluate(()=>(window as any).__bloodFlowNavigation.nextRoundCalls)).toBe(1)
    await page.goto(url)
    await page.evaluate(()=>(window as any).__settleBloodFlowRanking())
    const final=page.getByRole('dialog',{name:'血流最终排名'})
    await expect(final).toBeVisible()
    await expect(final.locator('.bf-result-player').first()).toContainText('2700')
    await page.screenshot({animations:'disabled',path:`${dir}/${width}-${theme}-final.png`})
    await final.getByRole('button',{name:'最后一局结果',exact:true}).click()
    await round.getByRole('button',{name:'查看流水',exact:true}).click()
    await page.getByRole('button',{name:'返回结算',exact:true}).click()
    await round.getByRole('button',{name:'最终排名',exact:true}).click()
    await final.getByRole('button',{name:'返回大厅',exact:true}).click()
    expect(await page.evaluate(()=>(window as any).__bloodFlowNavigation.returnToLobbyCalls)).toBe(1)
  })
}
