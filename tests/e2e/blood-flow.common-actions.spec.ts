import {expect, test} from '@playwright/test'

for (const theme of ['jade','llmAnime']) {
  test(`${theme}: shared actions retain labels and each winner owns one display`, async ({page}) => {
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?common=1&count=0&theme=${theme}`)
    await expect(page.locator('.table-loading')).toHaveCount(0)
    for (const [type,label] of [['chi','吃'],['peng','碰'],['concealed-gang','杠'],['discard-win','胡'],['self-draw','自摸']]) {
      await page.evaluate(type => (window as any).__setTableActionCueLab(type,1),type)
      const action=page.locator(`[data-action-type="${type}"]`)
      await expect(action).toHaveCount(1)
      await expect(action).toContainText(label)
      await expect(action).toHaveClass(/action-from-right/)
    }
    await page.goto(`/tests/e2e/fixtures/blood-flow.html?count=0&theme=${theme}`)
    await expect(page.locator('.table-loading')).toHaveCount(0)
    await page.evaluate(() => {
      (window as any).__observedActors=[]
      const sample=()=>{
        const actors=[...document.querySelectorAll('[data-actor-seat]')]
        ;(window as any).__observedActors.push(actors.map(e=>({seat:e.getAttribute('data-actor-seat'),type:e.getAttribute('data-action-type'),text:e.textContent})))
        ;(window as any).__actorFrame=requestAnimationFrame(sample)
      };sample();(window as any).__appendBloodFlowMultiWin()
    })
    await expect(page.locator('.blood-flow-winner-payment')).toHaveCount(3)
    const frames=await page.evaluate(()=>{cancelAnimationFrame((window as any).__actorFrame);return (window as any).__observedActors})
    expect(frames.some((f:any[])=>f.length===3)).toBe(true)
    for(const frame of frames) {
      expect(new Set(frame.map((a:any)=>a.seat)).size).toBe(frame.length)
      for(const actor of frame){expect(actor.type).toBe('discard-win');expect(actor.text).toContain('胡');expect(actor.seat).not.toBe('0')}
    }
    await expect(page.locator('.blood-flow-action')).toHaveCount(0)
    await expect(page.locator('.game-table-hud > .table-action-cue.win')).toHaveCount(0)
    await expect(page.locator('.settlement-card,.blood-flow-settlement-host')).toHaveCount(0)
    await page.evaluate(()=>(window as any).__restoreBloodFlow())
    await expect(page.locator('[data-actor-seat]')).toHaveCount(0)
  })
}
