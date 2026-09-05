import { BloodFlowPresentationQueue, type BloodFlowCue } from './presentation'
import type { WinBatch } from './types'
/** One director per viewer; both DOM and Three.js consume its exact cue and epoch. */
export class BloodFlowPresentationDirector {
  private queue=new BloodFlowPresentationQueue()
  private initialized=false
  private key=''
  active:BloodFlowCue|null=null
  sync(batches:readonly WinBatch[],key:string,now:number){
    if(!this.initialized||key!==this.key){this.initialized=true;this.key=key;this.active=null;this.queue.reset(batches);return}
    for(const batch of batches)this.queue.enqueue(batch,now)
  }
  tick(now:number){
    if(this.active&&now>=this.active.startedAt+this.active.duration)this.active=null
    if(!this.active)this.active=this.queue.next(now)
    return this.active
  }
  get busy(){return !!this.active||this.queue.hasPending}
  hiddenRecordIds(now:number){return [...this.queue.pendingRecordIds,...(this.active&&now<this.active.startedAt+this.active.phaseMarks.readable?this.active.flights.map(f=>f.record.id):[])]}
  reset(){this.initialized=false;this.active=null;this.queue.reset()}
}
