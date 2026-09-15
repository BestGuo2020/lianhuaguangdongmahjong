<script setup lang="ts">
// 牌谱侧栏：逐条事件（摸/打/碰/杠/胡），点击跳步。回放控制条不含进度条，跳转主要靠这里与键盘。
import { computed, ref, watch } from 'vue'
import MahjongTile from '../MahjongTile.vue'
import { stepSummary, formatTurn } from '../../game/replay/format'
import type { ReplayFrame } from '../../game/replay/projection'
import type { TableThemeName } from '../../theme/themeIdentity'
import type { TileType } from '../../game/core/contracts/types'

const props = defineProps<{
  frames: ReplayFrame[]
  frameIndex: number
  names: string[]
  themeName: TableThemeName
  jokerTiles: TileType[]
  wildcardTiles: TileType[]
}>()

const emit = defineEmits<{ jump: [index: number] }>()

const open = ref(true)

const rows = computed(() => props.frames
  .filter((frame) => frame.step)
  .map((frame) => ({
    index: frame.index,
    turn: frame.turn,
    seat: frame.step!.seat,
    name: props.names[frame.step!.seat] ?? `座位${frame.step!.seat + 1}`,
    label: stepSummary(frame.step!),
    tile: frame.step!.tile,
    local: frame.actorIsLocal,
    settled: false,
  })))

const listElement = ref<HTMLElement | null>(null)

// 当前帧对应的行滚入视野（播放时列表跟着走）。
watch(() => props.frameIndex, (index) => {
  const element = listElement.value?.querySelector<HTMLElement>(`[data-frame="${index}"]`)
  element?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <aside class="replay-log" :class="{ collapsed: !open }" aria-label="牌谱">
    <button type="button" class="replay-log-toggle" :aria-expanded="open" @click="open = !open">
      牌谱<span aria-hidden="true">{{ open ? '‹' : '›' }}</span>
    </button>
    <div v-show="open" class="replay-log-body">
      <button
        type="button" class="replay-log-start" :class="{ active: frameIndex === 0 }"
        @click="emit('jump', 0)"
      >开局 · 起手牌</button>
      <ol ref="listElement" class="replay-log-list">
        <li v-for="row in rows" :key="row.index">
          <button
            type="button"
            :data-frame="row.index"
            :class="{ active: row.index === frameIndex, local: row.local }"
            @click="emit('jump', row.index)"
          >
            <i>{{ formatTurn(row.turn) }}</i>
            <b>{{ row.name }}</b>
            <span>{{ row.label }}</span>
            <MahjongTile
              v-if="row.tile" :tile="row.tile" :theme-name="themeName" small disabled
              :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles"
            />
          </button>
        </li>
      </ol>
    </div>
  </aside>
</template>

<style scoped>
.replay-log {
  position: absolute;
  top: calc(var(--safe-top) + 52px);
  bottom: calc(64px + var(--safe-bottom));
  left: 10px;
  z-index: 5;
  display: flex;
  gap: 4px;
  width: 236px;
  pointer-events: none;
}
.replay-log > * { pointer-events: auto; }
.replay-log-toggle {
  align-self: flex-start;
  padding: 6px 7px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--theme-panel) 86%, transparent);
  color: var(--theme-accent);
  font-size: 12px;
  letter-spacing: .1em;
  writing-mode: vertical-rl;
}
.replay-log-toggle span { margin-top: 4px; }
.replay-log-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--theme-border) 40%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--theme-panel) 80%, transparent);
  backdrop-filter: blur(3px);
}
.replay-log-start {
  margin: 6px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 32%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--theme-panel-elevated) 70%, transparent);
  color: var(--theme-text-muted);
  font-size: 12px;
}
.replay-log-start.active { border-color: var(--theme-accent); color: var(--theme-accent); }
.replay-log-list {
  flex: 1;
  margin: 0;
  padding: 0 6px 8px;
  overflow: hidden auto;
  list-style: none;
  scrollbar-width: thin;
}
.replay-log-list button {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto 26px;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 3px 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--theme-text);
  font-size: 12px;
  text-align: left;
}
.replay-log-list button:hover { background: color-mix(in srgb, var(--theme-panel-elevated) 76%, transparent); }
.replay-log-list button.active { border-color: var(--theme-accent); background: color-mix(in srgb, var(--theme-accent) 16%, transparent); }
.replay-log-list i { color: var(--theme-text-muted); font-size: 10px; font-style: normal; }
.replay-log-list b { overflow: hidden; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.replay-log-list button.local b { color: var(--theme-accent); }
.replay-log-list span { color: var(--theme-text-muted); white-space: nowrap; }
.replay-log-list :deep(.mahjong-tile) { --tile-width: 22px; }
.replay-log.collapsed { width: 30px; }
@media (max-width: 900px) {
  .replay-log { width: 200px; }
}
</style>
