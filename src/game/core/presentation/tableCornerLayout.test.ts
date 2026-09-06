import { tableLiftSlots } from './tableLiftSlots'
import { describe, expect, it } from 'vitest'
import { seatTableLayout, meldTrackTransform, concealedMeldClear, TABLE_LAYOUT, addedKongTileOffset, meldTileCenter, meldTileSpan, discardTileLayout, concealedSideX } from './tableLayout'
import { winDisplayLayout } from './winEffect'
import { wallStackSlot } from '../rules/wallLayout'
function bounds(x:number,z:number,rotation:number) {
 const side=Math.abs(Math.sin(rotation))>.5
 return {x0:x-(side?.51:.34),x1:x+(side?.51:.34),z0:z-(side?.34:.51),z1:z+(side?.34:.51)}
}
function overlaps(a:ReturnType<typeof bounds>,b:ReturnType<typeof bounds>){return a.x0<b.x1&&a.x1>b.x0&&a.z0<b.z1&&a.z1>b.z0}
describe('public corner bays',()=>{
 for(const seat of [0,1,2,3]) it(`seat ${seat}: wide river rows keep the original L-shaped alignment`,()=>{
  const lateral=(index:number)=>{
   const p=discardTileLayout(seat,index)
   return [p.x,-p.z,-p.x,p.z][seat]
  }
  for(let column=0;column<6;column++){
   expect(lateral(18+column)).toBe(lateral(column))
   expect(lateral(28+column)).toBe(lateral(column))
  }
  expect(lateral(18)).toBeCloseTo(-2.5*TABLE_LAYOUT.tilePitch)
  expect(lateral(27)).toBeCloseTo(6.5*TABLE_LAYOUT.tilePitch)
  expect(lateral(27)-lateral(23)).toBeCloseTo(4*TABLE_LAYOUT.tilePitch)
 })
 for(const seat of [0,1,2,3]) it(`seat ${seat}: whole row clears all live wall slots and uses fixed right corner`,()=>{
  const layout=seatTableLayout(seat)
  expect(winDisplayLayout(seat)).toEqual(layout.win)
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

 it('reserves complete corner rows against all four late discard rivers',()=>{
  for(const seat of [0,1,2,3]) {
   const region=seatTableLayout(seat)
   for(let col=0;col<4;col++){
    const pile=bounds(region.win.x+region.pileAlong.x*col*.73,region.win.z-1+region.pileAlong.z*col*.73,region.win.rotation)
    for(const other of [0,1,2,3])for(let index=0;index<28;index++) {
     const discard=discardTileLayout(other,index)
     expect(overlaps(pile,bounds(discard.x,discard.z-1.65,discard.rotation)),`pile ${seat}/${col}, river ${other}/${index}`).toBe(false)
    }
   }
  }
 })

 it('keeps the entire straight four-tile layer off every mechanical opening and border',()=>{
  for(const seat of [0,1,2,3])for(let column=0;column<4;column++){
   const layout=seatTableLayout(seat)
   const tile=bounds(layout.win.x+layout.pileAlong.x*column*TABLE_LAYOUT.pilePitch,layout.win.z-1+layout.pileAlong.z*column*TABLE_LAYOUT.pilePitch,layout.win.rotation)
   expect(layout.win.rotation).toBe([0,Math.PI/2,Math.PI,-Math.PI/2][seat])
   for(const slot of tableLiftSlots()){
    const horizontal=slot.orientation==='horizontal'
    const halfX=(horizontal?slot.length:slot.width)/2+.08,halfZ=(horizontal?slot.width:slot.length)/2+.08
    const opening={x0:slot.centerX-halfX,x1:slot.centerX+halfX,z0:slot.centerZ-halfZ,z1:slot.centerZ+halfZ}
    expect(overlaps(tile,opening),`seat ${seat}, column ${column}, ${slot.side} seam`).toBe(false)
   }
  }
 })

 it('retreats each bay toward its player from the approved screenshot layout',()=>{
  const reference=[{x:7.2,z:4.7},{x:6.35,z:-7.6},{x:-6.35,z:-8},{x:-7.4,z:4.55}]
  for(const seat of [0,1,2,3]){
   const {win,outward}=seatTableLayout(seat),before=reference[seat]
   expect((win.x-before.x)*outward.x+(win.z-1-before.z)*outward.z).toBeGreaterThan(.5)
  }
 })

 it('keeps side hands separated from the entire reserved row even when revealed',()=>{
  for(const seat of [1,3] as const){
   const layout=seatTableLayout(seat)
   for(let column=0;column<4;column++){
    const tile=bounds(layout.win.x+layout.pileAlong.x*column*.73,layout.win.z-1+layout.pileAlong.z*column*.73,layout.win.rotation)
    for(let hand=0;hand<14;hand++){
     const concealed=bounds(concealedSideX(seat),(hand-6.5)*TABLE_LAYOUT.tilePitch-1,Math.PI/2)
     expect(overlaps(tile,concealed),`seat ${seat} column ${column} hand ${hand}`).toBe(false)
    }
   }
  }
 })

})
