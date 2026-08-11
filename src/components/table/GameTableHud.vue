<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import MahjongTile from '../MahjongTile.vue'
import PlayerSeat from '../PlayerSeat.vue'
import { splitWinningTile } from '../../game/core/winEffect'
import { defaultAvatarForSeat } from '../../game/core/avatar'
import type { ActionPrompt } from '../../game/core/playerController'
import type { Announcement, LastDiscard, RoundResult, WaitInfo } from '../../game/core/gamePort'
import type { GamePlayer, ScoreFlowEvent, TableActionEvent, TileType, WinPresentation } from '../../game/core/types'

const MahjongTable3D = defineAsyncComponent(() => import('../MahjongTable3D.vue'))

interface Props {
  players: GamePlayer[]
  user: GamePlayer
  phase: string
  wall: TileType[]
  wallHeadDrawn: number
  wallCount: number
  currentPlayer: number
  selectedIndex: number
  turnSeconds: number
  lastDiscard: LastDiscard | null
  actionPrompt: ActionPrompt | null
  announcement: Announcement | null
  tableActionEvent: TableActionEvent | null
  scoreFlowEvent: ScoreFlowEvent | null
  result: RoundResult | null
  winEffect: RoundResult | null
  winPresentation: WinPresentation | null
  revealHands: boolean
  winningPlayerIndex: number
  dealer: number
  isUserTurn: boolean
  userCanHu: boolean
  matchName: string
  roundLabel: string
  dealAnimation: { playerIndex: number; count: number; serial: number }
  openingStage: string | null
  diceValues: number[]
  userCurrentWaits: WaitInfo | null
  userTingOptions: WaitInfo[]
  userDiscardWaits: WaitInfo | null
  userKongs: TileType[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  selectTile: [index: number]
  clearSelection: []
  discard: [index: number]
  pass: []
  peng: []
  gangFromDiscard: []
  gang: [tile: TileType]
  hu: []
}>()

const imageBase = `${import.meta.env.BASE_URL}img/`
const seatPosition = ['bottom', 'right', 'top', 'left']
const waitsOpen = ref(false)
const hoveredDiscard = ref<TileType | null>(null)
const kongPickerOpen = ref(false)
const touchStarts = new Map<number, { index: number; x: number; y: number; startedAt: number }>()
let lastTouchTap = { index: -1, time: 0 }
let suppressTileClickUntil = 0

const tableActionPosition = computed(() => props.tableActionEvent ? seatPosition[props.tableActionEvent.actorIndex] : 'bottom')
const tableActionLabel = computed(() => ({
  peng: '碰', 'discard-gang': '杠', 'concealed-gang': '杠', 'added-gang': '杠',
  'flower-gang': '杠', 'self-draw': '自摸', 'robbed-kong-win': '抢杠胡',
}[props.tableActionEvent?.type ?? 'peng']))
const tableActionIsWin = computed(() => ['self-draw', 'robbed-kong-win'].includes(props.tableActionEvent?.type ?? ''))
const scoreDeltaFor = (playerIndex: number) => props.scoreFlowEvent?.deltas.find((delta) => delta.playerIndex === playerIndex)?.amount ?? 0
const hoveredWaits = computed(() => hoveredDiscard.value
  ? props.userTingOptions.find((option) => option.discard === hoveredDiscard.value) ?? null
  : null)
const activeWaits = computed(() => hoveredWaits.value || props.userDiscardWaits || (!props.isUserTurn ? props.userCurrentWaits : null))
const tingDiscardTiles = computed(() => new Set(props.userTingOptions.map((option) => option.discard)))
const displayedUserHand = computed(() => {
  if (props.winPresentation?.winnerIndex !== 0) return props.user.hand
  return splitWinningTile(props.user.hand, props.winPresentation).hand
})

watch(() => props.userDiscardWaits, (value) => { waitsOpen.value = Boolean(value) })
watch(() => props.isUserTurn, (value) => { if (!value) waitsOpen.value = false })
watch(() => props.userKongs, (kongs) => { if (!kongs.length) kongPickerOpen.value = false })

function usesFinePointer() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function previewDesktopWaits(tile: TileType) {
  if (!props.isUserTurn || !usesFinePointer() || !tingDiscardTiles.value.has(tile)) return
  hoveredDiscard.value = tile
  waitsOpen.value = true
}

function clearDesktopWaits() {
  if (!usesFinePointer() || !hoveredDiscard.value) return
  hoveredDiscard.value = null
  waitsOpen.value = false
}

function beginTileGesture(index: number, event: PointerEvent) {
  if (!['touch', 'pen'].includes(event.pointerType)) return
  touchStarts.set(event.pointerId, { index, x: event.clientX, y: event.clientY, startedAt: performance.now() })
  ;(event.currentTarget as HTMLElement)?.setPointerCapture?.(event.pointerId)
}

function finishTileGesture(index: number, event: PointerEvent) {
  const start = touchStarts.get(event.pointerId)
  touchStarts.delete(event.pointerId)
  if (!start || start.index !== index || !props.isUserTurn) return
  const deltaX = event.clientX - start.x
  const upwardDistance = -(event.clientY - start.y)
  if (upwardDistance >= 28 && upwardDistance > Math.abs(deltaX) * 1.15 && performance.now() - start.startedAt < 700) {
    suppressTileClickUntil = performance.now() + 500
    lastTouchTap = { index: -1, time: 0 }
    hoveredDiscard.value = null
    waitsOpen.value = false
    emit('discard', index)
  }
}

function cancelTileGesture(event: PointerEvent) {
  touchStarts.delete(event.pointerId)
}

function handleTileActivation(index: number, event?: PointerEvent) {
  if (!props.isUserTurn) return
  const now = performance.now()
  if (now < suppressTileClickUntil) return
  const isTouch = event?.pointerType === 'touch' || event?.pointerType === 'pen' || !usesFinePointer()
  if (!isTouch) {
    hoveredDiscard.value = null
    waitsOpen.value = false
    emit('discard', index)
    return
  }
  if (lastTouchTap.index === index && now - lastTouchTap.time <= 360) {
    lastTouchTap = { index: -1, time: 0 }
    waitsOpen.value = false
    emit('discard', index)
    return
  }
  lastTouchTap = { index, time: now }
  emit('selectTile', index)
}

function clearMobileSelection(event: PointerEvent) {
  if (usesFinePointer() || props.selectedIndex < 0 || event.pointerType === 'mouse') return
  const target = event.target as HTMLElement
  if (target.closest('.hand-tile-slot, .waiting-tip, .action-bar')) return
  emit('clearSelection')
  waitsOpen.value = false
  lastTouchTap = { index: -1, time: 0 }
}

function toggleKongPicker() {
  if (kongPickerOpen.value) return void (kongPickerOpen.value = false)
  if (props.userKongs.length === 1) emit('gang', props.userKongs[0])
  else if (props.userKongs.length > 1) kongPickerOpen.value = true
}

function chooseKong(tile: TileType) {
  kongPickerOpen.value = false
  emit('gang', tile)
}

function onAvatarError(entry: GamePlayer) {
  const fallback = defaultAvatarForSeat(entry.seat)
  if (entry.avatar !== fallback) entry.avatar = fallback
}
</script>

<template>
  <div class="game-table-hud" @pointerdown="clearMobileSelection">
    <MahjongTable3D
      :players="players" :current-player="currentPlayer" :last-discard="lastDiscard"
      :wall="wall" :wall-head-drawn="wallHeadDrawn" :wall-count="wallCount"
      :horses="result?.horses" :reveal-hands="revealHands" :winner-index="winningPlayerIndex"
      :win-effect="winEffect" :win-presentation="winPresentation" :deal-animation="dealAnimation"
      :opening-stage="openingStage" :dice-values="diceValues" :dealer-index="dealer"
      :table-action-event="tableActionEvent"
    />
    <PlayerSeat
      v-for="(player, index) in players.slice(1)" :key="player.seat" :player="player"
      :position="seatPosition[index + 1]" :active="currentPlayer === index + 1"
      :action-active="tableActionEvent?.actorIndex === index + 1" :score-delta="scoreDeltaFor(index + 1)"
      :score-flow-id="scoreFlowEvent?.id" :dealer="dealer === index + 1" :render-hand="false" :render-melds="false"
    />

    <Transition name="table-action" mode="out-in">
      <div v-if="tableActionEvent" :key="tableActionEvent.id" class="table-action-cue" :class="[`action-from-${tableActionPosition}`, { gang: tableActionLabel === '杠', win: tableActionIsWin }]" aria-live="polite"><span>{{ tableActionLabel }}</span></div>
    </Transition>
    <Transition name="announce">
      <div v-if="announcement" :key="announcement.id" class="announcement" :class="announcement.tone"><span>{{ announcement.text }}</span></div>
    </Transition>
    <Transition name="opening-cue" mode="out-in">
      <div v-if="openingStage === 'start'" key="start" class="opening-overlay start-cue"><span>{{ matchName }} · {{ roundLabel }}</span><strong>对局开始</strong><i></i></div>
    </Transition>

    <section class="user-area">
      <div class="user-identity" :class="{ active: currentPlayer === 0, 'action-active': tableActionEvent?.actorIndex === 0 }">
        <span v-if="dealer === 0" class="dealer-badge">庄</span>
        <img class="avatar" :src="user.avatar" :alt="`${user.name}头像`" @error="onAvatarError(user)" />
        <div class="player-info"><strong>{{ user.name }}</strong><span>{{ user.score }}</span></div>
      </div>
      <Transition name="score-flow">
        <strong v-if="scoreDeltaFor(0)" :key="`${scoreFlowEvent?.id}-0`" class="score-delta user-score-delta" :class="scoreDeltaFor(0) > 0 ? 'positive' : 'negative'">{{ scoreDeltaFor(0) > 0 ? '+' : '' }}{{ scoreDeltaFor(0) }}</strong>
      </Transition>
      <div class="hand-rack" :class="{ playable: isUserTurn, dealing: phase === 'dealing', 'has-melds': user.melds.length }">
        <div
          v-for="(tile, index) in displayedUserHand" :key="`${tile}-${index}`" class="hand-tile-slot"
          :class="{ drawn: user.drawnTileIndex === index, 'ting-discard': isUserTurn && tingDiscardTiles.has(tile) }"
          @mouseenter="previewDesktopWaits(tile)" @mouseleave="clearDesktopWaits"
          @pointerdown.stop="beginTileGesture(index, $event)" @pointerup.stop="finishTileGesture(index, $event)" @pointercancel="cancelTileGesture"
        >
          <span v-if="isUserTurn && tingDiscardTiles.has(tile)" class="ting-arrow" aria-hidden="true"></span>
          <MahjongTile :tile="tile" :selected="selectedIndex === index" :drawn="user.drawnTileIndex === index" :disabled="!isUserTurn" @choose="handleTileActivation(index, $event)" />
        </div>
      </div>
    </section>

    <div v-if="isUserTurn || actionPrompt" class="turn-timer" :class="{ 'prompt-timer': actionPrompt }"><span>{{ turnSeconds }}</span></div>
    <div v-if="activeWaits && waitsOpen" class="waiting-tip compact-waiting-tip">
      <template v-if="activeWaits.any"><strong>听任意</strong><em>{{ activeWaits.remaining }}张</em></template>
      <template v-else><div class="waiting-tiles"><div v-for="item in activeWaits.tiles" :key="item.tile"><MahjongTile :tile="item.tile" small disabled /><small>{{ item.remaining }}张</small></div></div></template>
    </div>
    <div v-if="actionPrompt || isUserTurn || userCurrentWaits" class="action-bar" :class="{ 'kong-picker-open': kongPickerOpen }">
      <button v-if="userCurrentWaits || userTingOptions.length" class="action waiting-action" :class="{ active: waitsOpen }" aria-label="查看听牌提示" :aria-expanded="waitsOpen" @click="waitsOpen = !waitsOpen"><img class="action-icon" :src="`${imageBase}tips.png`" alt="" /></button>
      <template v-if="actionPrompt?.type === 'claim'">
        <button class="action primary" @click="$emit('peng')"><b>碰</b></button>
        <button v-if="actionPrompt.canGang" class="action primary" @click="$emit('gangFromDiscard')"><b>杠</b></button>
        <button class="action pass" @click="$emit('pass')"><b>过</b></button>
      </template>
      <template v-else-if="actionPrompt?.type === 'rob'">
        <button class="action hu" @click="$emit('hu')"><b>胡</b></button>
        <button class="action pass" @click="$emit('pass')"><b>过</b></button>
      </template>
      <template v-else>
        <button v-if="userKongs.length" class="action primary" @click="toggleKongPicker"><b>{{ kongPickerOpen ? '取消' : '杠' }}</b></button>
        <button v-if="userCanHu" class="action hu" @click="$emit('hu')"><b>胡</b></button>
      </template>
    </div>

    <Transition name="modal">
      <div v-if="kongPickerOpen && userKongs.length" class="result-backdrop kong-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="kong-picker-title" @click.self="kongPickerOpen = false">
        <section class="result-card kong-picker-card"><h2 id="kong-picker-title">请选择想要杠的牌</h2><div class="kong-picker-tiles"><MahjongTile v-for="tile in userKongs" :key="tile" :tile="tile" class="kong-picker-tile" @choose="chooseKong(tile)" /></div></section>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.game-table-hud { display: contents; }
</style>
