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
import { formatDelta, formatRank, replayWinLabel } from '../../game/replay/format'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
import { displayImageSrc } from '../../game/core/presentation/imagePreload'
import { themePresentationByName, themePresentationCssVariables } from '../../theme/themePresentation'
import type { ReplayMatch, ReplayRound } from '../../game/replay/types'
import type { TileType } from '../../game/core/contracts/types'

const props = defineProps<{ match: ReplayMatch; rounds: ReplayRound[]; backLabel?: string }>()
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
const infoExpanded = ref(false)
const compactQuery = typeof window === 'undefined' ? null : window.matchMedia('(max-width: 1000px), (max-height: 600px)')
const compact = ref(compactQuery?.matches ?? false)
const logOpen = ref(!compact.value)
const viewNotice = ref('')
const perspective = computed(() => frame.value?.settled ? 'settled'
  : player.revealAll.value ? 'omniscient' : 'self')
const perspectiveLabel = computed(() => ({ settled: '终局亮牌', omniscient: '全知视角', self: '按当时所见' })[perspective.value])
function togglePerspective() {
  if (perspective.value === 'settled') {
    viewNotice.value = '终局时四家已经亮牌。返回行牌步骤后，可切换该步骤支持的视角。'
  } else {
    player.revealAll.value = !player.revealAll.value
    viewNotice.value = ''
  }
}
function updateCompact() {
  compact.value = compactQuery?.matches ?? false
  logOpen.value = !compact.value
  infoExpanded.value = false
}
watch(logOpen, open => { if (open && compact.value) { infoExpanded.value = false; viewNotice.value = ''; player.pause() } })
watch(infoExpanded, open => { if (open && compact.value) { logOpen.value = false; viewNotice.value = ''; player.pause() } })
watch([player.frameIndex, player.roundIndex], () => { viewNotice.value = '' })

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
  const kind = replayWinLabel(final.winType)
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
    case 'Escape':
      if (viewNotice.value) viewNotice.value = ''
      else if (infoExpanded.value) infoExpanded.value = false
      else if (logOpen.value && compact.value) logOpen.value = false
      else emit('close')
      break
    case 'ArrowRight':
      event.preventDefault()
      if (event.shiftKey) player.jumpAction(1)
      else player.next()
      break
    case 'ArrowLeft':
      event.preventDefault()
      if (event.shiftKey) player.jumpAction(-1)
      else player.prev()
      break
    case ' ': event.preventDefault(); player.toggle(); break
    case 'Home': player.first(); break
    case 'End': player.last(); break
    case '[': player.selectRound(player.roundIndex.value - 1); break
    case ']': player.selectRound(player.roundIndex.value + 1); break
    default: break
  }
}

onMounted(() => { window.addEventListener('keydown', onKeydown); compactQuery?.addEventListener('change', updateCompact) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown); compactQuery?.removeEventListener('change', updateCompact) })
</script>

<template>
  <div
    class="game-app replay-viewer"
    :class="{ 'log-open': logOpen, compact }"
    :data-replay-perspective="perspective"
    :data-table-theme="match.themeName"
    :style="themeStyle"
    data-testid="replay-viewer"
  >
    <div class="replay-table">
    <MahjongTable3D
      v-if="frame"
      :key="`${match.id}:${match.themeName}`"
      v-bind="frame.table"
      @ready="tableReady = true"
    />
    </div>

    <Transition name="table-loading">
      <div v-if="!tableReady" class="table-loading" role="status" aria-live="polite">
        <div class="table-loading-card">
          <span class="table-loading-spinner" aria-hidden="true"></span>
          <span>回放牌桌加载中…</span>
        </div>
      </div>
    </Transition>

    <header class="replay-topbar">
      <button type="button" class="replay-back" data-action-role="secondary" :aria-label="backLabel ?? '← 返回大厅'" @click="emit('close')">
        <span class="replay-back-full">{{ backLabel ?? '← 返回大厅' }}</span>
        <svg class="replay-back-short" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-6.5 6.5 6.5 6.5" /></svg>
      </button>
      <div class="replay-title">
        <strong><span class="replay-game-name">{{ match.rulesetName }} · </span>{{ round?.roundLabel ?? '对局' }}<span class="replay-title-suffix">回放</span></strong>
        <span class="replay-subtitle">{{ match.matchName }}<span class="replay-title-rank"> · {{ match.status === 'finished' ? formatRank(match.myRank) : '未完成' }}</span></span>
      </div>
      <div class="replay-view-mode">
        <ReplayEventLog v-model:open="logOpen" :compact="compact"
          :frames="player.frames.value" :frame-index="player.frameIndex.value" :names="names"
          :theme-name="match.themeName" :joker-tiles="jokerTileList()" :wildcard-tiles="round?.wildcardTiles ?? []"
          :reveal-all="player.revealAll.value"
          @jump="player.seek" @action="player.jumpAction" />
        <ReplayInfoBoard v-model:expanded="infoExpanded" :match="match" :round="round" :frame="frame" :result-label="resultBanner" />
        <button
          v-if="!compact || !frame?.settled"
          type="button" class="replay-view-toggle" data-action-role="secondary" data-testid="replay-perspective"
          :aria-pressed="perspective === 'self' || perspective === 'omniscient' ? !player.revealAll.value : undefined"
          :title="perspective === 'settled' ? '查看视角说明' : player.revealAll.value ? '切换为按当时所见（他家暗牌）' : '切换为全知视角（四家明牌）'"
          @click="togglePerspective"
        >{{ perspectiveLabel }}</button>
      </div>
    </header>
    <div v-if="viewNotice" class="replay-perspective-note" role="status">
      <button class="replay-note-close" aria-label="关闭视角说明" @click="viewNotice = ''">×</button>
      <p>{{ viewNotice }}</p>
    </div>

    <Transition name="announce">
      <p v-if="resultBanner && !infoExpanded" class="replay-result" data-testid="replay-result">{{ resultBanner }}</p>
    </Transition>

    <section v-if="frame" class="replay-user">
      <div class="user-identity" :class="{ active: frame.currentPlayer === 0 }">
        <span v-if="round && frame.table.dealerIndex === 0" class="dealer-badge">庄</span>
        <img class="avatar" :src="humanAvatar" :alt="`${humanName}头像`" @error="onAvatarError" />
        <div class="player-info">
          <small>本家手牌</small>
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
.replay-viewer {
  z-index: 200;
  --replay-log-width: 272px;
  --replay-header-height: calc(64px + var(--safe-top));
  --replay-controls-height: calc(64px + var(--safe-bottom));
  --replay-hand-height: 94px;
  --replay-side-space: 0px;
}
.replay-viewer.log-open:not(.compact) { --replay-side-space: calc(var(--replay-log-width) + 28px); }
.replay-table { position: absolute; top: var(--replay-header-height); right: 0; bottom: calc(var(--replay-controls-height) + 12px); left: var(--replay-side-space); }
.replay-topbar {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: var(--replay-header-height);
  padding: calc(6px + var(--safe-top)) calc(16px + var(--safe-right)) 6px calc(16px + var(--safe-left));
  border-bottom: 1px solid color-mix(in srgb, var(--theme-border) 24%, transparent);
  background: color-mix(in srgb, var(--theme-panel) 95%, transparent);
}
.replay-back {
  flex: none;
  min-height: 40px;
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: var(--theme-button);
  color: var(--theme-button-text);
  font-size: 13px;
}
.replay-back-short { display: none; width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.replay-title { display: grid; flex: 1; min-width: 0; gap: 4px; color: var(--theme-text-muted); font-size: 12px; }
.replay-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--theme-accent-text); font-size: 16px; }
.replay-title-suffix { margin-left: 8px; font-weight: 400; font-size: 12px; color: var(--theme-text-muted); }
.replay-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.replay-view-mode { display: flex; flex: none; align-items: center; gap: 8px; }
.replay-view-toggle {
  min-height: 40px;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 45%, transparent);
  border-radius: 8px;
  background: var(--theme-button);
  color: var(--theme-button-text);
  font-size: 12px;
  white-space: nowrap;
}
.replay-perspective-note { position: absolute; z-index: 12; top: calc(var(--replay-header-height) + 8px); right: calc(12px + var(--safe-right)); width: min(320px, calc(100% - 24px)); padding: 14px; border: 1px solid var(--theme-border); border-radius: 12px; background: var(--theme-panel); box-shadow: 0 8px 30px #0007; font-size: 13px; line-height: 1.7; }
.replay-perspective-note p { margin: 0 28px 10px 0; }
.replay-note-close { position: absolute; right: 4px; top: 4px; width: 36px; height: 36px; padding: 0; border: 0; background: none; color: var(--theme-text-muted); font-size: 24px; }
.replay-user {
  position: absolute;
  bottom: var(--replay-controls-height);
  left: var(--replay-side-space);
  right: 0;
  height: var(--replay-hand-height);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px calc(16px + var(--safe-right)) 8px calc(16px + var(--safe-left));
  z-index: 4;
  pointer-events: none;
  background: linear-gradient(0deg, color-mix(in srgb, var(--theme-panel) 90%, transparent), transparent);
}
.replay-viewer .replay-user .user-identity {
  position: relative;
  inset: auto;
  flex: 0 0 132px;
  min-width: 0;
  width: auto;
  flex-direction: row;
  align-items: center;
  text-align: left;
  transform: none;
  animation: none;
  padding: 6px;
  gap: 7px;
  border: 0;
  border-radius: 8px;
  box-shadow: none;
  background: transparent;
}
.replay-viewer .replay-user .avatar { width: 36px; height: 36px; flex: none; border-radius: 8px; }
.replay-viewer .replay-user .user-identity::after { display: none; }
.replay-viewer .replay-user .player-info { min-width: 0; }
.replay-viewer .replay-user .player-info small { font-size: 10px; color: var(--theme-text-muted); }
.replay-viewer .replay-user .player-info strong { overflow: hidden; max-width: 84px; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.replay-viewer .replay-user .player-info span { font-size: 13px; }
.replay-viewer .replay-user .dealer-badge { position: absolute; top: -2px; left: -3px; width: 18px; height: 18px; font-size: 11px; }
.replay-hand-rack { position: relative; inset: auto; flex: 1; min-width: 0; min-height: 0; padding: 2px 0 8px; gap: 2px; border-radius: 0; container-type: inline-size; }
.replay-hand-rack::after { display: none; }
.replay-viewer .replay-hand-rack .hand-tile-slot { flex: none; width: auto; min-width: 0; }
.replay-viewer .replay-hand-rack :deep(.mahjong-tile) { --tile-width: min(calc((100cqw - 48px) / 14), calc(var(--replay-hand-height) * .58), 56px); }
.replay-viewer .replay-hand-rack .hand-tile-slot.drawn { margin-left: 8px; }
.replay-hand-rack .hand-tile-slot.win-tile :deep(.mahjong-tile) {
  filter: drop-shadow(0 0 8px var(--theme-accent));
}
.replay-result {
  position: absolute;
  top: calc(var(--replay-header-height) + 12px);
  left: 50%;
  z-index: 5;
  margin: 0;
  padding: 6px 16px;
  border: 1px solid color-mix(in srgb, var(--theme-border) 50%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--theme-panel) 84%, transparent);
  color: var(--theme-accent-text);
  max-width: calc(100% - 24px);
  font-size: 13px;
  letter-spacing: .08em;
  transform: translateX(-50%);
  pointer-events: none;
}
@media (max-width: 1000px), (max-height: 600px) {
  .replay-viewer { --replay-header-height: calc(52px + var(--safe-top)); --replay-controls-height: calc(56px + var(--safe-bottom)); --replay-hand-height: 70px; }
  .replay-topbar { gap: 10px; padding-inline: calc(12px + var(--safe-left)) calc(12px + var(--safe-right)); }
  .replay-back { display: grid; place-items: center; width: 40px; min-height: 40px; padding: 0; }
  .replay-back-full, .replay-game-name { display: none; }
  .replay-back-short { display: block; }
  .replay-title strong { font-size: 15px; }
  .replay-subtitle { font-size: 11px; }
  .replay-view-mode { gap: 6px; }
  .replay-user { gap: 8px; padding-inline: calc(12px + var(--safe-left)) calc(12px + var(--safe-right)); }
  .replay-viewer .replay-user .user-identity { flex-basis: 112px; }
  .replay-viewer .replay-user .avatar { width: 28px; height: 28px; }
  .replay-viewer .replay-user .player-info strong { max-width: 70px; font-size: 12px; }
}
@media (max-width: 600px) {
  .replay-viewer { --replay-header-height: calc(64px + var(--safe-top)); --replay-controls-height: calc(112px + var(--safe-bottom)); --replay-hand-height: 96px; }
  .replay-title-rank, .replay-title-suffix { display: none; }
  .replay-view-mode { gap: 4px; }
  .replay-view-toggle { padding-inline: 8px; font-size: 11px; }
  .replay-user { display: grid; grid-template-rows: 28px 1fr; gap: 4px; padding-top: 0; }
  .replay-viewer .replay-user .user-identity { justify-self: start; padding: 0; }
  .replay-viewer .replay-user .player-info { flex-direction: row; align-items: center; gap: 8px; }
  .replay-viewer .replay-user .player-info strong { max-width: 160px; }
  .replay-viewer .replay-user .player-info small { display: none; }
  .replay-hand-rack { width: 100%; }
  .replay-table { bottom: calc(var(--replay-controls-height) + var(--replay-hand-height)); }
  .replay-viewer .replay-hand-rack :deep(.mahjong-tile) { --tile-width: min(calc((100cqw - 44px) / 14), 38px); }
}
</style>
