import type * as THREE from 'three'
import { createWinEffectPresenter, type WinEffectPresenterOptions } from './winEffectPresenter'
import { bloodFlowWinPiles } from './bloodFlowWinPile'
import { prefersReducedMotion } from '../../../game/core/presentation/winEffect'
import type { WinEffect } from '../../../game/core/contracts/gamePort'
import {bloodFlowImpactProfile} from '../../../theme/bloodFlowPresentation'
import {winTier, type BloodFlowCue} from '../../../game/variants/lotus/bloodFlow/presentation'

/** Consume the viewer director's cue; never create a second queue or timeline. */
export function createBloodFlowWinEffects(options:WinEffectPresenterOptions){
  let cueId='',builtStart=-1,serial=0
  const active:{presenter:ReturnType<typeof createWinEffectPresenter>;cameraStrength:number;dispose():void}[]=[]
  function clear(){active.forEach(e=>e.dispose());active.length=0}
  function build(cue:BloodFlowCue,start:number){
    clear();builtStart=start
    const piles=bloodFlowWinPiles(options.props.bloodFlowBatches??[],options.props.localSeat,options.props.bloodFlowCompact)
    for(const feedback of cue.seats){
      const seat=(feedback.seat-options.props.localSeat+4)%4
      const tile=piles[seat].tiles.find(t=>t.record.id===feedback.record.id)
      if(!tile)continue
      const groups:THREE.Object3D[]=[],resources=new Set<{dispose?:()=>void}>()
      const own=<T>(r:T):T=>{resources.add(r as {dispose?:()=>void});return r}
      const duration=cue.duration-cue.phaseMarks.impact
      const reducedMotion=prefersReducedMotion()
      const profile=bloodFlowImpactProfile(options.props.themeName??'jade',winTier(feedback.record),cue.compact,reducedMotion)
      const effect:WinEffect={id:++serial,winnerIndex:seat,tile:tile.tile,duration,reducedMotion,robbedKong:false,robbedKongPlayerIndex:-1,robbedKongMeldIndex:-1}
      let presenter:ReturnType<typeof createWinEffectPresenter>|undefined
      const dispose=()=>{presenter?.reset();groups.forEach(g=>g.removeFromParent());resources.forEach(r=>r.dispose?.());resources.clear()}
      try{
        presenter=createWinEffectPresenter({...options,own,ownDynamic:own,dynamicGroups:groups,props:{...options.props,winEffect:effect},winLayout:()=>tile,showWinningTile:false,
          // All five themes use their ordinary win beam/glow/particle defaults.
          // Only the existing reduced-motion fallback keeps an optical override.
          startedAt:start,visual:reducedMotion?profile:undefined})
        presenter.addWinEffect()
        groups.forEach(g=>{g.name='blood-flow-win-effect';g.userData.recordId=tile.record.id;g.userData.cueId=cue.id})
        active.push({presenter,dispose,cameraStrength:profile.cameraStrength*(seat===0?1:.25)})
      }catch{dispose()}
    }
  }
  function sync(){
    const cue=options.props.bloodFlowCue
    if((cue?.id??'')!==cueId){clear();cueId=cue?.id??'';builtStart=-1}
  }
  function animate(now:number){
    const cue=options.props.bloodFlowCue
    if(!cue||cue.kind!=='win'||now>=cue.startedAt+cue.duration){if(cueId){clear();cueId='';builtStart=-1}return {active:false,exposureDelta:0,shakeX:0,shakeZ:0}}
    sync()
    // 语音闸门可能把 impact 后移：到（后移后的）光效窗口再建光束，后移就重建。
    const duration=cue.duration-cue.phaseMarks.impact
    const start=cue.startedAt+cue.phaseMarks.impact-duration*.15
    if(builtStart!==start){
      if(now>=start)build(cue,start)
      else if(active.length){clear();builtStart=-1}
    }
    let strongest:{exposureDelta:number;shakeX:number;shakeZ:number}|null=null,strength=-1
    active.forEach(e=>{const frame=e.presenter.animate(now);if(frame&&e.cameraStrength>strength){strength=e.cameraStrength;strongest={exposureDelta:Math.max(-.12,Math.min(.18,frame.exposure-.92))*e.cameraStrength,
      shakeX:frame.shakeX*e.cameraStrength*.45,shakeZ:frame.shakeZ*e.cameraStrength*.45}}})
    return {active:true,...(strongest??{exposureDelta:0,shakeX:0,shakeZ:0})}
  }
  return {sync,animate,dispose:()=>{clear();cueId='';builtStart=-1},get activeCount(){return active.length}}
}
