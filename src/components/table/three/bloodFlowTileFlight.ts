import type { BloodFlowCue } from '../../../game/variants/lotus/bloodFlow/presentation'
import { sampleWinningTileFlight, type FlightPose } from './winningTileFlight'
export type { FlightPose } from './winningTileFlight'
/** Blood-flow supplies only poses and its director's absolute marks. */
export function sampleBloodFlowFlight(source:FlightPose,target:FlightPose,cue:BloodFlowCue,now:number,reduced=false) {
  return sampleWinningTileFlight(source,target,{
    takeoffAt:cue.startedAt+cue.phaseMarks.impact*.25,
    impactAt:cue.startedAt+cue.phaseMarks.impact,
    landedAt:cue.startedAt+cue.phaseMarks.readable,
  },now,reduced)
}
