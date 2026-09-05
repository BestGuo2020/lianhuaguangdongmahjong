import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const dir = 'work/blood-flow-refinement'
test.use({ video: {mode:'on',size:{width:1280,height:720}} })
test('records the four default information states for visual review', async ({ page }) => {
  await mkdir(dir, { recursive: true })
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=0&theme=llmAnime&controls=1&hudStates=1')
  await expect(page.locator('.table-loading')).toHaveCount(0)
  for (const [label, state] of [['等待画面','waiting'],['选牌画面','selection'],['可胡画面','preview']]) {
    await page.getByRole('button', {name:label,exact:true}).click()
    await page.screenshot({path:`${dir}/info-${state}.png`})
  }
  await expect(page.locator('.blood-flow-preview')).toContainText('预计 +600')
  for (const label of ['胡','碰','杠','吃','过']) await expect(page.locator('.action-bar').getByRole('button',{name:label,exact:true})).toBeVisible()
  await expect(page.locator('.flip-indicator-body')).toBeHidden()
  await page.getByRole('button',{name:'翻精指示牌',exact:true}).click()
  await expect(page.locator('.flip-indicator-body')).toContainText('二骰 2 + 4')
  await page.getByRole('button',{name:'翻精指示牌',exact:true}).click()
  await page.getByText('查看预计详情',{exact:true}).click()
  await expect(page.locator('.blood-flow-preview')).toContainText('预计每位付款者 200分，共 3位')
  await page.getByText('查看预计详情',{exact:true}).click()
  await page.getByRole('button',{name:'高番自摸',exact:true}).click()
  await expect(page.locator('.blood-flow-winner-card')).toBeVisible()
  await page.screenshot({path:`${dir}/info-payment.png`})
  await expect(page.locator('[data-payment-seat="0"]:visible')).toHaveCount(1)
  await expect(page.locator('.blood-flow-preview')).toHaveCount(0)
})

test('records representative high win at normal speed', async ({ page }) => {
  await mkdir(dir, { recursive: true })
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=3&theme=llmAnime&controls=1')
  await expect(page.locator('.table-loading')).toHaveCount(0)
  await page.getByRole('button',{name:'高番自摸',exact:true}).click()
  const start = Date.now(), times:number[] = []
  for (let frame=0;frame<18;frame++) {
    times.push(Date.now()-start)
    await page.screenshot({path:`${dir}/single-high-${String(frame).padStart(3,'0')}.png`})
    await page.waitForTimeout(100)
  }
  await writeFile(`${dir}/single-high-times.json`,JSON.stringify(times))
  await expect(page.locator('.blood-flow-cue')).toHaveCount(0)
  await page.getByRole('button',{name:'普通点炮',exact:true}).click()
  await page.waitForTimeout(950)
  await page.screenshot({path:`${dir}/ordinary-baseline.png`})
  await expect(page.locator('.blood-flow-cue')).toHaveCount(0, {timeout:5000})
  await page.close()
  await page.video()!.saveAs(`${dir}/single-high-normal.webm`)
})
