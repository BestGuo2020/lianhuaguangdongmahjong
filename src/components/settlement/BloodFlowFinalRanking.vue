<script setup lang="ts">
import type { GamePlayer } from '../../game/core/contracts/types'
import type { BloodFlowRoundResult } from '../../game/variants/lotus/bloodFlow/types'
import type { TableThemeName } from '../table/three/tableTheme'
import BloodFlowResultPlayers from './BloodFlowResultPlayers.vue'
defineProps<{ result: BloodFlowRoundResult; players: GamePlayer[]; localSeat: number; themeName: TableThemeName;
  bubbles?: Record<number,{text:string;id:number}> }>()
</script>
<template>
  <div class="bf-final-ranking"><div class="bf-final-hero"><small>本场结束</small><h2>最终排名</h2><p>按本场累计积分排名</p></div>
    <BloodFlowResultPlayers v-bind="$props" final />
  </div>
</template>
<style scoped>
.bf-final-hero { text-align:center; margin:6px 0 22px; } h2 { margin:8px 0; font-size:clamp(28px,4vw,46px); color:var(--theme-accent,#e6c482); letter-spacing:.15em; } small,p { opacity:.7; font-size:12px; } p { margin:0; }
@container (max-height:450px) { .bf-final-hero { display:flex;align-items:center;justify-content:center;gap:8px;margin:0 0 8px; } h2 { font-size:24px; margin:0; } small{display:none} p{font-size:10px} }
</style>
