import { describe, expect, it } from 'vitest'
import { seatTableLayout, meldTrackTransform, concealedMeldClear, TABLE_LAYOUT, winRegionFrame, addedKongTileOffset, meldTileCenter, meldTileSpan } from './tableLayout'
import { winDisplayLayout } from './winEffect'
import { wallStackSlot } from '../rules/wallLayout'
function bounds(x:number,z:number,rotation:number) {
 const side=Math.abs(Math.sin(rotation))>.5
 return {x0:x-(side?.51:.34),x1:x+(side?.51:.34),z0:z-(side?.34:.51),z1:z+(side?.34:.51)}
}
function overlaps(a:ReturnType<typeof bounds>,b:ReturnType<typeof bounds>){return a.x0<b.x1&&a.x1>b.x0&&a.z0<b.z1&&a.z1>b.z0}
describe('public corner bays',()=>{
 for(const seat of [0,1,2,3]) it(`seat ${seat}: whole row clears all live wall slots and uses fixed right corner`,()=>{
  const layout=seatTableLayout(seat)
  expect(winDisplayLayout(seat)).toEqual(layout.win)
  // The first tile centre is on the inner side of both intersecting wall lines.
  expect(Math.abs(layout.win.x)).toBeLessThan(wallStackSlot(51).x)
  expect(layout.win.z-1).toBeLessThan(wallStackSlot(0).z)
  expect(layout.win.z-1).toBeGreaterThan(wallStackSlot(34).z)
  expect(Math.sign(layout.win.x)).toBe([1,1,-1,-1][seat])
  expect(Math.sign(layout.win.z+1)).toBe([1,-1,-1,1][seat])
  for(let col=0;col<4;col++){
   const tile=bounds(layout.win.x+layout.pileAlong.x*col*.73,layout.win.z-1+layout.pileAlong.z*col*.73,layout.win.rotation)
   for(let wall=0;wall<68;wall++){
    const slot=wallStackSlot(wall)
    expect(overlaps(tile,bounds(slot.x,slot.z,slot.rotationY)),`seat ${seat}, column ${col}, wall ${wall}`).toBe(false)
   }
  }
 })
 for(const seat of [1,2,3]) for(const count of [1,4]) it(`seat ${seat}: ${count} melds clear concealed hand along the actual track`,()=>{
  const span=count*(TABLE_LAYOUT.sourcePitch+2*TABLE_LAYOUT.tilePitch)+(count-1)*TABLE_LAYOUT.groupGap
  const clear=concealedMeldClear(seat,span,13-count*3)
  if(clear!==null){
   const end=meldTrackTransform(seat,span),axis=seat===2?end.x:end.z
   expect(seat===3?axis-(clear+(12-count*3)*TABLE_LAYOUT.tilePitch):clear-axis).toBeCloseTo(TABLE_LAYOUT.handGap)
  }
 })
 for(const seat of [0,1,2,3]) it(`seat ${seat}: full row clears four melds and their added kong tiles`,()=>{
  const region=seatTableLayout(seat),win=region.win
  for(let column=0;column<4;column++) {
   const pile=bounds(win.x+region.pileAlong.x*column*.73,win.z-1+region.pileAlong.z*column*.73,win.rotation)
   for(const other of [0,1,2,3]) {
    let offset=0
    for(let group=0;group<4;group++) {
     for(let tile=0;tile<3;tile++) {
      const source=tile===0,span=meldTileSpan(source),pos=meldTrackTransform(other,meldTileCenter(offset,span))
      const axis=seatTableLayout(other).outward
      if(source){pos.x+=axis.x*.135;pos.z+=axis.z*.135}
      const rotation=pos.rotation+(source?Math.PI/2:0)
      expect(overlaps(pile,bounds(pos.x,pos.z-1,rotation)),`pile ${seat}/${column}, meld ${other}/${group}/${tile}`).toBe(false)
      if(source){const added=addedKongTileOffset(other,TABLE_LAYOUT.tilePitch)
       expect(overlaps(pile,bounds(pos.x+added.x,pos.z-1+added.z,rotation)),`pile ${seat}/${column}, added ${other}/${group}`).toBe(false)}
      offset+=span
     }
     offset+=TABLE_LAYOUT.groupGap
    }
   }
  }
 })
 it('frames taller towers without a level cap',()=>{
  expect(winRegionFrame(40).distance).toBeGreaterThan(winRegionFrame(20).distance)
 })
})
