/** Shared display motion; never moves a physical tile or advances a turn. */
export interface FlightPose { x:number; y:number; z:number; rotation:number; tilt?:number }
export interface WinningTileFlightTiming { takeoffAt:number; impactAt:number; landedAt:number }
const clamp = (value:number) => Math.max(0,Math.min(1,value))
export function sampleWinningTileFlight(source:FlightPose,target:FlightPose,timing:WinningTileFlightTiming,now:number,reduced=false) {
  if(reduced)return {...target,tilt:target.tilt??0,scale:1,progress:1,landed:true}
  const flight=clamp((now-timing.takeoffAt)/Math.max(1,timing.impactAt-timing.takeoffAt))
  // Original smoothstep approach, now sampled using absolute external marks.
  const progress=reduced?1:flight*flight*(3-2*flight)
  const settle=clamp((now-timing.impactAt)/Math.max(1,timing.landedAt-timing.impactAt))
  const hasSettle=timing.landedAt>timing.impactAt
  const arc=reduced||!hasSettle?0:Math.sin(flight*Math.PI)*.8
  const bounce=reduced||!hasSettle||now<timing.impactAt?0:Math.sin(settle*Math.PI)*(1-settle)*.18
  return {x:source.x+(target.x-source.x)*progress,y:source.y+(target.y-source.y)*progress+arc+bounce,
    z:source.z+(target.z-source.z)*progress,rotation:source.rotation+(target.rotation-source.rotation)*progress,
    tilt:(source.tilt??0)+((target.tilt??0)-(source.tilt??0))*progress,
    scale:.7+.3*progress+Math.sin(progress*Math.PI)*.28,progress,landed:reduced||now>=timing.landedAt}
}
