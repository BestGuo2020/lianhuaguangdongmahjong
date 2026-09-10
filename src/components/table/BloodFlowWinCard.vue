<script setup lang="ts">
import { computed } from 'vue'
import type { PublicWinScore } from '../../game/variants/lotus/bloodFlow/types'
import { BLOOD_FLOW_CONFIG } from '../../game/variants/lotus/bloodFlow/config'
const props = defineProps<{ score: PublicWinScore; amount?: number; compact?: boolean; preview?: boolean }>()
const orderedItems = computed(() => [...props.score.items].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)))
const expectedIncome = computed(() => props.score.paymentPerPayer * (['self-draw', 'kong-bloom'].includes(props.score.source) ? 3 : 1))
</script>

<template>
  <article class="blood-flow-win-card" :class="{ compact, 'is-preview': preview }">
    <div class="win-card-main">
      <strong>{{ (preview ? orderedItems.slice(0, 2) : orderedItems).map(item => item.label).join('·') }}</strong>
      <b>{{ score.finalMultiplier }}<small>倍</small></b>
    </div>
    <div class="win-card-modifiers">
      <span v-if="score.hardWin">{{ preview ? '硬胡' : '硬胡 ×2' }}</span>
      <span>{{ ({ 'self-draw': '自摸', discard: '点炮胡', 'robbed-kong': '抢杠胡', 'kong-bloom': '杠后自摸' })[score.source] }}</span>
      <span v-if="score.openingApplied">{{ score.opening === 'heaven' ? '天胡' : '地胡' }}保底</span>
      <span v-if="score.capped">已封顶</span>
      <em>{{ preview ? `预计 +${expectedIncome}` : amount === undefined ? `单家 ${score.paymentPerPayer}` : `${amount >= 0 ? '+' : ''}${amount}` }}<template v-if="!preview">分</template></em>
    </div>
    <details v-if="!compact || preview">
      <summary>{{ preview ? '查看预计详情' : '计分详情' }}</summary>
      <p v-if="preview">预计每位付款者 {{ score.paymentPerPayer }}分，共 {{ ['self-draw', 'kong-bloom'].includes(score.source) ? 3 : 1 }}位；以实际胡牌流水为准。</p>
      <p v-for="item in score.items" :key="item.id">{{ item.label }}：{{ item.weight }}倍</p>
      <p>组合 {{ score.patternMultiplier }} × 事件 {{ score.eventMultiplier }}<template v-if="score.openingApplied">，开局保底提升到 {{ BLOOD_FLOW_CONFIG.openingMinimumMultiplier }}倍</template><template v-if="score.hardWin">，再 × 硬胡 2</template>；最终 {{ score.finalMultiplier }}倍</p>
      <p v-for="item in score.excluded" :key="item.id" class="included-item">{{ BLOOD_FLOW_CONFIG.patterns[item.id].label }}由{{ BLOOD_FLOW_CONFIG.patterns[item.includedBy].label }}包含，不重复计分</p>
    </details>
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
summary { cursor: pointer; font-size: 11px; opacity: .8; }
p { margin: 5px 0; font-size: 11px; }
.included-item { opacity: .6; }
.compact { padding: 6px 8px; gap: 3px; }
.compact .win-card-main strong { font-size: 12px; }
.is-preview { position: relative; padding: 0; border: 0; background: none; }
.is-preview .win-card-main { gap: 8px; flex-wrap: nowrap; }
.is-preview .win-card-main strong { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.is-preview .win-card-main b { font-size: 14px; }
.is-preview .win-card-modifiers { gap: 4px; flex-wrap: nowrap; font-size: 12px; white-space: nowrap; }
.is-preview .win-card-modifiers span { padding: 0; background: none; font-size: 10px; }
.is-preview .win-card-modifiers em { color: var(--theme-positive, #9be6c6); }
.is-preview details { font-size: 10px; }
.is-preview details[open] { position: absolute; bottom: calc(100% + 10px); right: 0; z-index: 5; width: min(280px, 70vw); padding: 12px; border: 1px solid var(--theme-accent); border-radius: 8px; background: var(--theme-panel, #122c25); box-shadow: 0 8px 24px #0008; }
</style>
