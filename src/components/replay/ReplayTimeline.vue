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
    <span class="replay-wall" data-testid="replay-wall-left">牌山 余 {{ frame?.wallLeft ?? 0 }}</span>

    <button
      type="button" class="replay-step" :disabled="roundIndex <= 0"
      aria-label="上一局" title="上一局" @click="shiftRound(-1)"
    >⏮</button>

    <label class="replay-round">
      <span class="sr-only">切换牌局</span>
      <select :value="roundIndex" @change="emit('round', Number(($event.target as HTMLSelectElement).value))">
        <option v-for="(round, index) in rounds" :key="round.id" :value="index">{{ round.roundLabel }}</option>
      </select>
    </label>

    <button type="button" class="replay-step" aria-label="上一步" title="上一步" @click="emit('prev')">◀</button>
    <span class="replay-turn" data-testid="replay-turn">
      <b>{{ formatTurn(frame?.turn ?? 1) }}</b>
      <i>{{ position }}</i>
    </span>
    <button type="button" class="replay-step" aria-label="下一步" title="下一步" @click="emit('next')">▶</button>

    <button
      type="button" class="replay-step" :disabled="roundIndex >= rounds.length - 1"
      aria-label="下一局" title="下一局" @click="shiftRound(1)"
    >⏭</button>

    <button
      type="button" class="replay-play" :class="{ playing }"
      :aria-label="playing ? '暂停' : '播放'" :title="playing ? '暂停' : '播放'"
      @click="emit('toggle')"
    >{{ playing ? '⏸' : '⏵' }}</button>

    <label class="replay-speed">
      <span class="sr-only">播放速度</span>
      <select v-model="speed">
        <option v-for="value in REPLAY_SPEEDS" :key="value" :value="value">{{ value }}x</option>
      </select>
    </label>
  </section>
</template>

<style scoped>
.replay-timeline {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: calc(56px + var(--safe-bottom));
  padding: 0 12px var(--safe-bottom);
  border-top: 1px solid color-mix(in srgb, var(--theme-border) 42%, transparent);
  background: color-mix(in srgb, var(--theme-panel) 88%, transparent);
  backdrop-filter: blur(5px);
}
.replay-wall {
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 35%, transparent);
  border-radius: 20px;
  color: var(--theme-text-muted);
  font-size: 12px;
  letter-spacing: .06em;
}
.replay-step,
.replay-play {
  min-width: 40px;
  height: 36px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: var(--theme-button);
  color: var(--theme-text);
  font-size: 14px;
}
.replay-step:disabled { opacity: .38; }
.replay-play { min-width: 52px; color: var(--theme-accent); }
.replay-play.playing { border-color: var(--theme-accent); }
.replay-turn {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 96px;
  justify-content: center;
  color: var(--theme-accent);
}
.replay-turn b { font-size: 15px; letter-spacing: .08em; }
.replay-turn i { color: var(--theme-text-muted); font-size: 11px; font-style: normal; }
.replay-round select,
.replay-speed select {
  height: 36px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: var(--theme-button);
  color: var(--theme-text);
  font: inherit;
  font-size: 13px;
  /* 全局声明的是 color-scheme: only light，原生下拉弹层会变成白底；
     这里显式给深色方案 + 选项配色，否则浅色选项文字在白底上看不清。 */
  color-scheme: dark;
}
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
@media (max-width: 720px) {
  .replay-timeline { gap: 5px; }
  .replay-wall { display: none; }
}
</style>
