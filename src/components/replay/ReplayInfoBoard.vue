<script setup lang="ts">
// 中央信息盘（四家分数与名次）。**默认收起**：展开时面板会压住对家的牌面，
// 而局数/巡目/牌山余张在底部控制条上已经有了，折叠态只留一枚小药丸（含本场数）。
import { computed, ref } from 'vue'
import { formatTurn, rankTone } from '../../game/replay/format'
import type { ReplayFrame } from '../../game/replay/projection'
import type { ReplayMatch, ReplayRound } from '../../game/replay/types'

const props = defineProps<{
  match: ReplayMatch
  round: ReplayRound | null
  frame: ReplayFrame | null
}>()

const expanded = ref(false)

/** 分数排名（不依赖引擎，纯按当前帧分数排）。 */
const standings = computed(() => {
  const scores = props.frame?.scores ?? props.round?.anchor.scores ?? []
  return scores
    .map((score, seat) => ({ seat, score, name: props.match.players[seat]?.name ?? `座位${seat + 1}` }))
    .sort((a, b) => b.score - a.score || a.seat - b.seat)
    .map((entry, index) => ({ ...entry, rank: index + 1 }))
})
</script>

<template>
  <section class="replay-info" :class="{ expanded }" aria-label="对局信息">
    <button
      type="button" class="replay-info-toggle" data-testid="replay-info-toggle"
      :aria-expanded="expanded" :title="expanded ? '收起分数' : '展开四家分数'"
      @click="expanded = !expanded"
    >
      本场 {{ round?.honba ?? 0 }} · 分数
      <span aria-hidden="true">{{ expanded ? '▴' : '▾' }}</span>
    </button>

    <div v-show="expanded" class="replay-info-body" data-testid="replay-info-body">
      <div class="replay-info-head">
        <strong>{{ round?.roundLabel ?? '—' }}</strong>
        <span>本场 {{ round?.honba ?? 0 }}</span>
        <span>余 {{ frame?.wallLeft ?? 0 }}</span>
        <span>{{ formatTurn(frame?.turn ?? 1) }}</span>
      </div>
      <ul class="replay-info-scores">
        <li
          v-for="entry in standings"
          :key="entry.seat"
          :class="[`rank-${rankTone(entry.rank)}`, { active: frame?.currentPlayer === entry.seat, self: entry.seat === match.humanSeat }]"
        >
          <b>{{ entry.rank }}</b>
          <span class="name">{{ entry.name }}</span>
          <em>{{ entry.score }}</em>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.replay-info {
  position: absolute;
  top: calc(var(--safe-top) + 50px);
  left: 50%;
  z-index: 4;
  display: grid;
  justify-items: center;
  gap: 5px;
  transform: translateX(-50%);
  pointer-events: none;
}
.replay-info > * { pointer-events: auto; }
.replay-info-toggle {
  padding: 4px 12px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 48%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--theme-panel) 76%, transparent);
  color: var(--theme-accent);
  font-size: 12px;
  letter-spacing: .06em;
  backdrop-filter: blur(3px);
}
.replay-info-toggle span { margin-left: 4px; }
.replay-info-body {
  min-width: min(420px, 74vw);
  padding: 7px 12px 9px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 55%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--theme-panel) 78%, transparent);
  box-shadow: 0 8px 26px rgba(0, 0, 0, .45);
  backdrop-filter: blur(3px);
}
.replay-info-head {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 10px;
  margin-bottom: 6px;
  color: var(--theme-text-muted);
  font-size: 12px;
  letter-spacing: .06em;
}
.replay-info-head strong { color: var(--theme-accent); font-size: 15px; letter-spacing: .12em; }
.replay-info-scores { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin: 0; padding: 0; list-style: none; }
.replay-info-scores li {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  grid-template-rows: auto auto;
  gap: 0 4px;
  padding: 3px 5px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 26%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--theme-panel-elevated) 62%, transparent);
  font-size: 12px;
}
.replay-info-scores li.active { border-color: var(--theme-accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-accent) 45%, transparent) inset; }
.replay-info-scores li.self .name { color: var(--theme-accent); }
.replay-info-scores b { grid-row: span 2; align-self: center; color: var(--theme-text-muted); font-size: 13px; }
.replay-info-scores li.rank-first b { color: var(--theme-accent); }
.replay-info-scores .name { overflow: hidden; color: var(--theme-text); text-overflow: ellipsis; white-space: nowrap; }
.replay-info-scores em { color: var(--theme-accent-secondary); font-size: 12px; font-style: normal; }
</style>
