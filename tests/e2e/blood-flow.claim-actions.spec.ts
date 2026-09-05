import { expect, test } from '@playwright/test'

for (const [label, kind] of [['碰','peng'],['杠','gang'],['吃','chi'],['胡','win'],['过','pass']] as const) {
  test(`can choose ${label} immediately from a single combined response`, async ({page}) => {
    const errors:string[]=[]
    page.on('pageerror', error=>errors.push(error.message))
    await page.goto('/tests/e2e/fixtures/blood-flow-claims.html')
    const actions=page.locator('.action-bar')
    for (const text of ['碰','杠','吃','胡','过']) await expect(actions.getByRole('button',{name:text,exact:true})).toBeVisible()
    await actions.getByRole('button',{name:label,exact:true}).click()
    // The shared HUD executes a single chi candidate immediately.
    await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().commands.map((c:any)=>c.action.kind))).toEqual([kind])
    const evidence=await page.evaluate(()=>(window as any).__claimEvidence())
    if (['peng','gang','chi'].includes(kind)) expect(evidence.melds[0].type).toBe(kind)
    if (kind==='win') expect(evidence.wins).toBe(1)
    if (kind==='pass') { expect(evidence.melds).toEqual([]); expect(evidence.discards).toContain('m5') }
    expect(evidence.window).toBe('turn')
    expect(errors).toEqual([])
  })
}
test('reuses the existing picker when hu and multiple chi choices coexist',async({page})=>{
  await page.goto('/tests/e2e/fixtures/blood-flow-claims.html?multiChi=1')
  await page.locator('.action-bar').getByRole('button',{name:'吃',exact:true}).click()
  await expect(page.locator('.chi-picker-option')).toHaveCount(3)
  await page.locator('.chi-picker-option').nth(2).click()
  await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().commands.map((c:any)=>c.action)))
    .toEqual([{kind:'chi',tiles:['m5','m6','m7']}])
})
test.describe('touch layout',()=>{
  test.use({viewport:{width:844,height:390},hasTouch:true})
  test('keeps all five choices visible and tappable together',async({page})=>{
    await page.goto('/tests/e2e/fixtures/blood-flow-claims.html')
    for (const text of ['碰','杠','吃','胡','过']) {
      const button=page.locator('.action-bar').getByRole('button',{name:text,exact:true})
      await expect(button).toBeInViewport()
      await button.tap({trial:true})
    }
    await page.locator('.action-bar').getByRole('button',{name:'碰',exact:true}).tap()
    await expect.poll(()=>page.evaluate(()=>(window as any).__claimEvidence().melds[0]?.type)).toBe('peng')
  })
})
