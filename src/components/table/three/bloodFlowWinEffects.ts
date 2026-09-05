import type * as THREE from 'three'
import { createWinEffectPresenter, type WinEffectPresenterOptions } from './winEffectPresenter'
import { bloodFlowWinPiles } from './bloodFlowWinPile'
import { prefersReducedMotion } from '../../../game/core/presentation/winEffect'
import type { WinEffect } from '../../../game/core/contracts/gamePort'

/** Consume the viewer director's cue; never create a second queue or timeline. */
export function createBloodFlowWinEffects(options:WinEffectPresenterOptions){
  let cueId='',serial=0
  const active:{presenter:ReturnType<typeof createWinEffectPresenter>;dispose():void}[]=[]
  function clear(){active.forEach(e=>e.dispose());active.length=0}
  function sync(){
    const cue=options.props.bloodFlowCue
    if((cue?.id??'')===cueId)return
    clear();cueId=cue?.id??''
    if(!cue)return
    const piles=bloodFlowWinPiles(options.props.bloodFlowBatches??[],options.props.localSeat,options.props.bloodFlowCompact)
    for(const feedback of cue.seats){
      const seat=(feedback.seat-options.props.localSeat+4)%4
      const tile=piles[seat].tiles.find(t=>t.record.id===feedback.record.id)
      if(!tile)continue
      const groups:THREE.Object3D[]=[],resources=new Set<{dispose?:()=>void}>()
      const own=<T>(r:T):T=>{resources.add(r as {dispose?:()=>void});return r}
      const duration=cue.duration-cue.phaseMarks.impact
      const effect:WinEffect={id:++serial,winnerIndex:seat,tile:tile.tile,duration,reducedMotion:prefersReducedMotion(),robbedKong:false,robbedKongPlayerIndex:-1,robbedKongMeldIndex:-1}
      let presenter:ReturnType<typeof createWinEffectPresenter>|undefined
      const dispose=()=>{presenter?.reset();groups.forEach(g=>g.removeFromParent());resources.forEach(r=>r.dispose?.());resources.clear()}
      try{
        presenter=createWinEffectPresenter({...options,own,ownDynamic:own,dynamicGroups:groups,props:{...options.props,winEffect:effect},winLayout:()=>tile,showWinningTile:false,
          startedAt:cue.startedAt+cue.phaseMarks.impact-duration*.15})
        presenter.addWinEffect()
        groups.forEach(g=>{g.name='blood-flow-win-effect';g.userData.recordId=tile.record.id;g.userData.cueId=cue.id})
        active.push({presenter,dispose})
      }catch{dispose()}
    }
  }
  function animate(now:number){
    const cue=options.props.bloodFlowCue
    if(!cue||now>=cue.startedAt+cue.duration){clear();return false}
    active.forEach(e=>e.presenter.animate(now))
    return true
  }
  return {sync,animate,dispose:()=>{clear();cueId=''},get activeCount(){return active.length}}
}
