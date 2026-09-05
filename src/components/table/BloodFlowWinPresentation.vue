<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { cuePhase, mainPattern, type BloodFlowCue } from '../../game/variants/lotus/bloodFlow/presentation'
import type { GamePlayer, TableActionEvent } from '../../game/core/contracts/types'
import type { TableThemeName } from './three/tableTheme'
import AnimeActionCue from './AnimeActionCue.vue'
import BloodFlowImpactTitle from './BloodFlowImpactTitle.vue'
import MahjongTile from '../MahjongTile.vue'
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
  const left=[50,78,50,22][relative]
  const anchor=relative===0?{bottom:props.compact?'29%':'19%'}:{top:`${(props.compact?[0,28,8,28]:[0,28,12,28])[relative]}%`}
  const unit=main?(props.compact?52:110):props.cue.tier>=2?(props.compact?36:66):(props.compact?30:54)
  return {left:`${left}%`,...anchor,width:`min(${(text.length*.92+.4)*unit}px,${main?65:34}vw)`,fontFamily:profile.value.font,opacity:m.opacity,transform:`translate(-50%,${m.y}px) perspective(650px) rotateY(${m.tilt}deg) rotateX(${m.tilt*.3}deg) scale(${1+(m.scale-1)*.55}) rotate(${m.rotation}deg)`}
}
const sourceEnd=computed(()=>(props.cue?.phaseMarks.impact??0)*.36)
function portraitProgress(index:number){
  if(!props.cue)return 0
  const start=sourceEnd.value-40+index*55,end=props.cue.phaseMarks.impact-140
  return Math.min(1,Math.max(0,(elapsed.value-start)/Math.max(1,end-start)))
}
const activeActors=computed(()=>props.cue?.seats.map((item,index)=>({item,progress:portraitProgress(index)})).filter(actor=>actor.progress>0&&actor.progress<1)??[])
const payerFeedback=computed(()=>props.cue?.deltas.map((amount,seat)=>({amount,seat})).filter(({seat,amount})=>(amount!==0||props.cue?.merged)&&!props.cue?.seats.some(item=>item.seat===seat))??[])
const signed=(n:number)=>`${n>0?'+':''}${n}`
const name=(seat:number)=>props.players[(seat-props.localSeat+4)%4]?.name??`玩家${seat+1}`
const sourceLabel=(source:string)=>({'self-draw':'自摸',discard:'点炮胡','robbed-kong':'抢杠胡','kong-bloom':'杠后自摸'})[source]??'胡牌'
const sourceText=computed(()=>{
  const cue=props.cue,source=cue?.seats[0]?.source
  if(!cue||!source)return ''
  if(cue.merged)return cue.title
  const relative=(source.seat-props.localSeat+4)%4
  const who=['本家','右家','对家','左家'][relative]
  return `${who}${source.kind==='draw'?'自摸':source.kind==='added-kong'?'被抢杠':'点炮'}${cue.seats.length>1?` · ${cue.title}`:''}`
})
const sourceStyle=computed(()=>{
  const source=props.cue?.seats[0]?.source,relative=source?(source.seat-props.localSeat+4)%4:0
  return {left:`${[50,77,50,23][relative]}%`,...(relative===0?{bottom:props.compact?'29%':'19%'}:{top:`${[0,30,12,30][relative]}%`})}
})
const animeEvent=(seat:number):TableActionEvent=>{
  const item=props.cue!.seats.find(s=>s.seat===seat)!
  return {id:Math.floor(props.cue!.startedAt),type:item.source.kind==='draw'?'self-draw':item.source.kind==='added-kong'?'robbed-kong-win':'discard-win',
    actorIndex:(seat-props.localSeat+4)%4,sourceIndex:item.source.kind==='draw'?null:(item.source.seat-props.localSeat+4)%4,tile:item.source.tile,meldIndex:-1}
}
</script>
<template>
  <div class="blood-flow-presentation" :data-theme="themeName" :class="{compact}" aria-live="polite">
    <div v-if="cue" :key="cue.id" class="blood-flow-cue" :class="[`tier-${cue.tier}`,`stage-${stage}`,{brief:cue.compact}]" :data-cue-id="cue.id" :data-cue-start="cue.startedAt" :data-phase="phase">
      <div v-if="cue.kind==='win'&&(stage==='main'||stage==='multi')" class="blood-flow-dimmer" :style="{opacity:motion?.dimming??0}" aria-hidden="true"></div>
      <div v-if="cue.kind==='win'&&elapsed<sourceEnd" class="blood-flow-source" :style="sourceStyle" :data-source-seat="cue.merged?undefined:cue.seats[0]?.source.seat">
        <MahjongTile v-if="!cue.merged&&cue.seats[0]" :tile="cue.seats[0].source.tile" :theme-name="themeName" small disabled />
        <strong>{{ sourceText }}</strong>
      </div>
      <template v-for="actor in activeActors" :key="actor.item.seat">
        <AnimeActionCue v-if="themeName==='llmAnime'" :event="animeEvent(actor.item.seat)" :player="players[(actor.item.seat-localSeat+4)%4]"
          :data-actor-seat="actor.item.seat" :position="['bottom','right','top','left'][(actor.item.seat-localSeat+4)%4]" :progress="actor.progress" />
        <div v-else class="blood-flow-action" :class="`winner-${(actor.item.seat-localSeat+4)%4}`" :data-actor-seat="actor.item.seat">{{ sourceLabel(actor.item.record.score.source) }}</div>
      </template>
      <template v-if="cue.kind==='win'&&elapsed>=cue.phaseMarks.impact-130&&(phase==='focus'||phase==='impact'||phase==='readable')">
        <div v-for="item in cue.seats" :key="item.seat" class="blood-flow-central" :data-title-seat="item.seat"
          :style="titleStyleFor(item.seat,mainPattern(item.record)?.label??'胡牌',stage==='main')">
          <BloodFlowImpactTitle :text="mainPattern(item.record)?.label??'胡牌'" :theme="themeName" />
        </div>
      </template>
      <div v-if="cue.seats.length&&(phase==='score'||phase==='exit')" class="blood-flow-winner-cards">
        <article v-for="item in cue.seats" :key="item.seat" class="blood-flow-winner-card" :class="`winner-${(item.seat-localSeat+4)%4}`" :data-winner-seat="item.seat"
          :data-payment-seat="item.seat" :data-payment-amount="cue.deltas[item.seat]" :aria-label="`${name(item.seat)}，${sourceLabel(item.record.score.source)}，${cue.merged?'合计':''}${signed(cue.deltas[item.seat])}`">
          <strong>{{ cue.merged?'最近：':'' }}{{ mainPattern(item.record)?.label??'胡牌' }}</strong>
          <span>{{ item.record.score.finalMultiplier }}倍<template v-if="item.record.score.hardWin"> · 硬胡</template> · {{ sourceLabel(item.record.score.source) }} <b :class="{negative:cue.deltas[item.seat]<0}">{{ cue.merged?'合计 ':'' }}{{ signed(cue.deltas[item.seat]) }}</b></span>
        </article>
      </div>
      <template v-if="phase==='score'||phase==='exit'">
        <div v-for="{amount,seat} in payerFeedback" :key="seat" class="blood-flow-seat-feedback"
          :class="[`feedback-${(seat-localSeat+4)%4}`,{negative:amount<0}]" :data-payment-seat="seat" :data-payment-amount="amount" :aria-label="`${name(seat)}，${cue.merged?'合计':''}${signed(amount)}`">
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
.blood-flow-source { position:absolute; transform:translateX(-50%); display:flex; align-items:center; gap:9px; padding:5px 11px; border-radius:6px; border-left:3px solid var(--win-color); background:var(--theme-panel,#122c25); font-size:17px; white-space:nowrap; }
.blood-flow-source :deep(.mahjong-tile.small) { --tile-width:26px; }
.blood-flow-action { position:absolute; transform:translateX(-50%); color:var(--theme-text); font-size:30px; font-family:'KaiTi',serif; text-shadow:0 2px 3px #000; }
.blood-flow-central { position:absolute; width:clamp(170px,23vw,330px); isolation:isolate; transform-origin:50% 65%; }
.stage-main .blood-flow-central { width:clamp(230px,30vw,405px); }
.blood-flow-central::before { content:''; position:absolute; inset:-12% -25%; z-index:-1; background:radial-gradient(ellipse,color-mix(in srgb,var(--win-color) 22%,transparent),transparent 70%); }
[data-theme="rosewood"] .blood-flow-central::before { inset:18% -10%; border-block:1px solid #d3976599; background:linear-gradient(90deg,transparent,#452016b8 25%,#452016b8 75%,transparent); transform:skewX(-8deg); }
[data-theme="happyMahjong"] .blood-flow-central::before { background:conic-gradient(from 15deg,transparent 0 10%,#fbd34477 12% 15%,transparent 17% 30%,#78ceff66 32% 35%,transparent 37% 55%,#ff859677 57% 60%,transparent 62%); clip-path:polygon(8% 12%,80% 0,100% 65%,80% 95%,0 80%); }
[data-theme="llm"] .blood-flow-central::before { inset:20% -8%; border-block:1px solid #6eeaff99; background:repeating-linear-gradient(0deg,#67dce814 0 1px,transparent 1px 5px),linear-gradient(90deg,transparent,#123241cc,transparent); }
[data-theme="llmAnime"] .blood-flow-central::before { background:linear-gradient(135deg,transparent 12%,#fd8db344 15% 17%,transparent 20% 60%,#dab5ef66 63% 66%,transparent 70%); transform:skewX(-15deg); }
.blood-flow-winner-card { position:absolute; transform:translateX(-50%); display:grid; justify-items:center; gap:3px; max-width:min(290px,36vw); padding:7px 12px; border:1px solid color-mix(in srgb,var(--win-color) 60%,transparent); border-radius:8px; background:var(--theme-panel,#122c25); text-align:center; }
.blood-flow-winner-card strong { font-size:19px; color:var(--theme-text,#fff2d9); white-space:nowrap; max-width:100%; overflow:hidden; text-overflow:ellipsis; }
.blood-flow-winner-card span { display:flex; align-items:baseline; gap:4px; white-space:nowrap; font-size:11px; }
.blood-flow-winner-card b { font-size:26px; line-height:1; color:var(--theme-positive,#7bddad); font-variant-numeric:tabular-nums; }
.blood-flow-winner-card b.negative { color:var(--theme-negative,#ffae9f); }
.winner-0 { left:50%; bottom:19%; }.winner-1 { left:77%; top:32%; }.winner-2 { left:50%; top:12%; }.winner-3 { left:23%; top:32%; }
.blood-flow-seat-feedback { position:absolute; display:grid; justify-items:center; padding:6px 12px; border-radius:8px; background:var(--theme-panel,#122c25); color:var(--theme-positive,#7bddad); border:1px solid color-mix(in srgb,var(--win-color) 50%,transparent); }
.blood-flow-seat-feedback.negative { color:var(--theme-negative,#ffae9f); }
.blood-flow-seat-feedback b { font-size:clamp(20px,2.6vw,34px); font-variant-numeric:tabular-nums; }
.blood-flow-seat-feedback span { font-size:10px; }
.feedback-0 { bottom:19%; left:45%; }.feedback-1 { top:38%; right:14%; }.feedback-2 { top:12%; left:45%; }.feedback-3 { top:38%; left:14%; }
.compact .blood-flow-central { width:clamp(140px,25vw,210px); }
.compact .blood-flow-source { font-size:12px; padding:3px 7px; gap:5px; }
.compact .blood-flow-source :deep(.mahjong-tile.small) { --tile-width:19px; }
.compact .blood-flow-action { font-size:22px; }
.compact :deep(.anime-action-cue) { width:76px; height:60px; --action-art-scale:1.55; }
.compact :deep(.anime-action-copy strong) { font-size:28px; -webkit-text-stroke:3px #2d241c; }
.compact .stage-main .blood-flow-central { width:clamp(170px,30vw,265px); }
.compact .blood-flow-winner-card { padding:4px 6px; max-width:37%; }
.compact .blood-flow-winner-card strong { font-size:14px; }
.compact .blood-flow-winner-card span { font-size:9px; gap:2px; }
.compact .blood-flow-winner-card b { font-size:20px; }
.compact .winner-0 { bottom:29%; }.compact .winner-1 { left:79%; top:29%; }.compact .winner-2 { top:8%; }.compact .winner-3 { left:21%; top:29%; }
.compact .blood-flow-seat-feedback { padding:3px 7px; }
.compact .blood-flow-seat-feedback b { font-size:20px; }
.compact .feedback-0 { bottom:29%; }.compact .feedback-2 { top:10%; }
</style>
