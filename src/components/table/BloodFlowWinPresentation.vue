<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { cuePhase, mainPattern, type BloodFlowCue } from '../../game/variants/lotus/bloodFlow/presentation'
import type { GamePlayer, TableActionEvent } from '../../game/core/contracts/types'
import type { TableThemeName } from './three/tableTheme'
import TableActionCue from './TableActionCue.vue'
import BloodFlowImpactTitle from './BloodFlowImpactTitle.vue'
import {bloodFlowImpactProfile,bloodFlowTitleMotion} from '../../theme/bloodFlowPresentation'
const props=defineProps<{cue:BloodFlowCue|null;now:number;themeName:TableThemeName;localSeat:number;players:GamePlayer[];compact?:boolean}>()
const phase=computed(()=>props.cue?cuePhase(props.cue,props.now):'exit')
const elapsed=computed(()=>props.cue?Math.max(0,props.now-props.cue.startedAt):0)
const media=window.matchMedia('(prefers-reduced-motion: reduce)'),reduced=ref(media.matches)
const updateReduced=()=>{reduced.value=media.matches};media.addEventListener('change',updateReduced);onBeforeUnmount(()=>media.removeEventListener('change',updateReduced))
const motion=computed(()=>props.cue?bloodFlowTitleMotion(props.cue,props.now,props.themeName,reduced.value):null)
const profile=computed(()=>bloodFlowImpactProfile(props.themeName,props.cue?.tier??0,props.cue?.compact,reduced.value))
const stage=computed(()=>!props.cue?'seat':props.cue.seats.length>1||props.cue.merged?'multi':props.cue.seats[0]?.seat===props.localSeat&&!props.cue.compact&&props.cue.tier>=2?'main':'seat')
function titleStyleFor(seat:number,text:string,main=false){
  const m=motion.value;if(!m||!props.cue)return {}
  const relative=(seat-props.localSeat+4)%4
  // The winner owns the location, at every tier. A local high win must never
  // jump across the table merely to make room for a larger title.
  const left=(props.compact?[50,74,44,26]:[50,78,50,22])[relative]
  const anchor=relative===0?{bottom:props.compact?'22%':'19%'}:{top:`${(props.compact?[0,42,8,42]:[0,28,12,28])[relative]}%`}
  const unit=main?(props.compact?52:110):props.cue.tier>=2?(props.compact?36:66):(props.compact?30:54)
  return {left:`${left}%`,...anchor,width:`min(${(text.length*.92+.4)*unit}px,${main?65:34}vw)`,fontFamily:profile.value.font,opacity:m.opacity,transform:`translate(-50%,${m.y}px) perspective(650px) rotateY(${m.tilt}deg) rotateX(${m.tilt*.3}deg) scale(${1+(m.scale-1)*.55}) rotate(${m.rotation}deg)`}
}
const sourceEnd=computed(()=>{const m=props.cue?.phaseMarks;return m?(m.focus+(m.impact-m.focus)*.25):0})
function portraitProgress(index:number){
  if(!props.cue)return 0
  const start=sourceEnd.value-40+index*55,end=props.cue.phaseMarks.impact-140
  return Math.min(1,Math.max(0,(elapsed.value-start)/Math.max(1,end-start)))
}
const activeActors=computed(()=>props.cue?.seats.map((item,index)=>({item,progress:portraitProgress(index)})).filter(actor=>actor.progress>0&&actor.progress<1)??[])
const payerFeedback=computed(()=>props.cue?.deltas.map((amount,seat)=>({amount,seat})).filter(({seat,amount})=>(amount!==0||props.cue?.merged)&&!props.cue?.seats.some(item=>item.seat===seat))??[])
const signed=(n:number)=>`${n>0?'+':''}${n}`
const name=(seat:number)=>props.players[(seat-props.localSeat+4)%4]?.name??`玩家${seat+1}`
const introSource=computed(()=>props.cue?.seats[0]?.source??null)
const introStyle=computed(()=>{
  const source=introSource.value,relative=source?(source.seat-props.localSeat+4)%4:0
  return {left:`${(props.compact?[50,74,44,26]:[50,77,50,23])[relative]}%`,...(relative===0?{bottom:props.compact?'22%':'19%'}:{top:`${(props.compact?[0,42,12,42]:[0,30,12,30])[relative]}%`})}
})
const actionEvent=(seat:number):TableActionEvent=>{
  const item=props.cue!.seats.find(s=>s.seat===seat)!
  return {id:Math.floor(props.cue!.startedAt),type:item.source.kind==='draw'?'self-draw':item.source.kind==='added-kong'?'robbed-kong-win':'discard-win',
    actorIndex:(seat-props.localSeat+4)%4,sourceIndex:item.source.kind==='draw'?null:(item.source.seat-props.localSeat+4)%4,tile:item.source.tile,meldIndex:-1}
}
</script>
<template>
  <div class="blood-flow-presentation" :data-theme="themeName" :class="{compact}" aria-live="polite">
    <div v-if="cue" :key="cue.id" class="blood-flow-cue" :class="[`tier-${cue.tier}`,`stage-${stage}`,{brief:cue.compact}]" :data-cue-id="cue.id" :data-cue-start="cue.startedAt" :data-phase="phase">
      <div v-if="cue.kind==='win'&&(stage==='main'||stage==='multi')" class="blood-flow-dimmer" :style="{opacity:motion?.dimming??0}" aria-hidden="true"></div>
      <!-- 一炮多响：点炮者方位 1.5s 特效字；期间飞牌、动作、主番与收付全部等待。 -->
      <div v-if="cue.kind==='win'&&phase==='intro'" class="blood-flow-multi-intro" :class="{reduced}" :style="introStyle" :data-multi-intro="1">
        <BloodFlowImpactTitle text="一炮多响" :theme="themeName" />
      </div>
      <TableActionCue v-for="actor in activeActors" :key="actor.item.record.id"
        :event="actionEvent(actor.item.seat)" :player="players[(actor.item.seat-localSeat+4)%4]"
        :theme-name="themeName" :data-actor-seat="actor.item.seat" :data-record-id="actor.item.record.id"
        :position="['bottom','right','top','left'][(actor.item.seat-localSeat+4)%4]" :progress="actor.progress" />
      <template v-if="cue.kind==='win'&&elapsed>=cue.phaseMarks.impact-130&&(phase==='focus'||phase==='impact'||phase==='readable')">
        <div v-for="item in cue.seats" :key="item.seat" class="blood-flow-central" :data-title-seat="item.seat"
          :style="titleStyleFor(item.seat,mainPattern(item.record)?.label??'胡牌',stage==='main')">
          <BloodFlowImpactTitle :text="mainPattern(item.record)?.label??'胡牌'" :theme="themeName" />
        </div>
      </template>
      <div v-if="cue.seats.length&&(phase==='score'||phase==='exit')" class="blood-flow-winner-payments">
        <div v-for="item in cue.seats" :key="item.seat" class="blood-flow-winner-payment" :class="`winner-${(item.seat-localSeat+4)%4}`" :data-winner-seat="item.seat"
          :data-payment-seat="item.seat" :data-payment-amount="cue.deltas[item.seat]" :aria-label="`${name(item.seat)}，${cue.merged?'合计':''}${signed(cue.deltas[item.seat])}`">
          <span v-if="cue.merged">合计</span>
          <b :class="{negative:cue.deltas[item.seat]<0}">{{ signed(cue.deltas[item.seat]) }}</b>
        </div>
      </div>
      <template v-if="phase==='score'||phase==='exit'">
        <div v-for="{amount,seat} in payerFeedback" :key="seat" class="blood-flow-seat-feedback"
          :class="[`feedback-${(seat-localSeat+4)%4}`,{negative:amount<0,'win-payment':cue.kind==='win'}]" :data-payment-seat="seat" :data-payment-amount="amount" :aria-label="`${name(seat)}，${cue.merged?'合计':''}${signed(amount)}`">
          <b>{{ signed(amount) }}</b><span v-if="cue.kind==='kong'||cue.merged">{{ cue.kind==='kong'?cue.title:'合计' }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.blood-flow-presentation { position:absolute; inset:0; z-index:42; pointer-events:none; color:var(--theme-text,#fff2d9); }
.blood-flow-cue { position:absolute; inset:0; --win-color:var(--theme-accent,#e4c17a); }
.blood-flow-dimmer { position:absolute; inset:0; background:radial-gradient(ellipse at 50% 35%,#0004,#000 85%); }
.blood-flow-multi-intro { position:absolute; transform:translateX(-50%); width:clamp(200px,26vw,340px); isolation:isolate; animation:multi-intro-pop 1.5s cubic-bezier(.2,1.4,.35,1) both; }
.blood-flow-multi-intro.reduced { animation:none; }
@keyframes multi-intro-pop {
  0% { opacity:0; transform:translateX(-50%) scale(.55) rotate(-4deg); }
  18% { opacity:1; transform:translateX(-50%) scale(1.12) rotate(1.5deg); }
  30% { transform:translateX(-50%) scale(.98) rotate(0); }
  78% { opacity:1; transform:translateX(-50%) scale(1); }
  100% { opacity:0; transform:translateX(-50%) scale(1.04); }
}
.blood-flow-central { position:absolute; width:clamp(170px,23vw,330px); isolation:isolate; transform-origin:50% 65%; }
.stage-main .blood-flow-central { width:clamp(230px,30vw,405px); }
.blood-flow-central::before { content:''; position:absolute; inset:-12% -25%; z-index:-1; background:radial-gradient(ellipse,color-mix(in srgb,var(--win-color) 22%,transparent),transparent 70%); }
[data-theme="rosewood"] .blood-flow-central::before { inset:18% -10%; border-block:1px solid #d3976599; background:linear-gradient(90deg,transparent,#452016b8 25%,#452016b8 75%,transparent); transform:skewX(-8deg); }
[data-theme="happyMahjong"] .blood-flow-central::before { background:conic-gradient(from 15deg,transparent 0 10%,#fbd34477 12% 15%,transparent 17% 30%,#78ceff66 32% 35%,transparent 37% 55%,#ff859677 57% 60%,transparent 62%); clip-path:polygon(8% 12%,80% 0,100% 65%,80% 95%,0 80%); }
[data-theme="llm"] .blood-flow-central::before { inset:20% -8%; border-block:1px solid #6eeaff99; background:repeating-linear-gradient(0deg,#67dce814 0 1px,transparent 1px 5px),linear-gradient(90deg,transparent,#123241cc,transparent); }
[data-theme="llmAnime"] .blood-flow-central::before { background:linear-gradient(135deg,transparent 12%,#fd8db344 15% 17%,transparent 20% 60%,#dab5ef66 63% 66%,transparent 70%); transform:skewX(-15deg); }
.blood-flow-winner-payment { position:absolute; transform:translateX(-50%); display:flex; align-items:baseline; gap:6px; color:var(--theme-positive,#7bddad); white-space:nowrap; }
.blood-flow-winner-payment b { font-size:clamp(40px,5.5vw,76px); line-height:1.1; font-variant-numeric:tabular-nums; }
.blood-flow-winner-payment span { font-size:15px; }
.blood-flow-winner-payment b.negative { color:var(--theme-negative,#ffae9f); }
.blood-flow-winner-payment,.blood-flow-seat-feedback.win-payment { text-shadow:0 2px 3px #000b; paint-order:stroke fill; -webkit-text-stroke:1px #14231da8; }
.blood-flow-seat-feedback.win-payment { border:0; background:none; }
.winner-0 { left:50%; bottom:19%; }.winner-1 { left:77%; top:32%; }.winner-2 { left:50%; top:12%; }.winner-3 { left:23%; top:32%; }
.blood-flow-seat-feedback { position:absolute; display:grid; justify-items:center; transform:translateX(-50%); padding:6px 12px; border-radius:8px; background:var(--theme-panel,#122c25); color:var(--theme-positive,#7bddad); border:1px solid color-mix(in srgb,var(--win-color) 50%,transparent); }
.blood-flow-seat-feedback.negative { color:var(--theme-negative,#ffae9f); }
.blood-flow-seat-feedback b { font-size:clamp(34px,4.6vw,64px); font-variant-numeric:tabular-nums; }
.blood-flow-seat-feedback span { font-size:13px; }
.feedback-0 { bottom:20%; left:50%; }.feedback-1 { top:34%; left:80%; }.feedback-2 { top:12%; left:50%; }.feedback-3 { top:34%; left:20%; }
.compact .blood-flow-central { width:clamp(140px,25vw,210px); }
.compact .blood-flow-multi-intro { width:clamp(150px,24vw,230px); }
.compact :deep(.anime-action-cue) { width:76px; height:60px; --action-art-scale:1.55; }
.compact :deep(.anime-action-copy strong) { font-size:28px; -webkit-text-stroke:3px #2d241c; }
.compact .stage-main .blood-flow-central { width:clamp(170px,30vw,265px); }
.compact .blood-flow-winner-payment b { font-size:32px; }
.compact .blood-flow-winner-payment span { font-size:12px; }
.compact .winner-0 { bottom:22%; }.compact .winner-1 { left:76%; top:55%; }.compact .winner-2 { left:44%; top:8%; }.compact .winner-3 { left:24%; top:55%; }
.compact .blood-flow-seat-feedback { padding:3px 7px; }
.compact .blood-flow-seat-feedback b { font-size:26px; }
.compact .feedback-0 { bottom:22%; }.compact .feedback-2 { top:10%; left:44%; }
.compact .feedback-1,.compact .feedback-3 { top:55%; }
</style>
