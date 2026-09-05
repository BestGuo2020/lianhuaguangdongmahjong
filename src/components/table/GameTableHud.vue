<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import MahjongTile from '../MahjongTile.vue'
import PlayerSeat from '../PlayerSeat.vue'
import AnimeActionCue from './AnimeActionCue.vue'
import { splitWinningTile } from '../../game/core/presentation/winEffect'
import { defaultAvatarForSeat } from '../../game/core/presentation/avatar'
import { tileName } from '../../game/core/rules/tiles'
import type { ActionPrompt, Announcement, DealAnimation, GamePhase, LastDiscard, OpeningStage, RoundResult, WaitInfo, WinEffect } from '../../game/core/contracts/gamePort'
import type { GamePlayer, ScoreFlowEvent, TableActionEvent, TileType, WinPresentation } from '../../game/core/contracts/types'
import type { TableThemeName } from './three/tableTheme'
import type { BloodFlowTableState } from '../../game/variants/lotus/bloodFlow/types'
import BloodFlowSettlementHost from '../settlement/BloodFlowSettlementHost.vue'
import BloodFlowWinCard from './BloodFlowWinCard.vue'
import BloodFlowWinPresentation from './BloodFlowWinPresentation.vue'
import { BloodFlowPresentationDirector } from '../../game/variants/lotus/bloodFlow/presentationDirector'
import type { BloodFlowCue } from '../../game/variants/lotus/bloodFlow/presentation'
import { bloodFlowImpactProfile } from '../../theme/bloodFlowPresentation'
import { useEffectPlayer } from '../../game/core/presentation/useAudio'
import { createTableLoadRetryController } from './tableLoadRetry'
import { animeAvatarForPlayer } from '../../game/core/presentation/animeAvatarPresentation'
import { animeCharacterAccent } from '../../game/core/presentation/animeCharacterPalette'
import {
  resolveRoundResultPresentation,
  resolveTableActionPresentation,
  scoreDirection,
} from '../../theme/themeEventPresentation'

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
  rulesetId?: 'lotus-classic' | 'lotus-legacy' | 'lotus-blood-flow'
  bloodFlow?: BloodFlowTableState | null
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
  /** AI 大模型吐槽气泡：key=座位绝对索引，value=最近一条（展示层自管理过期） */
  llmBubbles?: Record<number, { text: string; id: number; persistent?: boolean }>
}

const props = defineProps<Props>()
const userAnimeStyle = computed(() => props.themeName === 'llmAnime'
  ? { '--anime-accent': animeCharacterAccent(props.user.characterId) }
  : undefined)
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
  nextRound: []
  returnToLobby: []
}>()

const settlementHost = ref<InstanceType<typeof BloodFlowSettlementHost>|null>(null)
const settlementVisible = ref(false)
const pileMedia = window.matchMedia('(max-width: 900px), (max-height: 500px)')
const compactPiles = ref(pileMedia.matches)
const resizePiles = () => { compactPiles.value = pileMedia.matches }
pileMedia.addEventListener('change', resizePiles)
onBeforeUnmount(() => pileMedia.removeEventListener('change', resizePiles))
const compactBloodFlowEffects = computed(() => compactPiles.value || new URLSearchParams(window.location.search).get('quality') === 'low')
const presentationDirector=new BloodFlowPresentationDirector(import.meta.env.DEV?Number(new URLSearchParams(window.location.search).get('motionScale'))||1:1)
const effectPlayer=useEffectPlayer(),playedImpacts=new Set<string>()
const tableHudElement=ref<HTMLElement|null>(null), ownDrawScreen=shallowRef<{sourceId:string;x:number;y:number}|null>(null)
const bloodFlowHidden=shallowRef<readonly string[]>([])
const bloodFlowCue=shallowRef<BloodFlowCue|null>(null), presentationNow=ref(0), presentationBusy=ref(false)
let presentationFrame=0
function advancePresentation(now:number){
  presentationFrame=0;presentationNow.value=now;bloodFlowCue.value=presentationDirector.tick(now);presentationBusy.value=presentationDirector.busy
  const hidden=presentationDirector.hiddenRecordIds(now)
  if(hidden.join('|')!==bloodFlowHidden.value.join('|'))bloodFlowHidden.value=hidden
  const cue=bloodFlowCue.value
  if(cue?.kind==='win'&&now>=cue.startedAt+cue.phaseMarks.impact&&!playedImpacts.has(cue.id)){
    playedImpacts.add(cue.id);effectPlayer?.('hu_effect_sound.mp3',bloodFlowImpactProfile(props.themeName,cue.tier,cue.compact).effectVolume)
  }
  if(presentationBusy.value)presentationFrame=requestAnimationFrame(advancePresentation)
}
watch(()=>[props.bloodFlow?.batches.map(b=>b.batchId).join('|'),props.bloodFlow?.kongEvents?.map(k=>k.id).join('|'),props.bloodFlow?.presentationKey,props.bloodFlow?.roundId,props.themeName],()=>{
  presentationDirector.sync(props.bloodFlow?.batches??[],`${props.themeName}/${props.bloodFlow?.roundId}/${props.bloodFlow?.presentationKey}`,performance.now(),props.bloodFlow?.kongEvents,props.themeName)
  if(presentationFrame)cancelAnimationFrame(presentationFrame)
  advancePresentation(performance.now())
},{immediate:true})
onBeforeUnmount(()=>{cancelAnimationFrame(presentationFrame);presentationDirector.reset()})
watch(()=>[props.bloodFlow?.sourceEvent?.id,props.user.drawnTileIndex,props.user.hand.length],async()=>{
  await nextTick()
  const source=props.bloodFlow?.sourceEvent
  const tile=tableHudElement.value?.querySelector('.hand-tile-slot.drawn'),canvas=tableHudElement.value?.querySelector('canvas')
  if(!source||source.kind!=='draw'||source.seat!==props.user.seat||!tile||!canvas){ownDrawScreen.value=null;return}
  const b=tile.getBoundingClientRect(),c=canvas.getBoundingClientRect()
  if(c.width&&c.height)ownDrawScreen.value={sourceId:source.id,x:(b.x+b.width/2-c.x)/c.width,y:(b.y+b.height/2-c.y)/c.height}
},{immediate:true,flush:'post'})

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
const actionCueLabParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null
const bubbleLabEnabled = actionCueLabParams?.get('bubbleLab') === '1'
const scoreFlowLabEnabled = actionCueLabParams?.get('scoreFlowLab') === '1'
const actionCueLabType = ref(actionCueLabParams?.get('actionCueLab') as TableActionEvent['type'] | null)
const actionCueLabActor = ref(Math.min(3, Math.max(0, Number(actionCueLabParams?.get('actionCueSeat') ?? 0) || 0)))
const actionCueLabId = ref(-1)
const actionCueLabTypes: ReadonlySet<TableActionEvent['type']> = new Set([
  'peng', 'chi', 'discard-gang', 'concealed-gang', 'added-gang', 'flower-gang', 'wind-kong',
  'self-draw', 'discard-win', 'robbed-kong-win',
])
const winActionTypes: ReadonlySet<TableActionEvent['type']> = new Set([
  'self-draw', 'discard-win', 'robbed-kong-win',
])
const actionCueLabEvent = computed<TableActionEvent | null>(() => (
  actionCueLabType.value && actionCueLabTypes.has(actionCueLabType.value) && props.players[actionCueLabActor.value]
    ? { id: actionCueLabId.value, type: actionCueLabType.value, actorIndex: actionCueLabActor.value, sourceIndex: null, tile: 'p5', meldIndex: -1 }
    : null
))
const presentedTableActionEvent = computed(() => {
  const event = props.tableActionEvent ?? actionCueLabEvent.value
  if (props.bloodFlow && event && winActionTypes.has(event.type)) return null
  return event && props.winEffect && winActionTypes.has(event.type) ? null : event
})
const presentedAnimeActionEvent = computed(() => presentedTableActionEvent.value)
const presentedAnimeActionPosition = computed(() => presentedAnimeActionEvent.value
  ? seatPosition[presentedAnimeActionEvent.value.actorIndex]
  : 'bottom')
const presentedLlmBubbles = computed(() => props.bloodFlow
  ? ['llm','llmAnime'].includes(props.themeName)?props.bloodFlow.roundResult?(settlementVisible.value?undefined:props.bloodFlow.roundBubbles):props.bloodFlow.actionBubbles:undefined
  : bubbleLabEnabled
  ? {
      ...props.llmBubbles,
      1: { id: -101, text: '这牌打得真有意思。', persistent: true },
      3: { id: -103, text: '这一张先打掉。', persistent: true },
    }
  : props.llmBubbles)
const presentedScoreFlowEvent = computed<ScoreFlowEvent | null>(() => props.bloodFlow?null:props.scoreFlowEvent ?? (scoreFlowLabEnabled
  ? { id: -1, deltas: [{ playerIndex: 0, amount: 800 }, { playerIndex: 1, amount: -800 }] }
  : null))
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
type ActionCueLabWindow = Window & {
  __setTableActionCueLab?: (type: TableActionEvent['type'] | null, actorIndex?: number) => void
}
const actionCueLabWindow = window as ActionCueLabWindow
const setTableActionCueLab = (type: TableActionEvent['type'] | null, actorIndex = 0) => {
  actionCueLabType.value = type && actionCueLabTypes.has(type) ? type : null
  actionCueLabActor.value = Math.min(3, Math.max(0, Math.trunc(actorIndex) || 0))
  actionCueLabId.value -= 1
}
if (import.meta.env.DEV) actionCueLabWindow.__setTableActionCueLab = setTableActionCueLab
onBeforeUnmount(() => {
  tableLoadRetry.dispose()
  if (actionCueLabWindow.__setTableActionCueLab === setTableActionCueLab) {
    delete actionCueLabWindow.__setTableActionCueLab
  }
})
// 移动端翻精指示牌折叠为小徽章，点击展开二骰/精牌说明（桌面端始终完整显示）。
const flipOpen = ref(false)
const firstHuOffer = ref(true)
const huOfferSeen = ref(false)
watch(() => props.bloodFlow?.roundId, () => { huOfferSeen.value = false; firstHuOffer.value = true })
watch(() => Boolean(props.bloodFlow?.preview && props.userCanHu), (available, previous) => {
  if (available && !previous) { firstHuOffer.value = !huOfferSeen.value; huOfferSeen.value = true }
}, { immediate: true })
// 每局翻精牌变化时复位折叠状态，避免跨局残留展开。
watch(() => props.flipTile, () => { flipOpen.value = false })
const touchStarts = new Map<number, { index: number; x: number; y: number; startedAt: number }>()
let lastTouchTap = { index: -1, time: 0 }
let suppressTileClickUntil = 0

const tableActionPosition = computed(() => presentedTableActionEvent.value ? seatPosition[presentedTableActionEvent.value.actorIndex] : 'bottom')
const tableActionPresentation = computed(() => resolveTableActionPresentation(presentedTableActionEvent.value?.type ?? 'peng'))
const tableActionIsWin = computed(() => tableActionPresentation.value.kind === 'win')
const roundResultPresentation = computed(() => props.result ? resolveRoundResultPresentation(props.result) : null)
const userAvatar = computed(() => props.themeName === 'llmAnime'
  ? animeAvatarForPlayer(props.user)
  : props.user.avatar)
const scoreDeltaFor = (playerIndex: number) => presentedScoreFlowEvent.value?.deltas.find((delta) => delta.playerIndex === playerIndex)?.amount ?? 0
const scoreDirectionFor = (playerIndex: number) => scoreDirection(scoreDeltaFor(playerIndex))
const hoveredWaits = computed(() => hoveredDiscard.value
  ? props.userTingOptions.find((option) => option.discard === hoveredDiscard.value) ?? null
  : null)
const activeWaits = computed(() => hoveredWaits.value || props.userDiscardWaits || (props.bloodFlow || !props.isUserTurn ? props.userCurrentWaits : null))
const bloodFlowWaitTiles = computed(() => (activeWaits.value?.tiles ?? []).map(item => {
  const scores = activeWaits.value?.discard ? props.bloodFlow?.discardWaitScores?.[activeWaits.value.discard] : props.bloodFlow?.waits
  const score = scores?.find(wait => wait.tile === item.tile)
  return { ...item, multiplier: (score?.selfDraw ?? score?.discard)?.finalMultiplier ?? null }
}))
// 托管开关：仅多人联机模式显示；结算/亮相/回大厅等阶段隐藏，其余对局时段（含他人回合）常驻可切换。
const showAutoPlay = computed(() => Boolean(props.autoPlayEnabled)
  && !['lobby', 'win-effect', 'revealing', 'settled', 'finished'].includes(props.phase))
// 操作按钮行与倒计时同行：任一方可见时整行出现。
const showTurnRow = computed(() => Boolean(props.actionPrompt || props.isUserTurn || props.userCurrentWaits) || showAutoPlay.value)
const tingDiscardTiles = computed(() => new Set(props.userTingOptions.map((option) => option.discard)))
function isTingDiscard(index: number, tile: TileType) {
  return props.isUserTurn && tingDiscardTiles.value.has(tile)
    && (!props.bloodFlow?.seats[props.user.seat].locked || index === userDrawnIndex.value)
}
function toggleWaits() {
  if (waitsOpen.value) { waitsOpen.value = false; return }
  if (!activeWaits.value && props.userTingOptions.length) {
    const index = props.bloodFlow?.seats[props.user.seat].locked ? userDrawnIndex.value
      : props.user.hand.indexOf(props.userTingOptions[0].discard!)
    if (index >= 0) emit('selectTile', index)
  }
  waitsOpen.value = true
}
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

function previewDesktopWaits(tile: TileType, index: number) {
  if (!usesFinePointer() || !isTingDiscard(index, tile)) return
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
    if (!props.bloodFlow?.seats[props.user.seat].locked || index === props.user.drawnTileIndex) emit('discard', index)
  }
}

function cancelTileGesture(event: PointerEvent) {
  touchStarts.delete(event.pointerId)
}

function handleTileActivation(index: number, event?: PointerEvent) {
  if (!props.isUserTurn) return
  if (props.bloodFlow?.seats[props.user.seat].locked && index !== props.user.drawnTileIndex) return
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
    ref="tableHudElement"
    class="game-table-hud"
    :class="{ 'blood-flow-table': Boolean(bloodFlow) }"
    :data-table-theme="themeName"
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
    :data-round-result-kind="roundResultPresentation?.kind ?? ''"
    :data-round-result-strength="roundResultPresentation?.strength ?? ''"
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
      :blood-flow-batches="bloodFlow?.batches"
      :blood-flow-compact="compactPiles"
      :blood-flow-presentation-key="bloodFlow?.presentationKey"
      :blood-flow-cue="bloodFlowCue"
      :blood-flow-hidden-records="bloodFlowHidden"
      :blood-flow-source-event="bloodFlow?.sourceEvent"
      :blood-flow-own-draw="ownDrawScreen"
      @ready="handleTableReady"
      @load-error="handleTableLoadError"
    />
    <template v-if="bloodFlow">
      <BloodFlowWinPresentation :cue="bloodFlowCue" :now="presentationNow" :players="players" :theme-name="themeName" :local-seat="user.seat" :compact="compactBloodFlowEffects" />
      <BloodFlowSettlementHost ref="settlementHost" :state="bloodFlow" :players="players" :local-seat="user.seat" :theme-name="themeName"
        :presentation-busy="presentationBusy"
        :match-finished="matchFinished" :round-label="roundLabel" @visible-change="settlementVisible=$event"
        @next-round="$emit('nextRound')" @return-to-lobby="$emit('returnToLobby')" />
    </template>
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
          <span>{{ bloodFlow ? '精' : '翻精' }}</span>
          <template v-if="bloodFlow">
            <MahjongTile v-for="tile in jokerTiles" :key="tile" :tile="tile" :joker-tiles="jokerTiles" :theme-name="themeName" small disabled />
          </template>
          <template v-else>
            <MahjongTile :tile="flipTile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" small disabled />
            <em>{{ tileName(flipTile) }}</em>
          </template>
          <i class="flip-chevron" aria-hidden="true"></i>
        </div>
        <div class="flip-indicator-body">
          <div v-if="rulesetId !== 'lotus-classic' && secondDice" class="second-dice-note">
            二骰 {{ secondDice[0] }} + {{ secondDice[1] }}
          </div>
          <div v-if="jokerGuide" class="joker-guide" role="note" aria-label="精牌替代说明">
            <div><strong>精牌：</strong>{{ jokerGuide.precision }}</div>
            <div><strong>白板替代：</strong>{{ jokerGuide.wildcard }}</div>
          </div>
        </div>
      </div>
    </Transition>
    <!-- players 已按本家视角排序，但 player.seat 保留服务器绝对座位；气泡必须按本地索引读取。 -->
    <PlayerSeat
      v-for="(player, index) in players.slice(1)" :key="player.seat" :player="player"
      :position="seatPosition[index + 1]" :active="currentPlayer === index + 1"
      :action-active="tableActionEvent?.actorIndex === index + 1" :score-delta="scoreDeltaFor(index + 1)"
      :score-flow-id="presentedScoreFlowEvent?.id" :dealer="dealer === index + 1"
      :avatar-override="themeName === 'llmAnime' ? animeAvatarForPlayer(player) : undefined"
      :theme-name="themeName"
      :bubble="presentedLlmBubbles?.[index + 1]"
    >
      <template v-if="bloodFlow" #footer>
        <button type="button" class="blood-flow-pile-badge" :class="`win-count-${seatPosition[index + 1]}`" :data-pile-seat="player.seat"
          :aria-label="`${player.name}，胡${bloodFlow.seats[player.seat].winCount}次，查看流水`"
          @click="settlementHost?.showDetails(player.seat)">胡 {{ bloodFlow.seats[player.seat].winCount }}次</button>
      </template>
    </PlayerSeat>

    <Transition name="table-action" mode="out-in">
      <AnimeActionCue
        v-if="presentedAnimeActionEvent && themeName === 'llmAnime'"
        :key="`anime-${presentedAnimeActionEvent.id}`"
        :class="[`action-${tableActionPresentation.kind}`, `strength-${tableActionPresentation.strength}`]"
        :data-action-type="presentedAnimeActionEvent.type"
        :data-action-kind="tableActionPresentation.kind"
        :data-action-strength="tableActionPresentation.strength"
        :event="presentedAnimeActionEvent"
        :player="players[presentedAnimeActionEvent.actorIndex]"
        :position="presentedAnimeActionPosition"
      />
      <div
        v-else-if="presentedTableActionEvent"
        :key="presentedTableActionEvent.id"
        class="table-action-cue"
        :class="[
          `action-from-${tableActionPosition}`,
          `action-${tableActionPresentation.kind}`,
          `strength-${tableActionPresentation.strength}`,
          { gang: tableActionPresentation.kind === 'gang', win: tableActionIsWin },
        ]"
        :data-action-type="presentedTableActionEvent.type"
        :data-action-kind="tableActionPresentation.kind"
        :data-action-strength="tableActionPresentation.strength"
        aria-live="polite"
      ><span>{{ tableActionPresentation.label }}</span></div>
    </Transition>
    <Transition name="announce">
      <div v-if="announcement" :key="announcement.id" class="announcement" :class="announcement.tone"><span>{{ announcement.text }}</span></div>
    </Transition>
    <Transition name="opening-cue" mode="out-in">
      <div v-if="openingStage === 'start'" key="start" class="opening-overlay start-cue"><span>{{ matchName }} · {{ roundLabel }}</span><strong>对局开始</strong><i></i></div>
    </Transition>

    <section class="user-area">
      <div class="user-identity" :class="{ active: currentPlayer === 0, 'action-active': tableActionEvent?.actorIndex === 0 }" :style="userAnimeStyle">
        <span v-if="dealer === 0" class="dealer-badge">庄</span>
        <img class="avatar" :src="userAvatar" :alt="`${user.name}头像`" @error="onAvatarError(user)" />
        <div class="player-info"><strong>{{ user.name }}</strong><span>{{ user.score }}</span></div>
        <button v-if="bloodFlow" type="button" class="blood-flow-pile-badge win-count-bottom" :data-pile-seat="user.seat"
          :aria-label="`${user.name}，胡${bloodFlow.seats[user.seat].winCount}次，查看流水`"
          @click="settlementHost?.showDetails(user.seat)">胡 {{ bloodFlow.seats[user.seat].winCount }}次</button>
        <Transition name="llm-bubble">
          <div
            v-if="presentedLlmBubbles?.[0]"
            :key="presentedLlmBubbles[0].id"
            class="llm-bubble user-llm-bubble"
            role="status"
            aria-live="polite"
          >{{ presentedLlmBubbles[0].text }}</div>
        </Transition>
      </div>
      <Transition name="score-flow">
        <strong
          v-if="scoreDeltaFor(0)"
          :key="`${presentedScoreFlowEvent?.id}-0`"
          class="score-delta user-score-delta"
          :class="scoreDirectionFor(0)"
          :data-score-direction="scoreDirectionFor(0)"
        >{{ scoreDeltaFor(0) > 0 ? '+' : '' }}{{ scoreDeltaFor(0) }}</strong>
      </Transition>
      <div class="hand-rack" :class="{ playable: isUserTurn, dealing: phase === 'dealing', 'has-melds': user.melds.length }">
        <div
          v-for="(tile, index) in displayedUserHand" :key="`${tile}-${index}`" class="hand-tile-slot"
          :class="{ drawn: userDrawnIndex === index, 'ting-discard': isTingDiscard(index, tile) }"
          @mouseenter="previewDesktopWaits(tile, index)" @mouseleave="clearDesktopWaits"
          @pointerdown.stop="beginTileGesture(index, $event)" @pointerup.stop="finishTileGesture(index, $event)" @pointercancel="cancelTileGesture"
        >
          <span class="hand-hit-area" aria-hidden="true"></span>
          <span v-if="isTingDiscard(index, tile)" class="ting-arrow" aria-hidden="true"></span>
          <MahjongTile :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" :selected="selectedIndex === index" :drawn="userDrawnIndex === index" :disabled="!isUserTurn || Boolean(bloodFlow?.seats[user.seat].locked && index !== userDrawnIndex)" @choose="handleTileActivation(index, $event)" />
        </div>
      </div>
    </section>

    <div v-if="showTurnRow" class="turn-action-row" :class="{ 'kong-picker-open': kongPickerOpen || chiPickerOpen }">
      <div v-if="bloodFlow?.preview && userCanHu && !presentationBusy" class="blood-flow-preview" role="status">
        <BloodFlowWinCard :key="bloodFlow.sourceEvent?.id" :score="bloodFlow.preview" compact preview />
        <small>{{ bloodFlow.seats[user.seat].locked ? '已锁手 · 可续胡' : firstHuOffer ? '胡后锁手，不再换张/吃碰杠' : '胡后锁手' }}</small>
      </div>
      <div v-if="actionPrompt || isUserTurn || userCurrentWaits" class="action-bar">
        <button v-if="userCurrentWaits || userTingOptions.length" class="action waiting-action" :class="{ active: waitsOpen }" data-action-role="secondary" aria-label="查看听牌提示" :title="userCurrentWaits ? '已听牌，查看听口' : '查看打哪张可听'" :aria-expanded="waitsOpen" @click="toggleWaits">
          <b v-if="bloodFlow" class="blood-flow-ting-label">{{ userCurrentWaits ? '已听' : '可听' }}</b>
          <template v-else-if="themeName === 'llmAnime'"><b>听</b><span>牌</span></template>
          <img v-else class="action-icon" :src="`${imageBase}tips.png`" alt="" />
        </button>
        <template v-if="actionPrompt?.type === 'claim'">
          <button v-if="actionPrompt.canHu" class="action hu" data-action-role="major" @click="$emit('hu')"><b>胡</b></button>
          <button v-if="actionPrompt.canPeng" class="action primary" data-action-role="primary" @click="$emit('peng')"><b>碰</b></button>
          <button v-if="actionPrompt.canGang" class="action primary" data-action-role="primary" @click="$emit('gangFromDiscard')"><b>杠</b></button>
          <button v-if="actionPrompt.chiOptions?.length" class="action primary" data-action-role="primary" @click="toggleChiPicker"><b>吃</b></button>
          <button class="action pass" data-action-role="danger" @click="$emit('pass')"><b>过</b></button>
        </template>
        <template v-else-if="actionPrompt?.type === 'response'">
          <button v-if="actionPrompt.canPeng" class="action primary" data-action-role="primary" @click="$emit('peng')"><b>碰</b></button>
          <button v-if="actionPrompt.canGang" class="action primary" data-action-role="primary" @click="$emit('gangFromDiscard')"><b>杠</b></button>
          <button v-if="actionPrompt.chiOptions?.length" class="action primary" data-action-role="primary" @click="toggleChiPicker"><b>吃</b></button>
          <button v-if="actionPrompt.canHu" class="action hu" data-action-role="major" @click="$emit('hu')"><b>胡</b></button>
          <button class="action pass" data-action-role="danger" @click="$emit('pass')"><b>过</b></button>
        </template>
        <template v-else-if="actionPrompt?.type === 'rob' || actionPrompt?.type === 'hu'">
          <button class="action hu" data-action-role="major" @click="$emit('hu')"><b>胡</b></button>
          <button class="action pass" data-action-role="danger" @click="$emit('pass')"><b>过</b></button>
        </template>
        <template v-else-if="actionPrompt?.type === 'chi'">
          <button class="action primary" data-action-role="primary" @click="toggleChiPicker"><b>吃</b></button>
          <button class="action pass" data-action-role="danger" @click="$emit('pass')"><b>过</b></button>
        </template>
        <template v-else>
          <button v-if="userKongs.length" class="action primary" data-action-role="primary" @click="toggleKongPicker"><b>{{ kongPickerOpen ? '取消' : '杠' }}</b></button>
          <button v-if="userHasWindKong" class="action primary" data-action-role="primary" @click="$emit('windKong')"><b>风杠</b></button>
          <button v-if="userCanHu" class="action hu" data-action-role="major" @click="$emit('hu')"><b>胡</b></button>
          <button v-if="bloodFlow && userCanHu" class="action pass" data-action-role="danger" @click="$emit('pass')"><b>过</b></button>
        </template>
      </div>
      <button
        v-if="showAutoPlay" class="action autoplay-action" :class="{ active: autoPlay }" data-action-role="secondary"
        :aria-pressed="autoPlay" :aria-label="autoPlay ? '取消机器人托管，恢复手动操作' : '开启机器人托管，自动出牌与过牌'"
        :title="autoPlay ? '机器人托管中：点击恢复手动' : '点击机器人托管：到您的回合自动出牌/过牌'"
        @click="$emit('toggleAutoPlay')"
      ><b>托管</b></button>
      <div v-if="(isUserTurn || actionPrompt) && turnSeconds > 0" class="turn-timer" :class="{ 'prompt-timer': actionPrompt }"><span>{{ turnSeconds }}</span></div>
    </div>
    <div v-if="activeWaits && waitsOpen" class="waiting-tip compact-waiting-tip" :class="{ 'blood-flow-waiting-tip': bloodFlow }">
      <div v-if="bloodFlow" class="blood-flow-wait-grid" :style="{ gridTemplateColumns: `repeat(${Math.min(4, bloodFlowWaitTiles.length) || 1}, minmax(0, 1fr))` }">
        <div v-for="item in bloodFlowWaitTiles" :key="item.tile" class="blood-flow-wait-tile" :class="{ exhausted: item.remaining === 0 }"
          :aria-label="`${tileName(item.tile)}，自摸预估${item.multiplier ?? '未知'}倍，剩余${item.remaining}张`">
          <MahjongTile :tile="item.tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" small disabled />
          <span class="wait-multiplier">{{ item.multiplier ?? '—' }}倍</span>
          <span class="wait-remaining">{{ item.remaining }}张</span>
        </div>
      </div>
      <template v-else-if="activeWaits.any"><strong>听任意</strong><em>{{ activeWaits.remaining }}张</em></template>
      <template v-else><div class="waiting-tiles"><div v-for="item in activeWaits.tiles" :key="item.tile"><MahjongTile :tile="item.tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" small disabled /><small>{{ item.remaining }}张</small></div></div></template>
    </div>

    <Transition name="modal">
      <div v-if="kongPickerOpen && userKongs.length" class="result-backdrop kong-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="kong-picker-title" @click.self="kongPickerOpen = false">
        <section class="result-card kong-picker-card"><h2 id="kong-picker-title">请选择想要杠的牌</h2><div class="kong-picker-tiles"><MahjongTile v-for="tile in userKongs" :key="tile" :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" class="kong-picker-tile" @choose="chooseKong(tile)" /></div></section>
      </div>
    </Transition>
    <Transition name="modal">
      <div v-if="chiPickerOpen && actionPrompt?.chiOptions?.length" class="result-backdrop kong-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="chi-picker-title" @click.self="chiPickerOpen = false">
        <section class="result-card kong-picker-card">
          <h2 id="chi-picker-title">请选择吃牌组合</h2>
          <div class="kong-picker-tiles chi-picker-options">
            <button v-for="(option, chiIndex) in actionPrompt.chiOptions" :key="chiIndex" class="chi-picker-option" @click="chooseChi(chiIndex)">
              <MahjongTile v-for="tile in option.tiles" :key="tile" :tile="tile" :joker-tiles="jokerTiles" :wildcard-tiles="wildcardTiles" :theme-name="themeName" small disabled />
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.game-table-hud { display: contents; }
.blood-flow-preview { display: grid; gap: 2px; max-width: min(320px, 40vw); padding: 6px 9px; border: 1px solid var(--theme-accent, #cfb97a); border-radius: 8px; background: rgba(12, 22, 24, .94); color: #fff5dc; font-size: 12px; }
.blood-flow-preview small { color: #c9d5d6; font-size: 10px; }
.blood-flow-waiting-tip { max-height: min(320px, 55vh); align-items: flex-start; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; }
.blood-flow-wait-grid { display: grid; gap: 12px 14px; }
.blood-flow-wait-tile { display: grid; justify-items: center; align-content: start; font-size: 13px; line-height: 1.3; font-variant-numeric: tabular-nums; }
.blood-flow-wait-tile .mahjong-tile.small { --tile-width: 44px; margin-bottom: 4px; }
.wait-multiplier { color: var(--theme-accent); font-weight: 800; }
.wait-remaining { color: var(--theme-text); }
.blood-flow-wait-tile.exhausted { opacity: .5; }
.waiting-action .blood-flow-ting-label { font-size: 18px; color: var(--theme-accent); white-space: nowrap; }
@media (max-width: 900px), (max-height: 500px) {
  .blood-flow-wait-grid { gap: 8px 10px; }
  .blood-flow-wait-tile { font-size: 11px; }
  .blood-flow-wait-tile .mahjong-tile.small { --tile-width: 30px; margin-bottom: 2px; }
}
.blood-flow-pile-badge { position: relative; display: block; flex-shrink: 0; max-width: 100%; min-height: 24px; padding: 3px 7px; margin-top: 2px; border: 1px solid color-mix(in srgb, var(--theme-accent) 40%, transparent); border-radius: 5px; background: color-mix(in srgb, var(--theme-accent) 10%, transparent); color: var(--theme-text); font-size: 12px; font-weight: 700; line-height: 1.2; white-space: nowrap; cursor: pointer; }
.blood-flow-pile-badge { pointer-events: auto; background: var(--theme-panel); }
.blood-flow-pile-badge:hover { border-color: var(--theme-accent); }
.blood-flow-pile-badge:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: 2px; }
@container (max-width: 900px) or (max-height: 500px) {
  .blood-flow-pile-badge { font-size: 10px; padding: 3px 4px; min-height: 22px; }
  .blood-flow-pile-badge { position: absolute; top: 4px; right: calc(100% + 4px); margin: 0; max-width: none; }
  .win-count-left, .win-count-bottom { left: calc(100% + 4px); right: auto; }
  .win-count-right { top: auto; bottom: 4px; }
  .blood-flow-table .hand-rack :deep(.mahjong-tile) { --tile-width: clamp(24px, 5.2vw, 40px); }
  .blood-flow-table .hand-tile-slot { min-width: 0; }
  .blood-flow-table .hand-rack:not(.has-melds) { justify-content: flex-end; padding-left: 0; padding-right: 0; }
}

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
@media (hover: none) and (pointer: coarse) and (orientation: landscape) {
  .flip-indicator {
    top: calc(var(--safe-top) + var(--topbar-height) + var(--hud-gap));
    right: auto;
    left: calc(var(--safe-left) + 8px);
    box-sizing: border-box;
    min-width: 44px;
    min-height: 44px;
    max-width: calc(100cqw - var(--safe-left) - var(--safe-right) - 16px);
    gap: 2px;
    padding: 3px 6px;
    border-radius: 8px;
  }
  .flip-indicator-head { min-width: 0; flex-wrap: nowrap; gap: 3px; }
  .flip-indicator-head > span { font-size: 12px; letter-spacing: 1px; }
  .flip-indicator-head > .mahjong-tile.small {
    --tile-width: clamp(18px, 4.8vw, 22px);
    top: 0;
  }
  .flip-indicator-head > em { flex: 0 0 auto; font-size: 11px; white-space: nowrap; }
  .flip-chevron { display: block; }
  .flip-indicator-body { display: none; }
  .flip-open .flip-indicator-body {
    display: grid;
    gap: 3px;
  }
  .joker-guide { font-size: 10px; }
  .joker-guide div { max-width: 150px; white-space: normal; }
}

/* 平板（≥1024×768）：翻精指示牌回到桌面「常显完整卡片、不折叠」 */
@container (min-width: 1024px) and (min-height: 768px) {
  .flip-indicator {
    top: 50px;
    right: 18px;
    left: auto;
    min-width: 0;
    min-height: 0;
    max-width: none;
    gap: 5px;
    padding: 6px 10px;
    border-radius: 10px;
  }
  .flip-indicator-head > span { font-size: 14px; letter-spacing: 2px; }
  .flip-indicator-head > .mahjong-tile.small { --tile-width: clamp(20px, 2.15vw, 33px); }
  .flip-indicator-head > em { font-size: 13px; }
  .flip-chevron { display: none; }
  .flip-indicator-body { display: grid; }
  .joker-guide { font-size: 11px; }
  .joker-guide div { max-width: none; white-space: nowrap; }
}

.chi-option-tiles { display: inline-flex; gap: 2px; margin-left: 4px; vertical-align: middle; }
.blood-flow-table .flip-indicator-body { display: none; }
.blood-flow-table .flip-open .flip-indicator-body { display: grid; }
.blood-flow-table .flip-chevron { display: block; width: 5px; height: 5px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg); margin: 0 3px 3px; }
.blood-flow-table .flip-open .flip-chevron { transform: rotate(225deg); }
.blood-flow-table .flip-indicator-head > .mahjong-tile.small { --tile-width: 24px; }
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
