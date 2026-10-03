import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const themes = ['jade','happyMahjong','rosewood','llm','llmAnime']
const rules = ['lotus-classic','lotus-legacy','lotus-blood-flow']
const phones = [{width:568,height:320},{width:844,height:390},{width:915,height:320}]
const evidence = 'test-results/reveal-hud'

async function inspect(page: Page, expanded: boolean, remote: boolean, weakSignal = true) {
  const metrics = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON()
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.mahjong-scene')!
    const rect = canvas.getBoundingClientRect()
    const hands = JSON.parse(canvas.dataset.handFaceRects || '[]').filter((p: any) => p.seat === 2)
      .map((p: any) => ({left:rect.left+p.left*rect.width,right:rect.left+p.right*rect.width,top:rect.top+p.top*rect.height,bottom:rect.top+p.bottom*rect.height}))
    const round = document.querySelector<HTMLElement>('.round-info')!
    return { meta:box('.table-meta'), header:box('.top-bar'), flip:box('.flip-indicator'), flipBody:box('.flip-indicator-body'),
      leftSeat:box('.seat-left .avatar-wrap'), topSeat:box('.seat-top .avatar-wrap'), nav:box('.top-bar nav'), hands,
      width:innerWidth,height:innerHeight,background:getComputedStyle(document.querySelector('.top-bar')!).backgroundImage,
      roundFits:round.scrollWidth<=round.clientWidth+1,
      overflows:[...document.querySelectorAll<HTMLElement>('.table-meta,.base-score-badge,.flip-indicator-body')]
        .filter(e=>e.getBoundingClientRect().height).map(e=>({name:e.className,extra:e.scrollWidth-e.clientWidth})),
      buttons:[...document.querySelectorAll('.top-bar nav > div > button,.top-bar nav > button')].map(e=>e.getBoundingClientRect().toJSON()),
      overflow:document.documentElement.scrollWidth-innerWidth }
  })
  expect(metrics.background).toBe('none')
  expect(metrics.roundFits, 'round label must remain complete').toBe(true)
  expect(metrics.meta.bottom).toBeLessThanOrEqual(metrics.header.bottom)
  expect(metrics.overflow).toBeLessThanOrEqual(0)
  for (const item of metrics.overflows) expect(item.extra, `${item.name} must not clip information`).toBeLessThanOrEqual(1)
  const overlaps = (a: any, b: any) => b && Math.min(a.right,b.right)>Math.max(a.left,b.left)+.1 && Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+.1
  expect(overlaps(metrics.meta, metrics.nav)).toBeFalsy()
  if (metrics.flip) {
    expect(metrics.flip.top).toBeGreaterThanOrEqual(metrics.header.bottom+5)
    expect(overlaps(metrics.meta, metrics.flip)).toBeFalsy()
    expect(overlaps(metrics.flip, metrics.leftSeat),'precision badge must not cover the left player').toBeFalsy()
    if (expanded) {
      for (const item of [metrics.meta, metrics.leftSeat, metrics.topSeat, metrics.nav]) {
        expect(overlaps(metrics.flipBody,item),'expanded precision guide must not cover HUD information').toBeFalsy()
      }
      expect(metrics.flipBody.right).toBeLessThanOrEqual(metrics.width)
      expect(metrics.flipBody.bottom).toBeLessThanOrEqual(metrics.height)
    }
    await expect(page.locator('.flip-indicator')).toHaveAttribute('aria-expanded', String(expanded))
    await expect(page.locator('.flip-indicator-body')).toBeVisible({ visible: expanded })
    if (expanded) await expect(page.locator('.joker-guide')).toContainText('白板替代')
  }
  for (const hand of metrics.hands) {
    expect(hand.top,'face must remain inside the viewport').toBeGreaterThanOrEqual(0)
    expect(hand.left).toBeGreaterThanOrEqual(0)
    expect(hand.right).toBeLessThanOrEqual(metrics.width)
    expect(hand.bottom).toBeLessThanOrEqual(metrics.height)
    for (const [name, obstacle] of Object.entries({meta:metrics.meta,nav:metrics.nav,flip:metrics.flip,flipBody:metrics.flipBody,topSeat:metrics.topSeat})) {
      expect(overlaps(hand,obstacle), `opposite tile overlaps ${name}`).toBeFalsy()
    }
  }
  expect(metrics.hands.length).toBeGreaterThan(0)
  for (const button of metrics.buttons) { expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44) }
  await expect(page.locator('.base-score-badge')).toContainText('底分100')
  await expect(page.locator('.badge-honba')).toBeVisible()
  if (remote) {
    await expect(page.locator('.badge-room')).toContainText('ABC234')
    await expect(page.locator('.signal-icon')).toBeVisible()
    await expect(page.locator('.signal-warn')).toHaveCount(weakSignal ? 1 : 0)
  }
  return metrics
}

for (const theme of themes) for (const rule of rules) for (const mode of ['local','remote']) {
  test(`reveal HUD ${theme} ${rule} ${mode}`, async ({browser}) => {
    test.setTimeout(120000)
    const context = await browser.newContext({baseURL:`http://127.0.0.1:${process.env.E2E_PORT || 4173}`,viewport:phones[0],hasTouch:true,isMobile:true})
    const page = await context.newPage(), errors: string[] = []
    page.on('pageerror', error=>errors.push(error.message))
    try {
      await page.goto(`/tests/e2e/fixtures/reveal-hud.html?theme=${theme}&rule=${rule}&mode=${mode}&cameraLab=1`)
      await expect(page.locator('.table-loading')).toHaveCount(0,{timeout:45000})
      await expect(page.locator('.game-table-hud')).toHaveAttribute('data-reveal-hands','0')
      const before = await page.locator('.round-info').boundingBox()
      expect(before!.x+before!.width/2).toBeCloseTo(phones[0].width/2,0)
      await page.evaluate(()=>(window as any).__setRevealHud({reveal:true}))
      await expect(page.locator('.game-table-hud')).toHaveAttribute('data-reveal-hands','1')
      for (const phone of phones) {
        await page.setViewportSize(phone)
        // Match the projection's aspect to the new CSS viewport before reading its rectangles.
        const baseFov = theme==='llmAnime'?40:45
        const fov = 2*Math.atan(Math.tan(baseFov*Math.PI/360)*Math.max(1,(16/9)/(phone.width/phone.height)))*180/Math.PI
        await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-camera-fov'))).toBeCloseTo(fov,3)
        await expect.poll(async()=>JSON.parse((await page.locator('canvas').getAttribute('data-hand-face-rects'))||'[]').filter((p:any)=>p.seat===2).length).toBe(14)
        await inspect(page,false,mode==='remote')
        if (rule!=='lotus-classic') {
          await page.locator('.flip-indicator').click()
          await inspect(page,true,mode==='remote')
        }
        await mkdir(evidence,{recursive:true})
        await page.screenshot({path:`${evidence}/${theme}-${rule}-${mode}-${phone.width}x${phone.height}.png`})
        if (rule!=='lotus-classic') await page.locator('.flip-indicator').click()
      }
      for (const [melds,count] of [[0,13],[1,14],[4,14]]) {
        await page.evaluate(({melds,count})=>(window as any).__setRevealHud({melds,count}),{melds,count})
        await expect.poll(async()=>JSON.parse((await page.locator('canvas').getAttribute('data-hand-face-rects'))||'[]').filter((p:any)=>p.seat===2).length).toBe(count-3*melds)
        await inspect(page,false,mode==='remote')
      }
      await page.setViewportSize({width:844,height:390})
      await page.evaluate(() => {
        const app = document.querySelector<HTMLElement>('.game-app')!
        app.style.setProperty('--safe-left','44px'); app.style.setProperty('--safe-right','24px')
        ;(window as any).__setRevealHud({melds:0,count:14,honba:12})
      })
      await expect.poll(async()=>JSON.parse((await page.locator('canvas').getAttribute('data-hand-face-rects'))||'[]').filter((p:any)=>p.seat===2).length).toBe(14)
      await inspect(page,false,mode==='remote')
      if (mode==='remote') {
        await page.evaluate(()=>(window as any).__setRevealHud({signal:3}))
        await inspect(page,false,true,false)
      }
      // Expanded state must preserve actual pointer access to shell controls.
      if (rule!=='lotus-classic') await page.locator('.flip-indicator').click()
      await page.getByRole('button',{name:'查看规则'}).click()
      expect(await page.evaluate(()=>(window as any).__rulesClicked)).toBe(true)
      await page.evaluate(()=>(window as any).__setRevealHud({reveal:false}))
      await expect(page.locator('.game-table-hud')).toHaveAttribute('data-reveal-hands','0')
      expect(await page.locator('.table-meta').evaluate(e=>getComputedStyle(e).display)).toBe('contents')
      expect(errors).toEqual([])
    } finally { await context.close() }
  })
}

for (const touch of [false,true]) test(`large ${touch ? 'tablet' : 'desktop'} keeps the existing header`, async ({browser}) => {
  const context = await browser.newContext({baseURL:`http://127.0.0.1:${process.env.E2E_PORT || 4173}`,
    viewport:{width:1280,height:800},hasTouch:touch,isMobile:touch})
  try {
    const page = await context.newPage()
    await page.goto('/tests/e2e/fixtures/reveal-hud.html?theme=llmAnime&rule=lotus-legacy&cameraLab=1')
    await expect(page.locator('.game-table-hud')).toBeVisible()
    await page.evaluate(()=>(window as any).__setRevealHud({reveal:true}))
    await expect(page.locator('.game-table-hud')).toHaveAttribute('data-reveal-hands','1')
    expect(await page.locator('.table-meta').evaluate(e=>getComputedStyle(e).display)).toBe('contents')
    const box = (await page.locator('.round-info').boundingBox())!
    expect(box.x+box.width/2).toBeCloseTo(640,0)
  } finally { await context.close() }
})
