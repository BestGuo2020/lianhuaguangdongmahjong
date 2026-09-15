<script setup lang="ts">
// 回放视图：直接渲染 3D 牌桌（只读），叠加只读信息盘 / 牌谱 / 本家手牌架 / 控制条。
// 主题固定使用记录时的主题，不提供任何主题切换入口。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MahjongTable3D from '../MahjongTable3D.vue'
import MahjongTile from '../MahjongTile.vue'
import ReplayEventLog from './ReplayEventLog.vue'
import ReplayInfoBoard from './ReplayInfoBoard.vue'
import ReplayTimeline from './ReplayTimeline.vue'
import { useReplayPlayer } from '../../game/replay/useReplayPlayer'
import { formatDelta, formatRank } from '../../game/replay/format'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
import { displayImageSrc } from '../../game/core/presentation/imagePreload'
import { themePresentationByName, themePresentationCssVariables } from '../../theme/themePresentation'
import type { ReplayMatch, ReplayRound } from '../../game/replay/types'
import type { TileType } from '../../game/core/contracts/types'

const props = defineProps<{ match: ReplayMatch; rounds: ReplayRound[] }>()
const emit = defineEmits<{ close: [] }>()

const player = useReplayPlayer({
  match: () => props.match,
  rounds: () => props.rounds,
})

const tableReady = ref(false)
const themeStyle = computed(() => themePresentationCssVariables(themePresentationByName(props.match.themeName)))
const names = computed(() => props.match.players.map((entry) => entry.name))
const round = player.round
const frame = player.frame

/** 本家身份（头像/昵称）：与对局时一致的展示。 */
const humanName = computed(() => props.match.players[props.match.humanSeat]?.name ?? '本家')
const humanAvatar = ref(displayImageSrc(props.match.players[props.match.humanSeat]?.avatar ?? ''))
watch(() => props.match, () => {
  humanAvatar.value = displayImageSrc(props.match.players[props.match.humanSeat]?.avatar ?? '')
})
function onAvatarError() {
  humanAvatar.value = defaultAvatarForSeat(props.match.humanSeat)
}

/** 全知视角下本家手牌可能含胡牌张：结算帧高亮它。 */
const winTileIndex = computed(() => {
  const current = frame.value
  if (!current?.settled || current.winnerIndex !== 0) return -1
  const tile = current.table.winPresentation?.tile
  return tile ? current.hand.lastIndexOf(tile) : -1
})

const resultBanner = computed(() => {
  const current = frame.value
  const activeRound = round.value
  if (!current?.settled || !activeRound?.final) return ''
  const final = activeRound.final
  const head = `${activeRound.roundLabel} · `
  if (final.draw) return `${head}荒庄`
  // 血流一局可能多次胡牌，没有单一赢家：只报「本局结束」，各家胡牌次数由结算帧分数与牌谱体现。
  if (final.winSeat == null) return `${head}本局结束`
  const winner = props.match.players[final.winSeat]?.name ?? ''
  const kind = final.winType === 'discard' ? '点炮'
    : final.winType === 'robbed-kong' ? '抢杠'
      : final.winType === 'tianhu' ? '天胡'
        : final.winType === 'dihu' ? '地胡' : '自摸'
  const points = final.points ? ` · ${formatDelta(final.points * 3)}分` : ''
  return `${head}${winner} ${kind}${points}`
})

function jokerTileList(): TileType[] {
  return round.value?.jokerTiles ?? []
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
  switch (event.key) {
    case 'Escape': emit('close'); break
    case 'ArrowRight': event.preventDefault(); event.shiftKey ? player.stepBy(5) : player.next(); break
    case 'ArrowLeft': event.preventDefault(); event.shiftKey ? player.stepBy(-5) : player.prev(); break
    case ' ': event.preventDefault(); player.toggle(); break
    case 'Home': player.first(); break
    case 'End': player.last(); break
    case '[': player.selectRound(player.roundIndex.value - 1); break
    case ']': player.selectRound(player.roundIndex.value + 1); break
    default: break
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="game-app replay-viewer"
    :data-table-theme="match.themeName"
    :style="themeStyle"
    data-testid="replay-viewer"
  >
    <MahjongTable3D
      v-if="frame"
      :key="`${match.id}:${match.themeName}`"
      v-bind="frame.table"
      @ready="tableReady = true"
    />

    <Transition name="table-loading">
      <div v-if="!tableReady" class="table-loading" role="status" aria-live="polite">
        <div class="table-loading-card">
          <span class="table-loading-spinner" aria-hidden="true"></span>
          <span>回放牌桌加载中…</span>
        </div>
      </div>
    </Transition>

    <header class="replay-topbar">
      <button type="button" class="replay-back" data-action-role="secondary" @click="emit('close')">
        ← 返回大厅
      </button>
      <div class="replay-title">
        <strong>{{ match.rulesetName }}</strong>
        <span>{{ match.matchName }} · {{ round?.roundLabel ?? '' }}</span>
        <i v-if="match.status === 'finished'" class="replay-rank" :class="`rank-${match.myRank}`">
          {{ formatRank(match.myRank) }}
        </i>
        <i v-else class="replay-rank aborted">未完成</i>
      </div>
      <div class="replay-view-mode">
        <span class="replay-theme-name" :title="`对局使用主题：${match.themeName}`">主题 {{ match.themeName }}</span>
        <button
          type="button" class="replay-view-toggle" data-action-role="secondary"
          :aria-pressed="!player.revealAll.value"
          :title="player.revealAll.value ? '切换为按当时所见（他家暗牌）' : '切换为全知视角（四家明牌）'"
          @click="player.revealAll.value = !player.revealAll.value"
        >{{ player.revealAll.value ? '全知视角' : '按当时所见' }}</button>
      </div>
    </header>

    <ReplayInfoBoard :match="match" :round="round" :frame="frame" />

    <ReplayEventLog
      :frames="player.frames.value"
      :frame-index="player.frameIndex.value"
      :names="names"
      :theme-name="match.themeName"
      :joker-tiles="jokerTileList()"
      :wildcard-tiles="round?.wildcardTiles ?? []"
      @jump="player.seek"
    />

    <Transition name="announce">
      <p v-if="resultBanner" class="replay-result" data-testid="replay-result">{{ resultBanner }}</p>
    </Transition>

    <section v-if="frame" class="replay-user">
      <div class="user-identity" :class="{ active: frame.currentPlayer === 0 }">
        <span v-if="round && frame.table.dealerIndex === 0" class="dealer-badge">庄</span>
        <img class="avatar" :src="humanAvatar" :alt="`${humanName}头像`" @error="onAvatarError" />
        <div class="player-info">
          <strong>{{ humanName }}</strong>
          <span>{{ frame.scores[match.humanSeat] ?? 0 }}</span>
        </div>
      </div>
      <div class="hand-rack replay-hand-rack">
        <div
          v-for="(tile, index) in frame.hand" :key="`${tile}-${index}`"
          class="hand-tile-slot" :class="{ drawn: frame.drawnTileIndex === index, 'win-tile': winTileIndex === index }"
        >
          <MahjongTile
            :tile="tile" :theme-name="match.themeName" disabled
            :joker-tiles="jokerTileList()" :wildcard-tiles="round?.wildcardTiles ?? []"
          />
        </div>
      </div>
    </section>

    <ReplayTimeline
      :rounds="rounds"
      :round-index="player.roundIndex.value"
      :frame-index="player.frameIndex.value"
      :frame-count="player.frames.value.length"
      :frame="frame"
      :playing="player.playing.value"
      v-model:speed="player.speed.value"
      @round="player.selectRound"
      @first="player.first"
      @prev="player.prev"
      @next="player.next"
      @last="player.last"
      @toggle="player.toggle"
    />
  </div>
</template>

<style scoped>
.replay-viewer { z-index: 200; }
.replay-topbar {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: calc(44px + var(--safe-top));
  padding: var(--safe-top) calc(12px + var(--safe-right)) 0 calc(12px + var(--safe-left));
  background: var(--theme-top-bar);
}
.replay-back {
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: var(--theme-button);
  color: var(--theme-text);
  font-size: 13px;
}
.replay-title { display: flex; align-items: center; gap: 8px; color: var(--theme-text-muted); font-size: 13px; }
.replay-title strong { color: var(--theme-accent); font-size: 15px; letter-spacing: .08em; }
.replay-rank {
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 40%, transparent);
  border-radius: 10px;
  color: var(--theme-text-muted);
  font-size: 11px;
  font-style: normal;
}
.replay-rank.rank-1 { border-color: var(--theme-accent); color: var(--theme-accent); }
.replay-rank.aborted { opacity: .7; }
.replay-view-mode { display: flex; align-items: center; gap: 8px; }
.replay-theme-name { color: var(--theme-text-muted); font-size: 12px; }
.replay-view-toggle {
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: var(--theme-button);
  color: var(--theme-text);
  font-size: 12px;
}
.replay-user {
  position: absolute;
  inset: 0;
  z-index: 4;
  /* 只读叠层：不得拦截控制条与牌谱的点击。 */
  pointer-events: none;
}
.replay-user .user-identity {
  /* 牌谱面板占据左侧，本家身份牌让到面板右侧、手牌架上方（与实时牌桌同位但避让只读面板）。 */
  left: calc(256px + var(--safe-left));
  bottom: calc(176px + var(--safe-bottom));
}
.replay-hand-rack { bottom: calc(58px + var(--safe-bottom)); }
.replay-hand-rack .hand-tile-slot.win-tile :deep(.mahjong-tile) {
  filter: drop-shadow(0 0 8px var(--theme-accent));
}
.replay-result {
  position: absolute;
  top: calc(var(--safe-top) + 150px);
  left: 50%;
  z-index: 5;
  margin: 0;
  padding: 6px 16px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 50%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--theme-panel) 84%, transparent);
  color: var(--theme-accent);
  font-size: 14px;
  letter-spacing: .08em;
  transform: translateX(-50%);
  pointer-events: none;
}
@media (max-width: 900px) {
  .replay-theme-name { display: none; }
}
</style>
