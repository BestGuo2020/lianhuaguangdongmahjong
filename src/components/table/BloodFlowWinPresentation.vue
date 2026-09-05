<script setup lang="ts">
import { onBeforeUnmount, shallowRef, watch } from 'vue'
import { BloodFlowPresentationQueue } from '../../game/variants/lotus/bloodFlow/presentation'
import type { BloodFlowCue } from '../../game/variants/lotus/bloodFlow/presentation'
import type { WinBatch } from '../../game/variants/lotus/bloodFlow/types'
import type { TableThemeName } from './three/tableTheme'

const props = defineProps<{ batches: readonly WinBatch[]; restoreKey?: string; themeName: TableThemeName; localSeat: number; compact?: boolean }>()
const queue = new BloodFlowPresentationQueue()
const active = shallowRef<BloodFlowCue | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let initialized = false, restoreKey = ''
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
function clear() { if (timer) clearTimeout(timer); timer = null; active.value = null }
function pump() {
  if (active.value) return
  active.value = queue.next(performance.now())
  if (!active.value) return
  timer = setTimeout(() => { active.value = null; timer = null; pump() }, active.value.duration)
}
watch(() => [props.restoreKey, props.batches.map(b => b.batchId).join('|')], () => {
  if (!initialized || restoreKey !== (props.restoreKey ?? '')) {
    initialized = true; restoreKey = props.restoreKey ?? ''; clear(); queue.reset(props.batches); return
  }
  for (const batch of props.batches) queue.enqueue(batch, performance.now())
  pump()
}, { immediate: true })
watch(() => props.themeName, () => { clear(); queue.reset(props.batches) })
onBeforeUnmount(() => { clear(); queue.reset() })
</script>

<template>
  <div class="blood-flow-presentation" :data-theme="themeName" :class="{ compact, reduced: reduced.matches }" aria-live="polite">
    <div v-if="active" :key="active.id" class="blood-flow-cue" :class="[`tier-${active.tier}`, { brief: active.compact }]">
      <div class="blood-flow-central"><small>{{ ['胡牌', '中番', '大番', '顶级番型'][active.tier] }}</small><strong>{{ active.title }}</strong></div>
      <div v-for="feedback in active.seats" :key="feedback.seat" class="blood-flow-seat-feedback"
        :class="`feedback-${(feedback.seat - localSeat + 4) % 4}`">
        <b>+{{ feedback.record.deltas[feedback.seat] }}</b>
        <span>{{ feedback.record.score.finalMultiplier }}倍<template v-if="feedback.record.score.hardWin"> · 硬胡</template><template v-if="feedback.record.score.capped"> · 封顶</template></span>
        <small v-if="feedback.mergedCount > 1">本次收纳 {{ feedback.mergedCount }}条</small>
      </div>
    </div>
  </div>
</template>

<style scoped>
.blood-flow-presentation { position: absolute; inset: 0; z-index: 42; pointer-events: none; color: var(--theme-text, #fff2d9); }
.blood-flow-cue { position: absolute; inset: 0; --win-color: var(--theme-accent, #e4c17a); }
.blood-flow-central { position: absolute; top: 34%; left: 50%; transform: translateX(-50%); display: grid; justify-items: center; gap: 3px; padding: 10px 30px; border-block: 1px solid var(--win-color); background: linear-gradient(90deg, transparent, var(--theme-panel, #112c25) 18%, var(--theme-panel, #112c25) 82%, transparent); text-shadow: 0 2px 8px #000; animation: win-enter .32s ease-out both; }
.blood-flow-central small { font-size: 10px; letter-spacing: .3em; color: var(--win-color); }
.blood-flow-central strong { font-size: clamp(20px, 3vw, 45px); white-space: nowrap; }
.tier-2 .blood-flow-central, .tier-3 .blood-flow-central { padding: 14px 42px; box-shadow: 0 0 38px color-mix(in srgb, var(--win-color) 35%, transparent); }
.tier-3 .blood-flow-central { border-block-width: 3px; }
.brief .blood-flow-central { top: 29%; padding: 5px 18px; box-shadow: none; }
.brief .blood-flow-central strong { font-size: clamp(16px, 2vw, 27px); }
.blood-flow-seat-feedback { position: absolute; display: grid; justify-items: center; padding: 6px 12px; border-radius: 8px; background: var(--theme-panel, #122c25); color: var(--theme-positive, #ffdf87); border: 1px solid var(--win-color); animation: win-feedback .4s ease-out both; }
.blood-flow-seat-feedback b { font-size: clamp(18px, 2.4vw, 30px); font-variant-numeric: tabular-nums; }
.blood-flow-seat-feedback span, .blood-flow-seat-feedback small { font-size: 10px; }
.feedback-0 { bottom: 25%; left: 31%; }.feedback-1 { top: 48%; right: 14%; }.feedback-2 { top: 20%; left: 45%; }.feedback-3 { top: 48%; left: 14%; }
[data-theme="rosewood"] .blood-flow-central { border-radius: 4px; border: 2px solid var(--win-color); box-shadow: inset 0 0 0 3px var(--theme-panel); }
[data-theme="happyMahjong"] .blood-flow-central { border-radius: 40px; border: 3px solid var(--win-color); background: var(--theme-panel); }
[data-theme="llm"] .blood-flow-central { font-family: monospace; letter-spacing: .08em; border: 1px solid var(--win-color); backdrop-filter: blur(8px); }
[data-theme="llmAnime"] .blood-flow-central { border: 3px solid var(--theme-text); background: var(--theme-accent); color: var(--theme-panel); text-shadow: none; box-shadow: 6px 6px 0 #161625; }
.compact .blood-flow-central { top: 29%; padding: 5px 16px; box-shadow: none; backdrop-filter: none; }
.compact .blood-flow-seat-feedback { padding: 3px 8px; }
.reduced .blood-flow-central, .reduced .blood-flow-seat-feedback { animation: none; }
@keyframes win-enter { from { opacity: 0; transform: translateX(-50%) scale(.8); } to { opacity: 1; transform: translateX(-50%) scale(1); } }
@keyframes win-feedback { from { opacity: 0; margin-top: 8px; } to { opacity: 1; margin-top: 0; } }
@media(prefers-reduced-motion: reduce) { .blood-flow-central, .blood-flow-seat-feedback { animation: none; } }
</style>
