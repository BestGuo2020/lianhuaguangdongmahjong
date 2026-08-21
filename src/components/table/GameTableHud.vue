<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import MahjongTile from '../MahjongTile.vue'
import PlayerSeat from '../PlayerSeat.vue'
import { splitWinningTile } from '../../game/core/presentation/winEffect'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
import { tileName } from '../../game/core/rules/tiles'
import type { ActionPrompt, Announcement, DealAnimation, GamePhase, LastDiscard, OpeningStage, RoundResult, WaitInfo, WinEffect } from '../../game/core/contracts/gamePort'
import type { GamePlayer, ScoreFlowEvent, TableActionEvent, TileType, WinPresentation } from '../../game/core/contracts/types'
import type { TableThemeName } from './three/tableTheme'
import { createTableLoadRetryController } from './tableLoadRetry'

const MahjongTable3D = defineAsyncComponent(() => import('../MahjongTable3D.vue'))
// 预热 3D 牌桌组件 chunk：首次开局时若等挂载才加载，WebGL 场景初始化会
// 与骰子动画竞争首帧，导致骰子动画被压缩/跳过。应用启动即预取。
void import('../MahjongTable3D.vue')

interface Props {
  themeName: TableThemeName
  players: GamePlayer[]
  user: GamePlayer
  phase: GamePhase
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
  winEffect: WinEffect | null
  winPresentation: WinPresentation | null
  revealHands: boolean
  matchFinished: boolean
  winningPlayerIndex: number
  dealer: number
  isUserTurn: boolean
  userCanHu: boolean
  matchName: string
  roundLabel: string
  dealAnimation: DealAnimation
  openingStage: OpeningStage | null
  diceValues: number[]
  diceThrowerIndex: number
  userCurrentWaits: WaitInfo | null
  userTingOptions: WaitInfo[]
  userDiscardWaits: WaitInfo | null
  userKongs: TileType[]
  userHasWindKong: boolean
  /** 多人联机模式：显示托管开关按钮 */
  autoPlayEnabled?: boolean
  /** 当前是否已开启托管（联机自动出牌/过牌） */
  autoPlay?: boolean
  rulesetId?: 'lotus-classic' | 'lotus-legacy'
  secondDice?: [number, number]
  /** 本局癞子集合（莲花麻将翻精），未传按白板癞子处理 */
  jokerTiles?: TileType[]
  wildcardTiles?: TileType[]
  /** 莲花麻将翻出的指示牌（精） */
  flipTile?: TileType | null
  /** 3D 牌山断点（莲花麻将由开局计算），未传按骰子计算 */
  wallBreakIndex?: number
  /** 翻精所在物理墩（0..67），供 3D 在牌山上翻出指示牌 */
  flipStack?: number
}

const props = defineProps<Props>()
const emit = defineEmits<{
  ready: []
  selectTile: [index: number]
  clearSelection: []
  discard: [index: number]
  pass: []
  peng: []
  chi: [chiIndex: number]
  gangFromDiscard: []
  gang: [tile: TileType]
  hu: []
  windKong: []
  toggleAutoPlay: []
}>()

function handleTableReady() {
  tableLoadRetry.succeed()
  tableReady.value = true
  tableLoadError.value = ''
  emit('ready')
}

function handleTableLoadError(message: string) {
  tableReady.value = false
  tableLoadRetry.fail(message)
}

function retryTableLoad() {
  tableReady.value = false
  tableLoadError.value = ''
  tableLoadRetry.manualRetry()
}

const imageBase = `${import.meta.env.BASE_URL}img/`
const seatPosition = ['bottom', 'right', 'top', 'left']
const waitsOpen = ref(false)
const tableReady = ref(false)
const tableLoadError = ref('')
const tableLoadAttempt = ref(0)
const tableLoadRetry = createTableLoadRetryController({
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel: (timer) => window.clearTimeout(timer),
  onRetry: () => {
    tableLoadError.value = ''
    tableLoadAttempt.value += 1
  },
  onExhausted: (message) => {
    tableLoadError.value = message || '牌桌资源加载失败'
  },
})
const hoveredDiscard = ref<TileType | null>(null)
const kongPickerOpen = ref(false)
const chiPickerOpen = ref(false)

watch(() => props.themeName, () => {
  tableLoadRetry.reset()
  tableReady.value = false
  tableLoadError.value = ''
})
onBeforeUnmount(() => tableLoadRetry.dispose())
// 移动端翻精指示牌折叠为小徽章，点击展开二骰/精牌说明（桌面端始终完整显示）。
const flipOpen = ref(false)
// 每局翻精牌变化时复位折叠状态，避免跨局残留展开。
watch(() => props.flipTile, () => { flipOpen.value = false })
const touchStarts = new Map<number, { index: number; x: number; y: number; startedAt: number }>()
let lastTouchTap = { index: -1, time: 0 }
let suppressTileClickUntil = 0

const tableActionPosition = computed(() => props.tableActionEvent ? seatPosition[props.tableActionEvent.actorIndex] : 'bottom')
const tableActionLabel = computed(() => ({
  peng: '碰', chi: '吃', 'discard-gang': '杠', 'concealed-gang': '杠', 'added-gang': '杠', 'wind-kong': '风杠',
  'flower-gang': '杠', 'self-draw': '自摸', 'discard-win': '胡', 'robbed-kong-win': '抢杠胡',
}[props.tableActionEvent?.type ?? 'peng']))
const tableActionIsWin = computed(() => ['self-draw', 'discard-win', 'robbed-kong-win'].includes(props.tableActionEvent?.type ?? ''))
const scoreDeltaFor = (playerIndex: number) => props.scoreFlowEvent?.deltas.find((delta) => delta.playerIndex === playerIndex)?.amount ?? 0
const hoveredWaits = computed(() => hoveredDiscard.value
  ? props.userTingOptions.find((option) => option.discard === hoveredDiscard.value) ?? null
  : null)
const activeWaits = computed(() => hoveredWaits.value || props.userDiscardWaits || (!props.isUserTurn ? props.userCurrentWaits : null))
// 托管开关：仅多人联机模式显示；结算/亮相/回大厅等阶段隐藏，其余对局时段（含他人回合）常驻可切换。
const showAutoPlay = computed(() => Boolean(props.autoPlayEnabled)
  && !['lobby', 'win-effect', 'revealing', 'settled', 'finished'].includes(props.phase))
// 操作按钮行与倒计时同行：任一方可见时整行出现。
const showTurnRow = computed(() => Boolean(props.actionPrompt || props.isUserTurn || props.userCurrentWaits) || showAutoPlay.value)
const tingDiscardTiles = computed(() => new Set(props.userTingOptions.map((option) => option.discard)))
const displayedUserHand = computed(() => {
  if (props.winPresentation?.winnerIndex !== 0) return props.user.hand
  return splitWinningTile(props.user.hand, props.winPresentation).hand
})
const tableSeatCounts = computed(() => [...props.players]
  .sort((left, right) => left.seat - right.seat)
  .map((player) => ({
    seat: player.seat,
    concealed: player.concealedTileCount ?? player.hand.length,
    // 只公开真实牌面张数，不公开牌值。结算亮牌时它必须追上 concealed；
    // 若仍为 0，说明协议只有 null 暗牌占位，3D 会把该家渲染成空手牌。
    faces: player.hand.length,
    discards: player.discards.length,
    meldTiles: player.melds.reduce((sum, meld) => sum + meld.tiles.length, 0),
  })))
const tableSeatsData = computed(() => tableSeatCounts.value.map((entry) => entry.seat).join(','))
const tableConcealedData = computed(() => tableSeatCounts.value.map((entry) => entry.concealed).join(','))
const tableFaceCountsData = computed(() => tableSeatCounts.value.map((entry) => entry.faces).join(','))
const tableDiscardsData = computed(() => tableSeatCounts.value.map((entry) => entry.discards).join(','))
const tableMeldTilesData = computed(() => tableSeatCounts.value.map((entry) => entry.meldTiles).join(','))
const jokerGuide = computed(() => {
  if (!props.flipTile || !props.jokerTiles?.length) return null
  const precisionNames = props.jokerTiles.map(tileName).join('、')
  return {
    precision: precisionNames,
    wildcard: [...new Set([...props.jokerTiles, 'white' as TileType])].map(tileName).join('、'),
  }
})
// 摸牌位：手牌比基准（13 - 3×非花副露数）多一张时，把多出的那张视为「摸牌」并留间隙。
// 与 3D 牌桌 tableTilePresenter 规则一致：drawnTileIndex 有效时用它，否则取末张。
// 覆盖 14/11/8/5/2 张（副露 0-4 副）场景——碰/杠后跳摸时 drawnTileIndex 为 -1，也要据此留间隙。
const userDrawnIndex = computed(() => {
  if (props.revealHands) return -1
  const hand = displayedUserHand.value
  const rawDrawn = props.user.drawnTileIndex
  const meldCount = props.user.melds.filter((meld) => meld.type !== 'flower').length
  const baseHand = 13 - 3 * meldCount
  if (rawDrawn >= 0 && rawDrawn < hand.length) return rawDrawn
  return hand.length > baseHand ? hand.length - 1 : -1
})

watch(() => props.userDiscardWaits, (value) => { waitsOpen.value = Boolean(value) })
watch(() => props.isUserTurn, (value) => { if (!value) waitsOpen.value = false })
watch(() => props.userKongs, (kongs) => { if (!kongs.length) kongPickerOpen.value = false })
watch(() => props.actionPrompt, () => { chiPickerOpen.value = false })

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
  if (target.closest('.hand-tile-slot, .waiting-tip, .turn-action-row')) return
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

function toggleChiPicker() {
  const options = props.actionPrompt?.chiOptions ?? []
  if (options.length === 1) emit('chi', 0)
  else if (options.length > 1) chiPickerOpen.value = !chiPickerOpen.value
}

function chooseChi(index: number) {
  chiPickerOpen.value = false
  emit('chi', index)
}

function onAvatarError(entry: GamePlayer) {
  const fallback = defaultAvatarForSeat(entry.seat)
  if (entry.avatar !== fallback) entry.avatar = fallback
}
</script>

<template>
  <div
    class="game-table-hud"
    :data-phase="phase"
    :data-opening-stage="openingStage ?? ''"
    :data-dice-values="diceValues.join(',')"
    :data-dice-thrower-index="diceThrowerIndex"
    :data-wall-break-index="wallBreakIndex ?? -1"
    :data-flip-stack="flipStack ?? -1"
    :data-wall-count="wallCount"
    :data-wall-head-drawn="wallHeadDrawn"
    :data-deal-serial="dealAnimation.serial"
    :data-deal-count="dealAnimation.count"
    :data-win-effect-id="winEffect?.id ?? -1"
    :data-win-effect-winner="winEffect?.winnerIndex ?? -1"
    :data-win-effect-tile="winEffect?.tile ?? ''"
    :data-table-seats="tableSeatsData"
    :data-concealed-counts="tableConcealedData"
    :data-revealed-face-counts="tableFaceCountsData"
    :data-reveal-hands="revealHands ? 1 : 0"
    :data-match-finished="matchFinished ? 1 : 0"
    :data-discard-counts="tableDiscardsData"
    :data-meld-tile-counts="tableMeldTilesData"
    @pointerdown="clearMobileSelection"
  >
    <MahjongTable3D
      :key="`${themeName}:${tableLoadAttempt}`"
      :theme-name="themeName"
      :players="players" :local-seat="user.seat" :current-player="currentPlayer" :last-discard="lastDiscard"
      :wall="wall" :wall-head-drawn="wallHeadDrawn" :wall-count="wallCount"
      :horses="result?.horses" :reveal-hands="revealHands" :winner-index="winningPlayerIndex"
      :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles"
      :win-effect="winEffect" :win-presentation="winPresentation" :deal-animation="dealAnimation"
      :opening-stage="openingStage" :dice-values="diceValues" :dealer-index="dealer" :dice-thrower-index="diceThrowerIndex"
      :table-action-event="tableActionEvent"
      :wall-break-index="wallBreakIndex"
      :flip-tile="flipTile"
      :flip-stack="flipStack"
      @ready="handleTableReady"
      @load-error="handleTableLoadError"
    />
    <Transition name="table-loading">
      <div
        v-if="!tableReady" class="table-loading" :class="{ 'has-error': tableLoadError }"
        :role="tableLoadError ? 'alert' : 'status'" aria-live="polite"
      >
        <div class="table-loading-card" :class="{ error: tableLoadError }">
          <template v-if="tableLoadError">
            <strong>牌桌资源加载失败</strong>
            <span>请检查网络后重试</span>
            <button type="button" @click="retryTableLoad">重试</button>
          </template>
          <template v-else>
            <span class="table-loading-spinner" aria-hidden="true"></span>
            <span>牌桌资源加载中…</span>
          </template>
        </div>
      </div>
    </Transition>
    <Transition name="flip-cue">
      <div
        v-if="flipTile" key="flip" class="flip-indicator" :class="{ 'flip-open': flipOpen }"
        role="button" tabindex="0" aria-label="翻精指示牌" :aria-expanded="flipOpen"
        @click="flipOpen = !flipOpen" @keydown.enter="flipOpen = !flipOpen" @keydown.space.prevent="flipOpen = !flipOpen"
      >
        <div class="flip-indicator-head">
          <span>翻精</span>
          <MahjongTile :tile="flipTile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" small disabled />
          <em>{{ tileName(flipTile) }}</em>
          <i class="flip-chevron" aria-hidden="true"></i>
        </div>
        <div class="flip-indicator-body">
          <div v-if="rulesetId === 'lotus-legacy' && secondDice" class="second-dice-note">
            二骰 {{ secondDice[0] }} + {{ secondDice[1] }}
          </div>
          <div v-if="jokerGuide" class="joker-guide" role="note" aria-label="精牌替代说明">
            <div><strong>精牌：</strong>{{ jokerGuide.precision }}</div>
            <div><strong>白板替代：</strong>{{ jokerGuide.wildcard }}</div>
          </div>
        </div>
      </div>
    </Transition>
    <PlayerSeat
      v-for="(player, index) in players.slice(1)" :key="player.seat" :player="player"
      :position="seatPosition[index + 1]" :active="currentPlayer === index + 1"
      :action-active="tableActionEvent?.actorIndex === index + 1" :score-delta="scoreDeltaFor(index + 1)"
      :score-flow-id="scoreFlowEvent?.id" :dealer="dealer === index + 1" :render-hand="false" :render-melds="false" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles"
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
          :class="{ drawn: userDrawnIndex === index, 'ting-discard': isUserTurn && tingDiscardTiles.has(tile) }"
          @mouseenter="previewDesktopWaits(tile)" @mouseleave="clearDesktopWaits"
          @pointerdown.stop="beginTileGesture(index, $event)" @pointerup.stop="finishTileGesture(index, $event)" @pointercancel="cancelTileGesture"
        >
          <span v-if="isUserTurn && tingDiscardTiles.has(tile)" class="ting-arrow" aria-hidden="true"></span>
          <MahjongTile :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :selected="selectedIndex === index" :drawn="userDrawnIndex === index" :disabled="!isUserTurn" @choose="handleTileActivation(index, $event)" />
        </div>
      </div>
    </section>

    <div v-if="showTurnRow" class="turn-action-row" :class="{ 'kong-picker-open': kongPickerOpen || chiPickerOpen }">
      <div v-if="actionPrompt || isUserTurn || userCurrentWaits" class="action-bar">
        <button v-if="userCurrentWaits || userTingOptions.length" class="action waiting-action" :class="{ active: waitsOpen }" aria-label="查看听牌提示" :aria-expanded="waitsOpen" @click="waitsOpen = !waitsOpen"><img class="action-icon" :src="`${imageBase}tips.png`" alt="" /></button>
        <template v-if="actionPrompt?.type === 'claim'">
          <button v-if="actionPrompt.canHu" class="action hu" @click="$emit('hu')"><b>胡</b></button>
          <button v-if="actionPrompt.canPeng" class="action primary" @click="$emit('peng')"><b>碰</b></button>
          <button v-if="actionPrompt.canGang" class="action primary" @click="$emit('gangFromDiscard')"><b>杠</b></button>
          <button v-if="actionPrompt.chiOptions?.length" class="action primary" @click="toggleChiPicker"><b>吃</b></button>
          <button class="action pass" @click="$emit('pass')"><b>过</b></button>
        </template>
        <template v-else-if="actionPrompt?.type === 'response'">
          <button v-if="actionPrompt.canPeng" class="action primary" @click="$emit('peng')"><b>碰</b></button>
          <button v-if="actionPrompt.canGang" class="action primary" @click="$emit('gangFromDiscard')"><b>杠</b></button>
          <button v-if="actionPrompt.chiOptions?.length" class="action primary" @click="toggleChiPicker"><b>吃</b></button>
          <button v-if="actionPrompt.canHu" class="action hu" @click="$emit('hu')"><b>胡</b></button>
          <button class="action pass" @click="$emit('pass')"><b>过</b></button>
        </template>
        <template v-else-if="actionPrompt?.type === 'rob' || actionPrompt?.type === 'hu'">
          <button class="action hu" @click="$emit('hu')"><b>胡</b></button>
          <button class="action pass" @click="$emit('pass')"><b>过</b></button>
        </template>
        <template v-else-if="actionPrompt?.type === 'chi'">
          <button class="action primary" @click="toggleChiPicker"><b>吃</b></button>
          <button class="action pass" @click="$emit('pass')"><b>过</b></button>
        </template>
        <template v-else>
          <button v-if="userKongs.length" class="action primary" @click="toggleKongPicker"><b>{{ kongPickerOpen ? '取消' : '杠' }}</b></button>
          <button v-if="userHasWindKong" class="action primary" @click="$emit('windKong')"><b>风杠</b></button>
          <button v-if="userCanHu" class="action hu" @click="$emit('hu')"><b>胡</b></button>
        </template>
      </div>
      <button
        v-if="showAutoPlay" class="action autoplay-action" :class="{ active: autoPlay }"
        :aria-pressed="autoPlay" :aria-label="autoPlay ? '取消托管，恢复手动操作' : '开启托管，自动出牌与过牌'"
        :title="autoPlay ? '托管中：点击恢复手动' : '点击托管：到您的回合自动出牌/过牌'"
        @click="$emit('toggleAutoPlay')"
      ><b>托管</b></button>
      <div v-if="(isUserTurn || actionPrompt) && turnSeconds > 0" class="turn-timer" :class="{ 'prompt-timer': actionPrompt }"><span>{{ turnSeconds }}</span></div>
    </div>
    <div v-if="activeWaits && waitsOpen" class="waiting-tip compact-waiting-tip">
      <template v-if="activeWaits.any"><strong>听任意</strong><em>{{ activeWaits.remaining }}张</em></template>
      <template v-else><div class="waiting-tiles"><div v-for="item in activeWaits.tiles" :key="item.tile"><MahjongTile :tile="item.tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" small disabled /><small>{{ item.remaining }}张</small></div></div></template>
    </div>

    <Transition name="modal">
      <div v-if="kongPickerOpen && userKongs.length" class="result-backdrop kong-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="kong-picker-title" @click.self="kongPickerOpen = false">
        <section class="result-card kong-picker-card"><h2 id="kong-picker-title">请选择想要杠的牌</h2><div class="kong-picker-tiles"><MahjongTile v-for="tile in userKongs" :key="tile" :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" class="kong-picker-tile" @choose="chooseKong(tile)" /></div></section>
      </div>
    </Transition>
    <Transition name="modal">
      <div v-if="chiPickerOpen && actionPrompt?.chiOptions?.length" class="result-backdrop kong-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="chi-picker-title" @click.self="chiPickerOpen = false">
        <section class="result-card kong-picker-card">
          <h2 id="chi-picker-title">请选择吃牌组合</h2>
          <div class="kong-picker-tiles chi-picker-options">
            <button v-for="(option, chiIndex) in actionPrompt.chiOptions" :key="chiIndex" class="chi-picker-option" @click="chooseChi(chiIndex)">
              <MahjongTile v-for="tile in option.tiles" :key="tile" :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" small disabled />
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.game-table-hud { display: contents; }

/* 莲花麻将翻精指示牌（桌面右上角；桌面端始终完整显示） */
.flip-indicator {
  position: absolute;
  top: 50px;
  right: 18px;
  z-index: 30;
  display: grid;
  gap: 5px;
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(28, 20, 8, 0.72);
  border: 1px solid rgba(212, 175, 55, 0.6);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  cursor: pointer;
}
.flip-indicator-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.flip-indicator-head > span {
  font-size: 14px;
  font-weight: 700;
  color: #ffd966;
  letter-spacing: 2px;
}
.flip-indicator-head > em {
  font-style: normal;
  font-size: 13px;
  font-weight: 600;
  color: #f3e5c3;
}
.flip-indicator-body {
  display: grid;
  gap: 5px;
}
/* 展开提示箭头：桌面端常显完整卡片，无需提示 */
.flip-chevron {
  display: none;
  font-style: normal;
  font-size: 10px;
  color: #ffd966;
  transition: transform 0.2s;
}
.flip-open .flip-chevron {
  transform: rotate(180deg);
}
.joker-guide {
  display: grid;
  gap: 2px;
  color: #f3e5c3;
  font-size: 11px;
  line-height: 1.35;
  white-space: nowrap;
}
.joker-guide strong {
  color: #7ce6ff;
  font-weight: 800;
}

/* 移动端（窄屏/矮屏）：翻精指示牌折叠为一行小徽章，不遮挡任何座位；
   点击徽章展开二骰/精牌说明（.flip-open），再点收起。 */
@media (max-width: 700px), (max-height: 460px) {
  .flip-indicator {
    top: 40px;
    right: 12px;
    left: auto;
    gap: 3px;
    padding: 5px 8px;
    border-radius: 8px;
  }
  .flip-indicator-head { gap: 4px; }
  .flip-indicator-head > span { font-size: 12px; letter-spacing: 1px; }
  .flip-indicator-head > em { font-size: 11px; }
  .flip-chevron { display: block; }
  .flip-indicator-body { display: none; }
  .flip-open .flip-indicator-body {
    display: grid;
    gap: 3px;
  }
  .joker-guide { font-size: 10px; }
  .joker-guide div { max-width: 150px; white-space: normal; }
}

.chi-option-tiles { display: inline-flex; gap: 2px; margin-left: 4px; vertical-align: middle; }
.chi-action { gap: 2px; }
.chi-picker-options { align-items: stretch; }
.chi-picker-option {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid rgba(212, 175, 55, .5);
  border-radius: 10px;
  background: rgba(4, 39, 28, .92);
  cursor: pointer;
}
.chi-picker-option:hover,
.chi-picker-option:focus-visible {
  border-color: #f4cb63;
  background: rgba(13, 66, 45, .96);
  transform: translateY(-2px);
}
</style>
