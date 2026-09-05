<script setup lang="ts">
import { computed } from 'vue'
import { cuePhase, type BloodFlowCue } from '../../game/variants/lotus/bloodFlow/presentation'
import type { GamePlayer, TableActionEvent } from '../../game/core/contracts/types'
import type { TableThemeName } from './three/tableTheme'
import AnimeActionCue from './AnimeActionCue.vue'
const props=defineProps<{cue:BloodFlowCue|null;now:number;themeName:TableThemeName;localSeat:number;players:GamePlayer[];compact?:boolean}>()
const phase=computed(()=>props.cue?cuePhase(props.cue,props.now):'exit')
const progress=computed(()=>props.cue?Math.max(0,Math.min(1,(props.now-props.cue.startedAt)/props.cue.duration)):0)
const signed=(n:number)=>`${n>0?'+':''}${n}`
const animeEvent=(seat:number):TableActionEvent=>{
  const item=props.cue!.seats.find(s=>s.seat===seat)!
  return {id:Math.floor(props.cue!.startedAt),type:item.source.kind==='draw'?'self-draw':item.source.kind==='added-kong'?'robbed-kong-win':'discard-win',
    actorIndex:(seat-props.localSeat+4)%4,sourceIndex:item.source.kind==='draw'?null:(item.source.seat-props.localSeat+4)%4,tile:item.source.tile,meldIndex:-1}
}
</script>
<template>
  <div class="blood-flow-presentation" :data-theme="themeName" :class="{compact}" aria-live="polite">
    <div v-if="cue" :key="cue.id" class="blood-flow-cue" :class="[`tier-${cue.tier}`,{brief:cue.compact}]" :data-cue-id="cue.id" :data-cue-start="cue.startedAt" :data-phase="phase">
      <template v-if="themeName==='llmAnime'">
        <AnimeActionCue v-for="item in cue.seats" :key="item.seat" :event="animeEvent(item.seat)" :player="players[(item.seat-localSeat+4)%4]"
          :position="['bottom','right','top','left'][(item.seat-localSeat+4)%4]" :progress="progress" hide-copy />
      </template>
      <div class="blood-flow-central"><small>{{ ['胡牌','中番','大番','顶级番型'][cue.tier] }}</small><strong>{{ cue.title }}</strong></div>
      <template v-if="phase==='score'||phase==='exit'">
        <div v-for="(amount,seat) in cue.deltas" :key="seat" v-show="amount!==0||cue.merged" class="blood-flow-seat-feedback"
          :class="[`feedback-${(seat-localSeat+4)%4}`,{negative:amount<0}]" :data-payment-seat="seat" :data-payment-amount="amount">
          <b>{{ signed(amount) }}</b><span>{{ cue.merged?'合计变化':'本次变化' }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.blood-flow-presentation {position:absolute;inset:0;z-index:42;pointer-events:none;color:var(--theme-text,#fff2d9)}
.blood-flow-cue {position:absolute;inset:0;--win-color:var(--theme-accent,#e4c17a)}
.blood-flow-central {position:absolute;top:34%;left:50%;transform:translateX(-50%);display:grid;justify-items:center;gap:3px;padding:10px 30px;border-block:1px solid var(--win-color);background:linear-gradient(90deg,transparent,var(--theme-panel,#112c25) 18%,var(--theme-panel,#112c25) 82%,transparent);text-shadow:0 2px 8px #000}
.blood-flow-central small {font-size:10px;letter-spacing:.3em;color:var(--win-color)}
.blood-flow-central strong {font-size:clamp(20px,3vw,45px);white-space:nowrap}
.tier-2 .blood-flow-central,.tier-3 .blood-flow-central {padding:14px 42px;box-shadow:0 0 38px color-mix(in srgb,var(--win-color) 35%,transparent)}
.tier-3 .blood-flow-central {border-block-width:3px}
.brief .blood-flow-central {top:29%;padding:5px 18px;box-shadow:none}
.brief .blood-flow-central strong {font-size:clamp(16px,2vw,27px)}
.blood-flow-seat-feedback {position:absolute;display:grid;justify-items:center;padding:6px 12px;border-radius:8px;background:var(--theme-panel,#122c25);color:var(--theme-positive,#7bddad);border:1px solid var(--win-color)}
.blood-flow-seat-feedback.negative {color:var(--theme-negative,#ffae9f)}
.blood-flow-seat-feedback b {font-size:clamp(18px,2.4vw,30px);font-variant-numeric:tabular-nums}
.blood-flow-seat-feedback span {font-size:10px}
.feedback-0 {bottom:25%;left:31%}.feedback-1 {top:48%;right:14%}.feedback-2 {top:20%;left:45%}.feedback-3 {top:48%;left:14%}
[data-theme="rosewood"] .blood-flow-central {border-radius:4px;border:2px solid var(--win-color);box-shadow:inset 0 0 0 3px var(--theme-panel)}
[data-theme="happyMahjong"] .blood-flow-central {border-radius:40px;border:3px solid var(--win-color);background:var(--theme-panel)}
[data-theme="llm"] .blood-flow-central {font-family:monospace;letter-spacing:.08em;border:1px solid var(--win-color);backdrop-filter:blur(8px)}
[data-theme="llmAnime"] .blood-flow-central {border:3px solid var(--theme-text);background:var(--theme-accent);color:var(--theme-panel);text-shadow:none;box-shadow:6px 6px 0 #161625}
.compact .blood-flow-central {top:29%;padding:5px 16px;box-shadow:none;backdrop-filter:none}
.compact .blood-flow-central small {display:none}.compact .blood-flow-central strong {font-size:20px;line-height:1.2}
.compact .blood-flow-seat-feedback {top:2%;bottom:auto;right:auto;padding:3px 6px;max-width:18%;box-sizing:border-box}
.compact .feedback-0 {left:20%}.compact .feedback-1 {left:38%}.compact .feedback-2 {left:56%}.compact .feedback-3 {left:74%}
.compact .blood-flow-seat-feedback b {font-size:16px}
[data-phase="focus"] .blood-flow-central {opacity:.4}[data-phase="exit"] .blood-flow-central {opacity:.4}
</style>
