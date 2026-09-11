import {expect,test} from '@playwright/test'
import {mkdir} from 'node:fs/promises'

// 血流听牌面板容量：一行最多 9 张。面板是绝对定位的收缩宽度容器且 overflow-x: hidden，
// 列数算多了牌会被静默裁掉、列宽算窄了会互相压叠，这里对两者都直接取证。
const dir='work/blood-flow-waits-panel'
const fixture='/tests/e2e/fixtures/blood-flow.html?waits=9&theme=jade&controls=1&hudStates=1'

// 首个用例要付 Vite 冷启动的模块转换成本（实测 >90s），先预热一次，避免用例假失败。
test.beforeAll(async({browser})=>{
  test.setTimeout(180000)
  const page=await browser.newPage()
  await page.goto(fixture,{waitUntil:'commit',timeout:150000}).catch(()=>{})
  // 预热要等到应用挂载：此时整条模块图（含 three.js）都已被 Vite 转换过。
  await page.getByRole('button',{name:'选牌画面',exact:true}).waitFor({state:'attached',timeout:150000}).catch(()=>{})
  await page.close()
})

for(const [width,height,firstRow] of [[1280,720,9],[1024,600,9],[844,390,9],[568,320,9],[390,844,7]] as const){
  test.describe(`${width}x${height}`,()=>{
    test.use({viewport:{width,height},isMobile:width<900,hasTouch:width<900})
    test('9 waits stay inside the panel',async({page})=>{
      test.setTimeout(60000)
      await mkdir(dir,{recursive:true})
      await page.goto(fixture)
      // 只验听牌面板几何：不依赖 3D 牌桌加载完成（无 GPU 的机器上 .table-loading 不会消失），
      // 这里直接点 fixture 的「选牌画面」按钮。
      const selection=page.getByRole('button',{name:'选牌画面',exact:true})
      await selection.waitFor({state:'attached',timeout:30000})
      await selection.evaluate(el=>(el as HTMLElement).click())
      await expect(page.locator('.blood-flow-wait-tile')).toHaveCount(9)

      const cells=await page.locator('.blood-flow-wait-tile').evaluateAll(es=>es.map(el=>{
        const box=el.getBoundingClientRect();return {top:Math.round(box.top),left:box.left,right:box.right}
      }))
      const rows=[...new Set(cells.map(cell=>cell.top))].sort((a,b)=>a-b)
        .map(top=>cells.filter(cell=>cell.top===top).sort((a,b)=>a.left-b.left))
      expect(cells).toHaveLength(9)
      for(const row of rows){
        expect(row.length).toBeLessThanOrEqual(9)
        for(let index=1;index<row.length;index++) expect(row[index].left).toBeGreaterThanOrEqual(row[index-1].right-0.5)
      }
      expect(rows[0]).toHaveLength(firstRow)

      // 牌面本身不重叠、不被压扁：列宽不足时 1fr 轨道会把 30/44px 的牌压叠在一起。
      const tiles=await page.locator('.blood-flow-wait-tile .mahjong-tile').evaluateAll(es=>es.map(el=>{
        const box=el.getBoundingClientRect();return {top:Math.round(box.top),left:box.left,right:box.right,width:box.width}
      }))
      for(const tile of tiles) expect(tile.width).toBeGreaterThanOrEqual(26)
      for(const top of new Set(tiles.map(tile=>tile.top))){
        const row=tiles.filter(tile=>tile.top===top).sort((a,b)=>a.left-b.left)
        for(let index=1;index<row.length;index++) expect(row[index].left).toBeGreaterThanOrEqual(row[index-1].right-0.5)
      }

      const panel=await page.locator('.blood-flow-waiting-tip').evaluate(el=>{
        const box=el.getBoundingClientRect()
        return {scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,x:box.x,right:box.right}
      })
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth)
      expect(panel.x).toBeGreaterThanOrEqual(0)
      expect(panel.right).toBeLessThanOrEqual(width)

      // 取证截图：无 GPU 机器上牌桌一直停在加载态，盖住面板，这里只藏加载遮罩。
      await page.addStyleTag({content:'.table-loading{display:none!important}'})
      await page.screenshot({path:`${dir}/${width}x${height}-waits.png`})
    })
  })
}
