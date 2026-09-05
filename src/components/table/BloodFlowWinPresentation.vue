<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { cuePhase, mainPattern, type BloodFlowCue } from '../../game/variants/lotus/bloodFlow/presentation'
import type { GamePlayer, TableActionEvent } from '../../game/core/contracts/types'
import type { TableThemeName } from './three/tableTheme'
import AnimeActionCue from './AnimeActionCue.vue'
import {bloodFlowImpactProfile,bloodFlowTitleMotion} from '../../theme/bloodFlowPresentation'
const props=defineProps<{cue:BloodFlowCue|null;now:number;themeName:TableThemeName;localSeat:number;players:GamePlayer[];compact?:boolean}>()
const phase=computed(()=>props.cue?cuePhase(props.cue,props.now):'exit')
const progress=computed(()=>props.cue?Math.max(0,Math.min(1,(props.now-props.cue.startedAt)/props.cue.duration)):0)
const media=window.matchMedia('(prefers-reduced-motion: reduce)'),reduced=ref(media.matches)
const updateReduced=()=>{reduced.value=media.matches};media.addEventListener('change',updateReduced);onBeforeUnmount(()=>media.removeEventListener('change',updateReduced))
const motion=computed(()=>props.cue?bloodFlowTitleMotion(props.cue,props.now,props.themeName,reduced.value):null)
const profile=computed(()=>bloodFlowImpactProfile(props.themeName,props.cue?.tier??0,props.cue?.compact,reduced.value))
const stage=computed(()=>!props.cue?'seat':props.cue.seats.length>1||props.cue.merged?'multi':props.cue.seats[0]?.seat===props.localSeat&&!props.cue.compact&&props.cue.tier>=2?'main':'seat')
const titleStyle=computed(()=>{
  const m=motion.value;if(!m||!props.cue)return {}
  const relative=(props.cue.seats[0]?.seat-props.localSeat+4)%4
  const left=stage.value==='seat'?[50,77,50,23][relative]:50,top=props.compact?10:stage.value==='seat'?[54,26,12,26][relative]:23
  return {left:`${left}%`,top:`${top}%`,fontFamily:profile.value.font,opacity:m.opacity,transform:`translate(-50%,${m.y}px) scale(${m.scale}) rotate(${m.rotation}deg)`}
})
const portraitProgress=computed(()=>props.cue?Math.min(1,Math.max(0,(props.now-props.cue.startedAt)/props.cue.phaseMarks.readable)):0)
const signed=(n:number)=>`${n>0?'+':''}${n}`
const name=(seat:number)=>props.players[(seat-props.localSeat+4)%4]?.name??`玩家${seat+1}`
const sourceLabel=(source:string)=>({'self-draw':'自摸',discard:'点炮胡','robbed-kong':'抢杠胡','kong-bloom':'杠后自摸'})[source]??'胡牌'
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
      <template v-if="themeName==='llmAnime'&&(phase==='focus'||phase==='impact')">
        <AnimeActionCue v-for="item in cue.seats" :key="item.seat" :event="animeEvent(item.seat)" :player="players[(item.seat-localSeat+4)%4]"
          :position="['bottom','right','top','left'][(item.seat-localSeat+4)%4]" :progress="portraitProgress" hide-copy />
      </template>
      <div v-if="cue.kind==='win'&&(phase==='focus'||phase==='impact'||phase==='readable')" class="blood-flow-central" :style="titleStyle"><strong>{{ cue.title }}</strong></div>
      <div v-if="cue.seats.length&&(phase==='score'||phase==='exit')" class="blood-flow-winner-cards">
        <article v-for="item in cue.seats" :key="item.seat" class="blood-flow-winner-card" :class="`winner-${(item.seat-localSeat+4)%4}`" :data-winner-seat="item.seat"
          :data-payment-seat="item.seat" :data-payment-amount="cue.deltas[item.seat]" :aria-label="`${name(item.seat)}，${sourceLabel(item.record.score.source)}，${cue.merged?'合计':''}${signed(cue.deltas[item.seat])}`">
          <strong>{{ cue.merged?'最近：':'' }}{{ mainPattern(item.record)?.label??'胡牌' }}</strong>
          <span>{{ item.record.score.finalMultiplier }}倍<template v-if="item.record.score.hardWin"> · 硬胡</template> · {{ sourceLabel(item.record.score.source) }} <b :class="{negative:cue.deltas[item.seat]<0}">{{ cue.merged?'合计 ':'' }}{{ signed(cue.deltas[item.seat]) }}</b></span>
        </article>
      </div>
      <template v-if="phase==='score'||phase==='exit'">
        <div v-for="(amount,seat) in cue.deltas" :key="seat" v-show="(amount!==0||cue.merged)&&!cue.seats.some(item=>item.seat===seat)" class="blood-flow-seat-feedback"
          :class="[`feedback-${(seat-localSeat+4)%4}`,{negative:amount<0}]" :data-payment-seat="seat" :data-payment-amount="amount" :aria-label="`${name(seat)}，${cue.merged?'合计':''}${signed(amount)}`">
          <b>{{ signed(amount) }}</b><span v-if="cue.kind==='kong'||cue.merged">{{ cue.kind==='kong'?cue.title:'合计' }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.blood-flow-presentation {position:absolute;inset:0;z-index:42;pointer-events:none;color:var(--theme-text,#fff2d9)}
.blood-flow-cue {position:absolute;inset:0;--win-color:var(--theme-accent,#e4c17a)}
.blood-flow-dimmer {position:absolute;inset:0;background:radial-gradient(ellipse at center,#0004,#000 85%);pointer-events:none}
.blood-flow-central {position:absolute;top:34%;left:50%;transform:translateX(-50%);display:grid;justify-items:center;gap:3px;padding:10px 30px;border-block:1px solid var(--win-color);background:linear-gradient(90deg,transparent,var(--theme-panel,#112c25) 18%,var(--theme-panel,#112c25) 82%,transparent);text-shadow:0 2px 8px #000}
.blood-flow-central small {font-size:10px;letter-spacing:.3em;color:var(--win-color)}
.blood-flow-central strong {font-size:clamp(20px,3vw,45px);white-space:nowrap}
.tier-2 .blood-flow-central,.tier-3 .blood-flow-central {padding:14px 42px;box-shadow:0 0 38px color-mix(in srgb,var(--win-color) 35%,transparent)}
.tier-3 .blood-flow-central {border-block-width:3px}
.brief .blood-flow-central {top:29%;padding:5px 18px;box-shadow:none}
.brief .blood-flow-central strong {font-size:clamp(16px,2vw,27px)}
.blood-flow-seat-feedback {position:absolute;display:grid;justify-items:center;padding:6px 12px;border-radius:8px;background:var(--theme-panel,#122c25);color:var(--theme-positive,#7bddad);border:1px solid var(--win-color)}
.blood-flow-seat-feedback.negative {color:var(--theme-negative,#ffae9f)}
.blood-flow-winner-card {position:absolute;display:grid;gap:3px;justify-items:center;max-width:200px;padding:8px 12px;border:1px solid var(--win-color);border-radius:10px;background:var(--theme-panel,#122c25);text-align:center;transform:translate(-50%,0)}
.blood-flow-winner-card strong {font-size:20px;color:var(--win-color)}.blood-flow-winner-card small {font-size:10px;opacity:.85}.blood-flow-winner-card span {font-size:11px}
.winner-0 {left:50%;top:53%}.winner-1 {left:77%;top:32%}.winner-2 {left:50%;top:12%}.winner-3 {left:23%;top:32%}
.blood-flow-seat-feedback b {font-size:clamp(18px,2.4vw,30px);font-variant-numeric:tabular-nums}
.blood-flow-seat-feedback span {font-size:10px}
.feedback-0 {bottom:25%;left:31%}.feedback-1 {top:48%;right:14%}.feedback-2 {top:2%;left:45%}.feedback-3 {top:48%;left:14%}
[data-theme="rosewood"] .blood-flow-central {border-radius:4px;border:2px solid var(--win-color);box-shadow:inset 0 0 0 3px var(--theme-panel)}
[data-theme="happyMahjong"] .blood-flow-central {border-radius:40px;border:3px solid var(--win-color);background:var(--theme-panel)}
[data-theme="llm"] .blood-flow-central {font-family:monospace;letter-spacing:.08em;border:1px solid var(--win-color);backdrop-filter:blur(8px)}
[data-theme="llmAnime"] .blood-flow-central {border:3px solid var(--theme-text);background:var(--theme-accent);color:var(--theme-panel);text-shadow:none;box-shadow:6px 6px 0 #161625}
.compact .blood-flow-central {top:29%;padding:5px 16px;box-shadow:none;backdrop-filter:none}
.compact .blood-flow-central small {display:none}.compact .blood-flow-central strong {font-size:20px;line-height:1.2}
.compact .blood-flow-central {top:10%}
.compact .blood-flow-winner-cards {position:absolute;left:18%;right:18%;top:16%;display:flex;justify-content:center;gap:4px}
.compact .blood-flow-winner-card {position:static;transform:none;min-width:0;max-width:100%;flex:1;padding:4px;gap:1px}
.compact .blood-flow-winner-card strong {font-size:13px}.compact .blood-flow-winner-card small {font-size:9px}.compact .blood-flow-winner-card span {font-size:10px}
.compact .blood-flow-seat-feedback {top:2%;bottom:auto;right:auto;padding:3px 6px;max-width:18%;box-sizing:border-box}
.compact .feedback-0 {left:20%}.compact .feedback-1 {left:38%}.compact .feedback-2 {left:56%}.compact .feedback-3 {left:74%}
.compact .blood-flow-seat-feedback b {font-size:16px}
.blood-flow-central {border:0!important;background:none!important;box-shadow:none!important;text-shadow:0 3px 0 #17201d,0 0 24px color-mix(in srgb,var(--win-color) 50%,transparent);isolation:isolate}
.blood-flow-central::before {content:'';position:absolute;inset:-12% -25%;z-index:-1;background:radial-gradient(ellipse,color-mix(in srgb,var(--win-color) 25%,transparent),transparent 70%)}
.blood-flow-central strong {color:var(--win-color);font-weight:1000;paint-order:stroke fill;-webkit-text-stroke:1px #13211e}
.stage-main .blood-flow-central strong {font-size:clamp(30px,4.5vw,68px)}.stage-seat .blood-flow-central strong {font-size:clamp(20px,2.5vw,36px)}
.tier-0 .blood-flow-central strong {font-size:clamp(24px,3vw,34px)}.tier-0 .blood-flow-central small {display:none}
[data-theme="rosewood"] .blood-flow-central::before {inset:4% -10%;border-block:2px solid #d39765;background:linear-gradient(90deg,transparent,#452016e8 25%,#452016e8 75%,transparent);transform:skewX(-8deg)}
[data-theme="happyMahjong"] .blood-flow-central strong {color:#ffe174;-webkit-text-stroke:3px #345882;text-shadow:4px 5px 0 #243d5b}
[data-theme="happyMahjong"] .blood-flow-central::before {background:conic-gradient(from 15deg,transparent 0 10%,#fbd34488 12% 15%,transparent 17% 30%,#78ceff88 32% 35%,transparent 37% 55%,#ff859688 57% 60%,transparent 62%);clip-path:polygon(8% 12%,80% 0,100% 65%,80% 95%,0 80%)}
[data-theme="llm"] .blood-flow-central strong {color:#a4f5ff;-webkit-text-stroke:1px #104955;text-shadow:2px 0 #ff74bd88,-2px 0 #4aefff88,0 0 16px #5de5ff88}
[data-theme="llm"] .blood-flow-central::before {border-block:1px solid #6eeaff;background:repeating-linear-gradient(0deg,#67dce814 0 1px,transparent 1px 5px),linear-gradient(90deg,transparent,#123241cc,transparent)}
[data-theme="llmAnime"] .blood-flow-central strong {color:#fff3fa;-webkit-text-stroke:3px #33263f;text-shadow:4px 3px 0 #ed72a7,-3px -2px 0 #80e4ff}
[data-theme="llmAnime"] .blood-flow-central::before {background:linear-gradient(135deg,transparent 12%,#fd8db366 15% 20%,transparent 23% 60%,#8aedff77 63% 70%,transparent 73%);transform:skewX(-15deg)}
.compact .blood-flow-central strong,.compact .stage-main .blood-flow-central strong {font-size:22px}
.blood-flow-winner-card {max-width: min(290px, 36vw); padding: 7px 12px; gap: 3px;}
.blood-flow-winner-card strong {font-size:19px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.blood-flow-winner-card span {display:flex;align-items:baseline;gap:4px;white-space:nowrap;font-size:11px}
.blood-flow-winner-card b {font-size:23px;line-height:1;color:var(--theme-positive,#7bddad);font-variant-numeric:tabular-nums}
.blood-flow-winner-card b.negative {color:var(--theme-negative,#ffae9f)}
.compact .blood-flow-winner-card {padding:4px 6px;max-width:100%}
.compact .blood-flow-winner-card b {font-size:18px}
.compact .blood-flow-winner-card span {font-size:9px;gap:2px}
</style>
