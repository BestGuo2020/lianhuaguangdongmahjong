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
  await expect(page.locator('.blood-flow-winner-payment')).toBeVisible()
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

test('records source, winners and payments without mixing their seats', async ({page}) => {
  test.setTimeout(60000)
  await mkdir(dir,{recursive:true})
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=3&theme=llmAnime&controls=1')
  await expect(page.locator('.table-loading')).toHaveCount(0)
  const scenarios = [
    {name:'own-discard-win',kind:'discard',source:1,winners:[0],pattern:'pure-suit'},
    {name:'own-discard-loss',kind:'discard',source:0,winners:[3],pattern:'big-three-dragons'},
    {name:'other-draw',kind:'draw',source:2,winners:[2],pattern:'all-green'},
    {name:'two-winners',kind:'multi',source:1,winners:[0,2],pattern:''},
    {name:'three-winners',kind:'multi',source:0,winners:[1,2,3],pattern:''},
  ]
  for (const scene of scenarios) {
    await page.evaluate(async s=>{
      // Sample inside the browser: taking a readable-frame screenshot can
      // outlast the short payment phase, particularly while recording video.
      ;(window as any).__scenePayments = null
      const samplePayments=()=>{
        const nodes=[...document.querySelectorAll('[data-payment-seat]')]
        if(nodes.length) (window as any).__scenePayments=nodes.map(e=>({seat:Number(e.getAttribute('data-payment-seat')),amount:Number(e.getAttribute('data-payment-amount'))}))
        else requestAnimationFrame(samplePayments)
      }
      requestAnimationFrame(samplePayments)
      if(s.kind==='multi') (window as any).__appendBloodFlowMultiWin(s.winners,s.source)
      else await (window as any).__playBloodFlowScenario(s.kind,s.source,s.winners,[s.pattern],true)
    },scene)
    await expect(page.locator('.blood-flow-source')).toHaveCount(1)
    await expect(page.locator('.blood-flow-source')).toHaveAttribute('data-source-seat',String(scene.source))
    await page.screenshot({path:`${dir}/${scene.name}-source.png`})
    await page.waitForFunction(count=>document.querySelectorAll('[data-actor-seat]').length===count,scene.winners.length)
    expect(await page.locator('[data-actor-seat]').evaluateAll(es=>es.map(el=>Number(el.getAttribute('data-actor-seat'))).sort())).toEqual([...scene.winners].sort())
    await page.screenshot({path:`${dir}/${scene.name}-actors.png`})
    await expect(page.locator('[data-title-seat]')).toHaveCount(scene.winners.length)
    await expect(page.locator('[data-actor-seat]')).toHaveCount(0)
    await expect(page.locator('.blood-flow-source')).toHaveCount(0)
    await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-phase')==='readable')
    await page.screenshot({path:`${dir}/${scene.name}-titles.png`})
    if(scene.winners.includes(0)) {
      const ratio=await page.locator('[data-title-seat="0"]').evaluate(el=>{const r=el.getBoundingClientRect();return (r.y+r.height/2)/innerHeight})
      expect(ratio).toBeGreaterThan(.66)
    }
    await page.waitForFunction(()=>(window as any).__scenePayments !== null)
    const payments=await page.evaluate(()=>(window as any).__scenePayments as {seat:number;amount:number}[])
    for(const winner of scene.winners) expect(payments.find(p=>p.seat===winner)?.amount).toBeGreaterThan(0)
    expect(new Set(payments.map(p=>p.seat)).size).toBe(payments.length)
    expect(payments.reduce((n,p)=>n+p.amount,0)).toBe(0)
    await writeFile(`${dir}/${scene.name}-payments.json`,JSON.stringify(payments))
    if(await page.locator('[data-payment-seat]').count()) await page.screenshot({path:`${dir}/${scene.name}-payment.png`})
    await expect(page.locator('.blood-flow-cue')).toHaveCount(0)
  }
  await page.close()
  await page.video()!.saveAs(`${dir}/source-winners-normal.webm`)
})

test('coalesces ten repeated wins and ignores repeated display snapshots', async ({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow.html?count=3&theme=llmAnime&controls=1')
  await expect(page.locator('.table-loading')).toHaveCount(0)
  await page.getByRole('button',{name:'高番自摸',exact:true}).click()
  await page.evaluate(()=>{for(let i=0;i<9;i++) (window as any).__appendBloodFlowWin(); for(let i=0;i<3;i++) (window as any).__refreshBloodFlowResult()})
  await expect(page.locator('[data-pile-seat="0"]')).toContainText(/胡\s*13次/)
  await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-cue-id')?.includes('|'))
  await page.waitForFunction(()=>document.querySelector('.blood-flow-cue')?.getAttribute('data-phase')==='score')
  await expect(page.locator('[data-payment-seat="0"]')).toHaveText(/合计\s*\+17280/)
  await page.screenshot({path:`${dir}/ten-wins-merged.png`})
  await expect(page.locator('.blood-flow-cue')).toHaveCount(0,{timeout:4000})
  await page.evaluate(()=>(window as any).__refreshBloodFlowResult())
  await page.waitForTimeout(150)
  await expect(page.locator('.blood-flow-cue')).toHaveCount(0)
  await expect(page.locator('[data-pile-seat="0"]')).toContainText(/胡\s*13次/)
})
