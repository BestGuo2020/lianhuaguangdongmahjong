<script setup lang="ts">
// 牌谱侧栏：逐条事件（摸/打/碰/杠/胡），点击跳步，并提供「上一鸣牌 / 下一鸣牌」锚点跳转。
// 回放控制条不含进度条，跳转主要靠这里与键盘（Shift+←/→）。
import { computed, ref, watch } from 'vue'
import MahjongTile from '../MahjongTile.vue'
import { meldLabel, formatTurn, stepSummary } from '../../game/replay/format'
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

const emit = defineEmits<{
  jump: [index: number]
  /** 跳鸣牌/和牌节点：-1 上一个，1 下一个。 */
  action: [direction: 1 | -1]
}>()

const open = ref(true)

/** 每行 = 一个事件帧；巡目变化处插入分隔。鸣牌/和牌为「重事件」，单独分层。 */
const rows = computed(() => props.frames
  .filter((frame) => frame.step)
  .map((frame, index, list) => {
    const step = frame.step!
    const heavy = step.t === 'meld' || step.t === 'win'
    return {
      index: frame.index,
      turn: frame.turn,
      showTurn: index === 0 || list[index - 1].turn !== frame.turn,
      seat: step.seat,
      name: props.names[step.seat] ?? `座位${step.seat + 1}`,
      label: stepSummary(step),
      badge: step.t === 'win' ? '胡' : step.t === 'meld' ? meldLabel(step.kind) : '',
      tile: step.t === 'draw' || step.t === 'discard' || heavy ? step.tile : undefined,
      kind: step.t,
      heavy,
      local: frame.actorIsLocal,
    }
  }))

const heavyCount = computed(() => rows.value.filter((row) => row.heavy).length)
const hasHeavy = computed(() => heavyCount.value > 0)

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
      <div class="replay-log-nav">
        <button
          type="button" data-testid="replay-prev-action" :disabled="!hasHeavy"
          title="上一个鸣牌 / 和牌（Shift + ←）" aria-label="上一个鸣牌或和牌"
          @click="emit('action', -1)"
        >⏴ 鸣牌</button>
        <button
          type="button" data-testid="replay-next-action" :disabled="!hasHeavy"
          title="下一个鸣牌 / 和牌（Shift + →）" aria-label="下一个鸣牌或和牌"
          @click="emit('action', 1)"
        >鸣牌 ⏵</button>
      </div>
      <button
        type="button" class="replay-log-start" :class="{ active: frameIndex === 0 }"
        @click="emit('jump', 0)"
      >开局 · 起手牌</button>
      <ol ref="listElement" class="replay-log-list">
        <template v-for="row in rows" :key="row.index">
          <li v-if="row.showTurn" class="replay-log-turn" aria-hidden="true">{{ formatTurn(row.turn) }}</li>
          <li>
            <button
              type="button"
              :data-frame="row.index"
              :data-kind="row.kind"
              :class="[`kind-${row.kind}`, { active: row.index === frameIndex, local: row.local, heavy: row.heavy }]"
              @click="emit('jump', row.index)"
            >
              <i>{{ formatTurn(row.turn) }}</i>
              <b>{{ row.name }}</b>
              <span>
                <em v-if="row.badge" class="replay-log-badge">{{ row.badge }}</em>
                {{ row.label }}
              </span>
              <MahjongTile
                v-if="row.tile" :tile="row.tile" :theme-name="themeName" small disabled
                :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles"
              />
            </button>
          </li>
        </template>
      </ol>
    </div>
  </aside>
</template>

<style scoped>
.replay-log {
  position: absolute;
  top: calc(var(--safe-top) + 52px);
  bottom: calc(64px + var(--safe-bottom));
  left: var(--replay-log-left, 10px);
  z-index: 5;
  display: flex;
  gap: 4px;
  width: var(--replay-log-width, 252px);
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
.replay-log-nav { display: flex; gap: 6px; padding: 6px 6px 0; }
.replay-log-nav button {
  flex: 1;
  padding: 4px 0;
  border: 1px solid color-mix(in srgb, var(--theme-border) 40%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--theme-panel-elevated) 72%, transparent);
  color: var(--theme-accent);
  font-size: 12px;
}
.replay-log-nav button:disabled { opacity: .38; color: var(--theme-text-muted); }
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
.replay-log-turn {
  padding: 5px 0 2px 4px;
  color: var(--theme-text-muted);
  font-size: 10px;
  letter-spacing: .18em;
  opacity: .75;
}
.replay-log-list button {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto 26px;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 3px 4px;
  border: 1px solid transparent;
  border-left: 3px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--theme-text);
  font-size: 12px;
  text-align: left;
}
.replay-log-list button:hover { background: color-mix(in srgb, var(--theme-panel-elevated) 76%, transparent); }
.replay-log-list button.active { border-color: var(--theme-accent); background: color-mix(in srgb, var(--theme-accent) 16%, transparent); }
/* 鸣牌/和牌分层：重事件左侧描边 + 加重字色，和牌最亮 */
.replay-log-list button.kind-meld { border-left-color: var(--theme-accent-secondary); }
.replay-log-list button.kind-win {
  border-left-color: var(--theme-accent);
  background: color-mix(in srgb, var(--theme-accent) 12%, transparent);
}
.replay-log-list button.kind-draw { opacity: .78; }
.replay-log-list i { color: var(--theme-text-muted); font-size: 10px; font-style: normal; }
.replay-log-list b { overflow: hidden; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.replay-log-list button.local b { color: var(--theme-accent); }
.replay-log-list button.heavy b { font-weight: 700; }
.replay-log-list span { color: var(--theme-text-muted); white-space: nowrap; }
.replay-log-badge {
  margin-right: 3px;
  padding: 0 4px;
  border: 1px solid color-mix(in srgb, var(--theme-accent) 55%, transparent);
  border-radius: 4px;
  color: var(--theme-accent);
  font-size: 10px;
  font-style: normal;
}
.replay-log-list :deep(.mahjong-tile) { --tile-width: 22px; }
.replay-log.collapsed { width: 30px; }
</style>
