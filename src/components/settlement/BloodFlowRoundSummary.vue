<script setup lang="ts">
import type { GamePlayer } from '../../game/core/contracts/types'
import type { BloodFlowRoundResult } from '../../game/variants/lotus/bloodFlow/types'
import type { TableThemeName } from '../table/three/tableTheme'
import BloodFlowResultPlayers from './BloodFlowResultPlayers.vue'
defineProps<{ result: BloodFlowRoundResult; players: GamePlayer[]; localSeat: number; themeName: TableThemeName; roundLabel?: string;
  bubbles?: Record<number,{text:string;id:number}> }>()
</script>
<template>
  <div class="bf-round-summary">
    <div class="bf-result-hero"><small>{{ roundLabel || '本局' }} · 牌墙摸尽</small><h2>{{ result.winCounts.every(n=>n===0)?'本局无人胡牌':'本局结束' }}</h2><p>本局净变化</p></div>
    <BloodFlowResultPlayers v-bind="$props" />
  </div>
</template>
<style scoped>
.bf-result-hero { text-align:center; margin:6px 0 22px; } small,p { opacity:.68; font-size:12px; } h2 { margin:8px 0; font-size:clamp(25px,4vw,42px); color:var(--theme-accent,#e6c482); letter-spacing:.1em; } p { margin:0; }
@container (max-height:450px) { .bf-result-hero { margin:0 0 10px; } h2 { margin:4px 0; font-size:24px; } }
</style>
