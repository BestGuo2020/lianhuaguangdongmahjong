import {expect,it} from 'vitest'
import {MathUtils} from 'three'
import {sampleWinningTileFlight} from './winningTileFlight'

it('preserves the ordinary presenter motion at every point of its original timeline',()=>{
  const source={x:7,y:.28,z:8,rotation:Math.PI},target={x:3,y:.28,z:2,rotation:0}
  for(let ms=0;ms<=2000;ms+=10){
    const pose=sampleWinningTileFlight(source,target,{takeoffAt:1040,impactAt:1300,landedAt:1300},1000+ms)
    const oldApproach=MathUtils.smoothstep(ms/2000,.02,.15)
    expect(pose.x).toBeCloseTo(MathUtils.lerp(source.x,target.x,oldApproach),12)
    expect(pose.y).toBe(.28)
    expect(pose.z).toBeCloseTo(MathUtils.lerp(source.z,target.z,oldApproach),12)
    expect(pose.rotation).toBeCloseTo(MathUtils.lerp(Math.PI,0,oldApproach),12)
    expect(pose.scale).toBeCloseTo(MathUtils.lerp(.7,1,oldApproach)+Math.sin(oldApproach*Math.PI)*.28,12)
  }
})
it('external landing hands off a settled pose and reduced motion bypasses travel',()=>{
  const source={x:7,y:.5,z:8,rotation:1,tilt:-Math.PI/2},target={x:3,y:4,z:2,rotation:0}
  const timing={takeoffAt:100,impactAt:700,landedAt:950}
  expect(sampleWinningTileFlight(source,target,timing,99)).toMatchObject({...source,landed:false})
  expect(sampleWinningTileFlight(source,target,timing,800).y).toBeGreaterThan(target.y)
  expect(sampleWinningTileFlight(source,target,timing,950)).toMatchObject({...target,tilt:0,landed:true})
  expect(sampleWinningTileFlight(source,target,timing,0,true)).toMatchObject({...target,landed:true})
})
