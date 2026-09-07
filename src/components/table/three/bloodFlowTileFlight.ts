import type { BloodFlowCue } from '../../../game/variants/lotus/bloodFlow/presentation'
import { sampleWinningTileFlight, type FlightPose } from './winningTileFlight'
export type { FlightPose } from './winningTileFlight'
/** Blood-flow supplies only poses and its director's absolute marks. */
export function sampleBloodFlowFlight(source:FlightPose,target:FlightPose,cue:BloodFlowCue,now:number,reduced=false) {
  // 起飞点相对 focus（多响 intro 的结束点），而不是整段 impact 的 1/4。
  const focus=cue.phaseMarks.focus
  return sampleWinningTileFlight(source,target,{
    takeoffAt:cue.startedAt+focus+(cue.phaseMarks.impact-focus)*.25,
    impactAt:cue.startedAt+cue.phaseMarks.impact,
    landedAt:cue.startedAt+cue.phaseMarks.readable,
  },now,reduced)
}
