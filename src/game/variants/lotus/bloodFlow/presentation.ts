import { BLOOD_FLOW_TIMING } from './config'
import type { Seat, SeatVector, SourceTileEvent, WinBatch, WinRecord, KongLedgerEntry } from './types'
import type { TableThemeName } from '../../../../components/table/three/tableTheme'

export type WinTier = 0 | 1 | 2 | 3
export const winTier = (record: WinRecord): WinTier => { const weight=Math.max(...record.score.items.map(p=>p.weight),1); return weight>=16?3:weight>=8?2:weight>=4?1:0 }
export const mainPattern = (record: WinRecord) => [...record.score.items].sort((a,b)=>b.weight-a.weight || a.id.localeCompare(b.id))[0]
export type PresentationPhase='focus'|'impact'|'readable'|'score'|'exit'
export interface BloodFlowCue {
  readonly theme?:TableThemeName
  readonly id:string
  readonly kind:'win'|'kong'
  readonly kongEvents:readonly KongLedgerEntry[]
  readonly title:string
  readonly tier:WinTier
  readonly startedAt:number
  readonly duration:number
  readonly compact:boolean
  readonly merged:boolean
  readonly phaseMarks:Readonly<Record<PresentationPhase,number>>
  readonly batchIds:readonly string[]
  readonly records:readonly {record:WinRecord;source:SourceTileEvent}[]
  readonly flights:readonly {record:WinRecord;source:SourceTileEvent}[]
  readonly deltas:SeatVector<number>
  readonly seats:readonly {seat:Seat;record:WinRecord;source:SourceTileEvent;mergedCount:number;income:number}[]
}
export function cuePhase(cue:BloodFlowCue,now:number):PresentationPhase {
  const elapsed=now-cue.startedAt
  return elapsed>=cue.phaseMarks.exit?'exit':elapsed>=cue.phaseMarks.score?'score':elapsed>=cue.phaseMarks.readable?'readable':elapsed>=cue.phaseMarks.impact?'impact':'focus'
}
/** Immutable display facts only. No scoring, turn or audio operations. */
export class BloodFlowPresentationQueue {
  private seen=new Set<string>()
  private pending:{batch?:WinBatch;kong?:KongLedgerEntry;at:number}[]=[]
  private fullBySeatPattern=new Map<string,number>()
  reset(batches:readonly WinBatch[]=[],kongs:readonly KongLedgerEntry[]=[]){this.seen=new Set([...batches.map(b=>b.batchId),...kongs.map(k=>k.id)]);this.pending=[];this.fullBySeatPattern.clear()}
  enqueue(batch:WinBatch,at:number){if(this.seen.has(batch.batchId))return;this.seen.add(batch.batchId);this.pending.push({batch,at})}
  enqueueKong(kong:KongLedgerEntry,at:number){if(this.seen.has(kong.id))return;this.seen.add(kong.id);this.pending.push({kong,at})}
  get hasPending(){return this.pending.length>0}
  get pendingRecordIds(){return this.pending.flatMap(p=>p.batch?.winners.map(w=>w.id)??[])}
  next(now:number):BloodFlowCue|null {
    if(!this.pending.length)return null
    if(this.pending[0].kong){
      const kong=this.pending.shift()!.kong!
      return {id:kong.id,kind:'kong',kongEvents:[kong],startedAt:now,title:({discard:'直杠',added:'补杠',concealed:'暗杠',wind:'风杠'})[kong.kongKind],tier:0,duration:700,compact:true,merged:false,
        phaseMarks:{focus:0,impact:60,readable:120,score:150,exit:550},batchIds:[],records:[],flights:[],deltas:kong.deltas,seats:[]}
    }
    const boundary=this.pending.findIndex(p=>p.kong),count=boundary<0?this.pending.length:boundary
    const merged=count>3 || now-this.pending[0].at>BLOOD_FLOW_TIMING.visualBacklogMs
    const taken=this.pending.splice(0,merged?count:1) as {batch:WinBatch;at:number}[]
    const records=taken.flatMap(({batch})=>batch.winners.map(record=>({record,source:batch.source})))
    const bySeat=new Map<Seat,{seat:Seat;record:WinRecord;source:SourceTileEvent;mergedCount:number;income:number}>()
    for(const {record,source} of records){const old=bySeat.get(record.winner);bySeat.set(record.winner,{seat:record.winner,record,source,mergedCount:(old?.mergedCount??0)+1,income:(old?.income??0)+record.deltas[record.winner]})}
    const seats=[...bySeat.values()].sort((a,b)=>a.seat-b.seat)
    const strongest=[...seats].sort((a,b)=>winTier(b.record)-winTier(a.record)||b.record.score.paymentPerPayer-a.record.score.paymentPerPayer||a.seat-b.seat)[0]
    const tier=winTier(strongest.record)
    const full=!merged&&seats.some(s=>winTier(s.record)>=2&&now-(this.fullBySeatPattern.get(`${s.seat}/${mainPattern(s.record)?.id}`)??-Infinity)>=BLOOD_FLOW_TIMING.fullEffectCooldownMs)
    if(full)for(const s of seats)if(winTier(s.record)>=2)this.fullBySeatPattern.set(`${s.seat}/${mainPattern(s.record)?.id}`,now)
    const duration=full?(tier===3?1600:1400):750
    const phaseMarks=full?{focus:0,impact:180,readable:350,score:650,exit:duration-240}:{focus:0,impact:100,readable:240,score:350,exit:580}
    const deltas=[0,0,0,0] as [number,number,number,number]
    for(const {batch} of taken)for(let s=0;s<4;s++)deltas[s]+=batch.deltas[s]
    const multi=taken.length===1&&seats.length>1
    return {id:taken.map(p=>p.batch.batchId).join('|'),kind:'win',kongEvents:[],startedAt:now,title:merged?`${taken.length}次胡牌 · 合计`:multi?(seats.length===3?'三响':'二响'):mainPattern(strongest.record)?.label??'胡牌',
      tier,duration,compact:!full,merged,phaseMarks,batchIds:taken.map(p=>p.batch.batchId),records,
      flights:merged?seats.map(s=>({record:s.record,source:s.source})):records,deltas,seats}
  }
}
