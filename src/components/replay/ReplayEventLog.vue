<script setup lang="ts">
// 牌谱侧栏：逐条事件（摸/打/碰/杠/胡），点击跳步，并提供「上一鸣牌 / 下一鸣牌」锚点跳转。
// 回放控制条不含进度条，跳转主要靠这里与键盘（Shift+←/→）。
import { computed, ref, watch, useId } from 'vue'
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
  revealAll?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  jump: [index: number]
  /** 跳鸣牌/和牌节点：-1 上一个，1 下一个。 */
  action: [direction: 1 | -1]
}>()

const open = defineModel<boolean>('open', { default: true })
const panelId = useId()
function jump(index: number) {
  emit('jump', index)
  if (props.compact) open.value = false
}

/** 每行 = 一个事件帧；巡目变化处插入分隔。鸣牌/和牌为「重事件」，单独分层。 */
const rows = computed(() => props.frames
  .filter((frame) => frame.step)
  .map((frame, index, list) => {
    const step = frame.step!
    const heavy = step.t === 'meld' || step.t === 'win'
    const concealedDraw = props.revealAll === false && step.t === 'draw' && !frame.actorIsLocal
    return {
      index: frame.index,
      turn: frame.turn,
      showTurn: index === 0 || list[index - 1].turn !== frame.turn,
      seat: step.seat,
      name: props.names[step.seat] ?? `座位${step.seat + 1}`,
      label: concealedDraw ? (step.fromTail ? '补牌（暗牌）' : '摸牌（暗牌）') : stepSummary(step),
      badge: step.t === 'win' ? '胡' : step.t === 'meld' ? meldLabel(step.kind) : '',
      tile: !concealedDraw && (step.t === 'draw' || step.t === 'discard' || heavy) ? step.tile : undefined,
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
    <button type="button" class="replay-log-toggle" :aria-expanded="open" :aria-controls="panelId" @click="open = !open">
      牌谱<span aria-hidden="true">{{ open ? '▴' : '▾' }}</span>
    </button>
    <button v-if="open && compact" class="replay-log-dismiss" aria-label="收起牌谱" tabindex="-1" @click="open = false" />
    <div v-show="open" :id="panelId" class="replay-log-body">
      <header class="replay-log-heading"><strong>牌谱记录</strong><button aria-label="关闭牌谱" @click="open = false">×</button></header>
      <div class="replay-log-nav">
        <button
          type="button" data-testid="replay-prev-action" :disabled="!hasHeavy"
          title="上一个鸣牌 / 和牌（Shift + ←）" aria-label="上一个鸣牌或和牌"
          @click="emit('action', -1)"
        >上个鸣牌</button>
        <button
          type="button" data-testid="replay-next-action" :disabled="!hasHeavy"
          title="下一个鸣牌 / 和牌（Shift + →）" aria-label="下一个鸣牌或和牌"
          @click="emit('action', 1)"
        >下个鸣牌</button>
      </div>
      <button
        type="button" class="replay-log-start" :class="{ active: frameIndex === 0 }"
        @click="jump(0)"
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
              @click="jump(row.index)"
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
  position: relative;
  flex: none;
}
.replay-log-toggle {
  min-height: 40px;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--theme-panel) 86%, transparent);
  color: var(--theme-accent);
  font-size: 12px;
  white-space: nowrap;
}
.replay-log-toggle span { margin-left: 5px; }
.replay-log-dismiss { position: fixed; inset: var(--replay-header-height, 60px) 0 var(--replay-controls-height, 64px); z-index: 1; border: 0; background: #0004; }
.replay-log-body {
  position: fixed;
  top: calc(var(--replay-header-height, 60px) + 8px);
  bottom: calc(var(--replay-controls-height, 64px) + 12px);
  left: calc(12px + var(--safe-left, 0px));
  width: min(var(--replay-log-width, 272px), calc(100vw - 24px));
  z-index: 2;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--theme-border) 40%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--theme-panel) 97%, transparent);
  box-shadow: 0 12px 36px #0006;
}
.replay-log-heading { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; font-size: 13px; color: var(--theme-text); }
.replay-log-heading button { width: 36px; height: 36px; border: 0; border-radius: 6px; background: transparent; color: var(--theme-text-muted); font-size: 24px; }
.replay-log-nav { display: flex; gap: 6px; padding: 6px 6px 0; }
.replay-log-nav button {
  flex: 1;
  min-height: 36px;
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
  grid-template-columns: 28px minmax(48px, 1fr) minmax(0, 1.5fr) 24px;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 3px 4px;
  min-height: 44px;
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
.replay-log-list span { overflow: hidden; text-overflow: ellipsis; color: var(--theme-text-muted); white-space: nowrap; }
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
@media (max-width: 600px) { .replay-log-toggle { min-height: 40px; padding-inline: 8px; } .replay-log-toggle span { display: none; } }
</style>
