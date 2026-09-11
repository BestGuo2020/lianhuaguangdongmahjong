<script setup lang="ts">
import { computed } from 'vue'
import type { PublicWinScore } from '../../game/variants/lotus/bloodFlow/types'

const props = defineProps<{ score: PublicWinScore; amount?: number }>()
// 明细只走徽标：番型带自身权重，事件/硬胡带各自乘数，不再提供折叠的计分详情。
const orderedItems = computed(() => [...props.score.items].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)))
const SOURCE_LABELS = { 'self-draw': '自摸', discard: '点炮胡', 'robbed-kong': '抢杠胡', 'kong-bloom': '杠后自摸' } as const
const amountLabel = computed(() => props.amount === undefined
  ? `单家 ${props.score.paymentPerPayer}分`
  : `${props.amount >= 0 ? '+' : ''}${props.amount}分`)
</script>

<template>
  <article class="blood-flow-win-card">
    <div class="win-card-main">
      <strong>{{ orderedItems.map(item => item.label).join('·') }}</strong>
      <b>{{ score.finalMultiplier }}<small>倍</small></b>
    </div>
    <div class="win-card-modifiers">
      <span v-for="item in orderedItems" :key="item.id">{{ item.label }}+{{ item.weight }}</span>
      <span>{{ SOURCE_LABELS[score.source] }}×{{ score.eventMultiplier }}</span>
      <span v-if="score.hardWin">硬胡×2</span>
      <span v-if="score.openingApplied">{{ score.opening === 'heaven' ? '天胡' : '地胡' }}保底</span>
      <span v-if="score.capped">已封顶</span>
      <em>{{ amountLabel }}</em>
    </div>
  </article>
</template>

<style scoped>
.blood-flow-win-card { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); border-radius: 10px; color: inherit; background: rgba(255,255,255,.05); }
.win-card-main, .win-card-modifiers { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.win-card-main strong { flex: 1; font-size: 14px; }
.win-card-main b { font-size: 22px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.win-card-main small { font-size: 11px; margin-left: 2px; }
.win-card-modifiers span { border-radius: 5px; background: rgba(255,255,255,.1); padding: 2px 5px; font-size: 11px; }
.win-card-modifiers em { margin-left: auto; font-style: normal; font-weight: 700; }
</style>
