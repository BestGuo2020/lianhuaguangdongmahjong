<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GamePlayer } from '../../game/core/contracts/types'
import type { BloodFlowTableState } from '../../game/variants/lotus/bloodFlow/types'
import type { TableThemeName } from '../table/three/tableTheme'
import { themePresentationByName, themePresentationCssVariables } from '../../theme/themePresentation'
import BloodFlowRoundLedger from './BloodFlowRoundLedger.vue'
import BloodFlowRoundSummary from './BloodFlowRoundSummary.vue'
import BloodFlowFinalRanking from './BloodFlowFinalRanking.vue'
const props=defineProps<{state:BloodFlowTableState;players:GamePlayer[];localSeat:number;themeName:TableThemeName;matchFinished:boolean;roundLabel?:string;presentationBusy?:boolean}>()
const emit=defineEmits<{nextRound:[];returnToLobby:[];visibleChange:[visible:boolean]}>()
type View='table'|'round'|'final'|'details'
const view=ref<View>('table'), detailsReturn=ref<View>('table'), filterSeat=ref<number|null>(null), requested=ref(false)
const restored=ref(false), opened=new Set<string>()
const result=computed(()=>props.state.roundResult)
const bubbles=computed(()=>['llm','llmAnime'].includes(props.themeName)?props.state.roundBubbles:undefined)
const pending=computed(()=>requested.value||props.state.continuation?.ready)
const summary=()=>props.matchFinished?'final' as const:'round' as const
function showSummary() { if(!result.value)return; view.value=summary(); filterSeat.value=null; restored.value=opened.has(result.value.roundId); opened.add(result.value.roundId) }
function showDetails(seat:number|null=null) { detailsReturn.value=view.value==='table'?'table':view.value==='final'?'final':'round'; filterSeat.value=seat; view.value='details'; restored.value=true }
function showTable() { view.value='table' }
function next() { if(pending.value||!result.value||props.matchFinished)return; requested.value=true; emit('nextRound') }
function retry() { if(!result.value||props.state.continuation?.ready)return; emit('nextRound') }
watch(()=>props.state.roundId,()=>{view.value='table';requested.value=false;filterSeat.value=null;restored.value=false})
watch([()=>result.value?.roundId,()=>props.presentationBusy],([id,busy])=>{if(id&&!busy&&!opened.has(id))showSummary()},{immediate:true})
watch(()=>props.state.status,status=>{if(status==='interrupted')requested.value=false})
watch(view,v=>emit('visibleChange',v!=='table'),{immediate:true})
defineExpose({showSummary,showDetails,showTable})
</script>
<template>
  <button v-if="result&&view==='table'" type="button" class="blood-flow-result-reopen" @click="showSummary">返回结算</button>
  <Teleport to="body"><div v-if="view!=='table'" class="bf-settlement-backdrop" :data-theme="themeName" :style="themePresentationCssVariables(themePresentationByName(themeName))" @click.self="showTable">
    <section class="bf-settlement" :class="{restored}" :data-settlement-view="view" role="dialog" aria-modal="true" :aria-label="view==='details'?'血流公开流水':view==='final'?'血流最终排名':'血流本局结算'">
      <header><small>莲花麻将·血流</small><button type="button" aria-label="关闭流水" @click="showTable">×</button></header>
      <div class="bf-settlement-body">
        <BloodFlowRoundLedger v-if="view==='details'" :open="true" :state="state" :players="players" :local-seat="localSeat" :filter-seat="filterSeat" :theme-name="themeName" embedded />
        <BloodFlowFinalRanking v-else-if="view==='final'&&result" :result="result" :players="players" :local-seat="localSeat" :theme-name="themeName" :bubbles="bubbles" />
        <BloodFlowRoundSummary v-else-if="result" :result="result" :players="players" :local-seat="localSeat" :theme-name="themeName" :round-label="roundLabel" :bubbles="bubbles" />
      </div>
      <p v-if="pending" class="bf-ready-status" role="status">{{ state.continuation?.ready ? `已准备，等待其他玩家（${state.continuation.readySeats.length}/${state.continuation.requiredSeats.length}）` : state.continuation ? '正在确认准备状态…' : '正在进入下一局…' }}</p>
      <p v-if="state.status==='interrupted'" class="bf-ready-status" role="status">连接已中断，保留本局结果。恢复后可重新准备。</p>
      <footer>
        <button v-if="view==='details'&&detailsReturn!=='table'&&result" type="button" @click="view=detailsReturn">返回结算</button>
        <button type="button" @click="showTable">{{ view==='details'?'返回牌桌':'查看牌桌' }}</button>
        <button v-if="view!=='details'" type="button" @click="showDetails()">查看流水</button>
        <button v-if="view==='final'" type="button" @click="view='round'">最后一局结果</button>
        <button v-if="view==='round'&&matchFinished" type="button" @click="view='final'">最终排名</button>
        <button v-if="result&&!matchFinished" type="button" class="bf-primary" :disabled="pending" @click="next">{{ pending?'已提交准备':'继续下一局' }}</button>
        <button v-if="requested&&state.continuation&&!state.continuation.ready" type="button" @click="retry">重试准备</button>
        <button v-if="result" type="button" @click="$emit('returnToLobby')">返回大厅</button>
      </footer>
    </section>
  </div></Teleport>
</template>
<style scoped>
.blood-flow-result-reopen { position:fixed; right:max(16px,env(safe-area-inset-right)); bottom:max(84px,22dvh); z-index:80; min-height:40px; padding:9px 22px; border:1px solid var(--theme-border,#8a947c); border-radius:10px; background:var(--theme-panel,#142424); color:var(--theme-text,#fff2d9); font:inherit; font-weight:700; cursor:pointer; box-shadow:0 4px 18px #0006; }
.bf-settlement-backdrop { position:fixed; inset:0; z-index:180; display:grid; place-items:center; padding:12px; background:#000a; container-type:size; color:var(--theme-text,#fff2d9); }
.bf-settlement { width:min(860px,96vw); max-height:94dvh; display:flex; flex-direction:column; border:1px solid var(--theme-border,#8a947c); border-radius:18px; background:linear-gradient(var(--theme-panel,#142424),var(--theme-panel,#142424)),#10221d; box-shadow:0 24px 90px #0009; overflow:hidden; }
.bf-settlement:not(.restored) {animation:bf-settlement-enter .28s ease-out both}
@keyframes bf-settlement-enter {from{opacity:0;translate:0 20px}to{opacity:1;translate:0 0}}
@media(prefers-reduced-motion:reduce){.bf-settlement:not(.restored){animation:none}}
header,footer { display:flex; align-items:center; gap:8px; padding:12px 18px; flex-shrink:0; } header { justify-content:space-between; border-bottom:1px solid #ffffff18; } header small { opacity:.7; } footer { flex-wrap:wrap; justify-content:center; border-top:1px solid #ffffff18; }
.bf-settlement-body { padding:16px 20px; min-height:0; overflow:auto; overscroll-behavior:contain; }
button { cursor:pointer; border:1px solid var(--theme-border,#8a947c); border-radius:8px; background:transparent; color:inherit; padding:7px 12px; min-height:36px; } button:disabled { cursor:default; opacity:.5; } .bf-primary { background:var(--theme-accent,#e6c482); color:var(--theme-panel,#142424); font-weight:700; }
.bf-ready-status { margin:0; padding:6px 18px; text-align:center; font-size:12px; color:var(--theme-accent,#e6c482); }
[data-theme="rosewood"] .bf-settlement { border-width:3px; border-radius:6px; } [data-theme="happyMahjong"] .bf-settlement { border-radius:26px; border-width:3px; } [data-theme="llm"] .bf-settlement { border-radius:8px; font-family:var(--theme-font,monospace); } [data-theme="llmAnime"] .bf-settlement { border-width:3px; box-shadow:8px 8px 0 #141222; }
@container (max-height:450px) { header,footer { padding:6px 10px; gap:5px; } .bf-settlement-body { padding:8px 10px; } button { min-height:30px; padding:5px 9px; font-size:12px; } }
</style>
