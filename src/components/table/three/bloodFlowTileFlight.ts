import type { BloodFlowCue } from '../../../game/variants/lotus/bloodFlow/presentation'
export interface FlightPose { x:number;y:number;z:number;rotation:number;tilt?:number }
/** Read-only trajectory. Landing happens on the same readable mark used by the director. */
export function sampleBloodFlowFlight(source:FlightPose,target:FlightPose,cue:BloodFlowCue,now:number,reduced=false){
  const elapsed=Math.max(0,now-cue.startedAt),takeoff=Math.min(60,cue.phaseMarks.impact*.4)
  const flight=Math.max(0,Math.min(1,(elapsed-takeoff)/(cue.phaseMarks.impact-takeoff)))
  const t=1-(1-flight)**3
  const settle=Math.max(0,Math.min(1,(elapsed-cue.phaseMarks.impact)/(cue.phaseMarks.readable-cue.phaseMarks.impact)))
  if(reduced)return {...target,progress:1,landed:true}
  const arc=Math.sin(flight*Math.PI)*(.65+cue.tier*.16)
  const bounce=elapsed>=cue.phaseMarks.impact?Math.sin(settle*Math.PI)*(1-settle)*.18:0
  return {x:source.x+(target.x-source.x)*t,y:source.y+(target.y-source.y)*t+arc+bounce,z:source.z+(target.z-source.z)*t,
    rotation:source.rotation+(target.rotation-source.rotation)*t,tilt:(source.tilt??0)*(1-t),progress:t,landed:elapsed>=cue.phaseMarks.readable}
}
