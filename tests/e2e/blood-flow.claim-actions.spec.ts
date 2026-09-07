import { expect, test } from '@playwright/test'

for (const [label, kind] of [['碰','peng'],['杠','gang'],['吃','chi'],['胡','win']] as const) {
  test(`can choose ${label} immediately from a single combined response`, async ({page}) => {
    const errors:string[]=[]
    page.on('pageerror', error=>errors.push(error.message))
    await page.goto('/tests/e2e/fixtures/blood-flow-claims.html')
    const actions=page.locator('.action-bar')
    // 可胡时不再提供“过”：只出现 碰/杠/吃/胡。
    for (const text of ['碰','杠','吃','胡']) await expect(actions.getByRole('button',{name:text,exact:true})).toBeVisible()
    await expect(actions.getByRole('button',{name:'过',exact:true})).toHaveCount(0)
    await actions.getByRole('button',{name:label,exact:true}).click()
    // The shared HUD executes a single chi candidate immediately.
    await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().commands.map((c:any)=>c.action.kind))).toEqual([kind])
    const evidence=await page.evaluate(()=>(window as any).__claimEvidence())
    if (['peng','gang','chi'].includes(kind)) expect(evidence.melds[0].type).toBe(kind)
    if (kind==='win') expect(evidence.wins).toBe(1)
    expect(evidence.window).toBe('turn')
    expect(errors).toEqual([])
  })
}
test('an untouched hu window auto-wins after the configured delay', async ({page}) => {
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html?autoHuMs=300')
  await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().commands.map((c:any)=>c.action.kind))).toEqual(['win'])
  expect((await page.evaluate(()=>(window as any).__claimEvidence())).wins).toBe(1)
})
test('reuses the existing picker when hu and multiple chi choices coexist',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html?multiChi=1')
  await page.locator('.action-bar').getByRole('button',{name:'吃',exact:true}).click()
  await expect(page.locator('.chi-picker-option')).toHaveCount(3)
  await page.locator('.chi-picker-option').nth(2).click()
  await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().commands.map((c:any)=>c.action)))
    .toEqual([{kind:'chi',tiles:['m5','m6','m7']}])
})

test('peng exposes discard hints; ready hints survive passing the turn and repeated views',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html')
  await page.getByRole('button',{name:'碰',exact:true}).click()
  const hint=page.getByRole('button',{name:'查看听牌提示'})
  await expect(hint).toHaveAttribute('title','查看打哪张可听')
  await expect(page.locator('.hand-tile-slot.ting-discard').first()).toBeVisible()
  await hint.click()
  await expect(page.locator('.blood-flow-wait-tile').first()).toBeVisible()
  await expect(page.locator('.blood-flow-wait-tile .wait-multiplier').first()).not.toHaveText('—倍')
  await hint.click()
  const discard=page.locator('.hand-tile-slot').filter({has:page.getByRole('button',{name:'五万',exact:true})})
  await discard.hover()
  await expect(page.locator('.blood-flow-wait-tile .wait-multiplier').first()).not.toHaveText('—倍')
  await discard.click()
  await expect(hint).toHaveAttribute('title','已听牌，查看听口')
  await page.evaluate(()=>(window as any).__refreshClaimView())
  await expect(hint).toHaveAttribute('title','已听牌，查看听口')
  await hint.click()
  await expect(page.locator('.blood-flow-wait-tile').first()).toBeVisible()
  await page.screenshot({path:'work/blood-flow-playability/ready-after-discard.png'})
})

test('a locked hand keeps its ready hint on its own turn and only marks the drawn tile',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html')
  await page.getByRole('button',{name:'胡',exact:true}).click()
  const hint=page.getByRole('button',{name:'查看听牌提示'})
  await expect(hint).toHaveAttribute('title','已听牌，查看听口')
  await expect(page.locator('.hand-tile-slot.ting-discard')).toHaveCount(1)
  await expect(page.locator('.hand-tile-slot.ting-discard')).toHaveClass(/drawn/)
  await hint.click()
  await expect(page.locator('.blood-flow-wait-tile').first()).toBeVisible()
  await expect(page.locator('.blood-flow-wait-tile .wait-multiplier').first()).not.toHaveText('—倍')
})
test.describe('touch layout',()=>{
  test.use({viewport:{width:844,height:390},hasTouch:true})
  test('paced peng leaves time to arrange, and a repeated view preserves a tap selection',async({page})=>{
    await page.goto('/tests/e2e/fixtures/blood-flow-claims.html?paced=1')
    await expect(page.locator('.waiting-tip')).toHaveCount(0)
    await page.getByRole('button',{name:'碰',exact:true}).tap()
    const tile=page.locator('.hand-tile-slot .mahjong-tile').first()
    await expect(tile).toBeDisabled()
    await expect(tile).toBeEnabled()
    await expect(page.locator('.hand-tile-slot')).toHaveCount(11)
    await expect(page.locator('.waiting-tip')).toHaveCount(0)
    await tile.tap()
    await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().selectedIndex)).toBe(0)
    await page.evaluate(()=>(window as any).__refreshClaimView())
    await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().selectedIndex)).toBe(0)
    expect(await page.evaluate(()=>(window as any).__claimEvidence().sounds.filter((s:string)=>s==='click.mp3').length)).toBe(1)
  })
  test('keeps all four choices visible and tappable together',async({page})=>{
    await page.goto('/tests/e2e/fixtures/blood-flow-claims.html')
    for (const text of ['碰','杠','吃','胡']) {
      const button=page.locator('.action-bar').getByRole('button',{name:text,exact:true})
      await expect(button).toBeInViewport()
      await button.tap({trial:true})
    }
    await page.locator('.action-bar').getByRole('button',{name:'碰',exact:true}).tap()
    await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().melds[0]?.type)).toBe('peng')
  })
})
