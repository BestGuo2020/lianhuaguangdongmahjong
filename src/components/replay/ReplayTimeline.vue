<script setup lang="ts">
// 回放控制条（对应参考图底部）：牌山余张 / 上一局 / 局切换 / 上一步 / 巡目 / 下一步 / 下一局 / 播放 / 调速。
// 按需求**不含进度条**，也不支持拖动或点击时间轴定位。
import { computed } from 'vue'
import { formatPosition, formatTurn } from '../../game/replay/format'
import { REPLAY_SPEEDS, type ReplaySpeed } from '../../game/replay/useReplayPlayer'
import type { ReplayFrame } from '../../game/replay/projection'
import type { ReplayRound } from '../../game/replay/types'

const props = defineProps<{
  rounds: ReplayRound[]
  roundIndex: number
  frameIndex: number
  frameCount: number
  frame: ReplayFrame | null
  playing: boolean
}>()

const emit = defineEmits<{
  round: [index: number]
  first: []
  prev: []
  next: []
  last: []
  toggle: []
  speed: [value: ReplaySpeed]
}>()

const speed = defineModel<ReplaySpeed>('speed', { required: true })

const roundLabel = computed(() => props.rounds[props.roundIndex]?.roundLabel ?? '—')
const position = computed(() => formatPosition(props.frameIndex + 1, props.frameCount))

function shiftRound(offset: number) {
  const next = props.roundIndex + offset
  if (next < 0 || next >= props.rounds.length) return
  emit('round', next)
}
</script>

<template>
  <section class="replay-timeline" aria-label="回放控制条">
    <div class="replay-round-controls">
    <button
      type="button" class="replay-step" :disabled="roundIndex <= 0"
      aria-label="上一局" title="上一局" @click="shiftRound(-1)"
    ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M18 5l-9 7 9 7Z" /></svg></button>

    <label class="replay-round">
      <span class="sr-only">切换牌局</span>
      <select :value="roundIndex" @change="emit('round', Number(($event.target as HTMLSelectElement).value))">
        <option v-for="(round, index) in rounds" :key="round.id" :value="index">{{ round.roundLabel }}</option>
      </select>
    </label>

    <button
      type="button" class="replay-step" :disabled="roundIndex >= rounds.length - 1"
      aria-label="下一局" title="下一局" @click="shiftRound(1)"
    ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M6 5l9 7-9 7Z" /></svg></button>
    </div>
    <div class="replay-playback-controls">
    <button type="button" class="replay-step" aria-label="上一步" title="上一步" :disabled="frameIndex <= 0" @click="emit('prev')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-8 7 8 7" /></svg>
    </button>
    <button
      type="button" class="replay-play" :class="{ playing }"
      :aria-label="playing ? '暂停' : '播放'" :title="playing ? '暂停' : '播放'"
      @click="emit('toggle')"
    ><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="playing" d="M7 5h3v14H7ZM14 5h3v14h-3Z" /><path v-else d="m8 5 11 7-11 7Z" /></svg></button>
    <button type="button" class="replay-step" aria-label="下一步" title="下一步" :disabled="frameIndex >= frameCount - 1" @click="emit('next')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 8 7-8 7" /></svg>
    </button>
    </div>
    <div class="replay-status-controls">
    <span class="replay-wall" data-testid="replay-wall-left">余 {{ frame?.wallLeft ?? 0 }} 张</span>
    <span class="replay-turn" data-testid="replay-turn">
      <b>{{ formatTurn(frame?.turn ?? 1) }}</b>
      <i>{{ position }}</i>
    </span>
    <label class="replay-speed">
      <span class="sr-only">播放速度</span>
      <select v-model="speed">
        <option v-for="value in REPLAY_SPEEDS" :key="value" :value="value">{{ value }}x</option>
      </select>
    </label>
    </div>
  </section>
</template>

<style scoped>
.replay-timeline {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 6;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  height: var(--replay-controls-height, calc(64px + var(--safe-bottom)));
  padding: 4px calc(16px + var(--safe-right)) calc(4px + var(--safe-bottom)) calc(16px + var(--safe-left));
  border-top: 1px solid color-mix(in srgb, var(--theme-border) 42%, transparent);
  background: color-mix(in srgb, var(--theme-panel) 97%, transparent);
  backdrop-filter: blur(5px);
}
.replay-round-controls, .replay-playback-controls, .replay-status-controls { display: flex; align-items: center; gap: 8px; min-width: 0; }
.replay-status-controls { justify-content: flex-end; }
.replay-playback-controls { gap: 12px; }
.replay-wall {
  padding: 4px;
  color: var(--theme-text-muted);
  font-size: 12px;
  letter-spacing: .06em;
}
.replay-step,
.replay-play {
  flex: none;
  min-width: 44px;
  height: 44px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: var(--theme-button);
  color: var(--theme-button-text);
  font-size: 14px;
}
.replay-step svg, .replay-play svg { display: block; width: 20px; height: 20px; margin: auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.replay-play svg { fill: currentColor; stroke-width: 1; }
.replay-step:disabled { opacity: .38; }
.replay-play { min-width: 52px; border-color: var(--theme-accent); color: var(--theme-panel); background: var(--theme-accent); }
.replay-play.playing { border-color: var(--theme-accent); }
.replay-turn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 58px;
  justify-content: center;
  color: var(--theme-accent-text);
}
.replay-turn b { font-size: 15px; letter-spacing: .08em; }
.replay-turn i { color: var(--theme-text-muted); font-size: 11px; font-style: normal; }
.replay-round select,
.replay-speed select {
  height: 44px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: var(--theme-button);
  color: var(--theme-button-text);
  font: inherit;
  font-size: 13px;
  /* 全局声明的是 color-scheme: only light，原生下拉弹层会变成白底；
     这里显式给深色方案 + 选项配色，否则浅色选项文字在白底上看不清。 */
  color-scheme: dark;
  max-width: 100%;
}
.replay-round { min-width: 0; }
.replay-round select { max-width: 142px; width: 100%; }
.replay-round select option,
.replay-speed select option {
  background-color: var(--theme-panel, #0a231a);
  color: var(--theme-text, #f8f3df);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@media (max-width: 1000px), (max-height: 600px) {
  .replay-timeline { gap: 8px; padding-inline: calc(12px + var(--safe-left)) calc(12px + var(--safe-right)); }
  .replay-wall { display: none; }
  .replay-round select { max-width: 112px; }
  .replay-round-controls, .replay-status-controls { gap: 5px; }
}
@media (max-width: 600px) {
  .replay-timeline { grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: 44px 44px; gap: 8px; padding-block: 8px calc(8px + var(--safe-bottom)); }
  .replay-round-controls { grid-column: 1; grid-row: 1; }
  .replay-status-controls { grid-column: 2; grid-row: 1; }
  .replay-playback-controls { grid-column: 1 / -1; grid-row: 2; justify-content: center; gap: 24px; }
  .replay-turn { min-width: 44px; }
  .replay-speed select { padding-inline: 4px; }
}
</style>
