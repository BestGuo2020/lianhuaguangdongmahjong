<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { animeCharacterAvatarUrl } from '../../game/llm/animeCharacterPreference'
import { resolveAnimeCharacter, type CharacterId } from '../../game/llm/animeCharacters'
import {
  isReservationUnavailable,
  pickValue,
  pickValueForSeat,
  reservationFromPick,
  reservedSeatLabel,
  seatLlmState,
  startLlmSeats,
  stylesForProvider,
  type SeatLlmReservation,
} from './roomSeatLlm'
import type { TableThemeName } from '../table/three/tableTheme'
import type {
  LlmProviderInfo,
  LlmSeatRequest,
  RoomSeatState,
  ServerLlmStyle,
} from '../../game/online/api/roomApi'

interface Props {
  roomId: string
  roomTimeLimit: number | null
  /** 服务端房间状态：playing + 本家在房间面板 ⇒ 本家在牌桌上「暂离」。 */
  roomStatus?: string
  roomSeats: Array<RoomSeatState | null>
  /**
   * 房主预留的空位（大模型专属，真人不可加入）；未列入的空位「自动选择」= 真人可占。
   * 服务端真值，随房间信息轮询刷新。
   */
  reservedSeats: Array<LlmSeatRequest>
  mySeat: number
  isCreator: boolean
  sessionStatus: string
  allOccupiedReady: boolean
  matchStarting: boolean
  copied: boolean
  leaving: boolean
  closing: boolean
  matchName: string
  ruleName: string
  /** 房主请求的空座 AI 补位是否使用大模型 */
  llmEnabled: boolean
  /** 实际生效（请求 && 服务端配置齐全） */
  effectiveLlmEnabled: boolean
  /** 服务端是否配置了大模型 */
  llmAvailable: boolean
  /** 服务端注册的提供商（不含 key），房主为空位选择 */
  llmProviders: Array<LlmProviderInfo>
  /** 当前牌桌主题（二次元主题下在房间内选本家形象） */
  tableThemeName: TableThemeName
  /** 本家当前选择的二次元角色 */
  characterId: CharacterId
}

const props = defineProps<Props>()
const robotIconUrl = `${import.meta.env.BASE_URL}img/robot.svg`
const emit = defineEmits<{
  copy: []
  toggleReady: []
  start: [payload: { llmSeats: Array<LlmSeatRequest> }]
  /** 房主改选空位模型（providerId 为空 = 取消预留，该座放开给真人）。 */
  reserveSeat: [payload: SeatLlmReservation]
  leave: []
  close: []
  resume: []
  leaveMatch: []
  openCharacter: []
  'update:characterId': [value: CharacterId]
}>()
/** 本场进行中且本家在房间面板 ⇒ 本家已「暂离」牌桌（座位保留，服务端 AI 代打）。 */
const awayFromTable = computed(() => props.roomStatus === 'playing' && props.mySeat >= 0)
const currentCharacter = computed(() => resolveAnimeCharacter(props.characterId))
const currentCharacterAvatar = computed(() => animeCharacterAvatarUrl(props.characterId))

/** 已预留的空位数量（面板提示用）。 */
const reservedCount = computed(() => props.reservedSeats.filter(
  (item) => props.roomSeats[item.seat] == null).length)

const seatState = (seat: number) => seatLlmState(seat, props.roomSeats, props.reservedSeats)

function reservedAt(seat: number) {
  return props.reservedSeats.find((item) => item.seat === seat) ?? null
}

function pickValueAt(seat: number) {
  return pickValueForSeat(seat, props.reservedSeats, props.llmProviders)
}

/**
 * 待定选择：房主刚改了下拉框、服务端响应还没回来时的乐观值。
 * 服务端预留列表一变（写成功，或写失败后回读房间真值）就清空 → 值重新以服务端为准，
 * 因此写失败时下拉框不会停在服务端并未接受的选项上。
 */
const pendingPicks = ref<Record<number, string>>({})
watch(() => props.reservedSeats, () => { pendingPicks.value = {} })

function selectValueAt(seat: number) {
  return pendingPicks.value[seat] ?? pickValueAt(seat)
}

function reservedLabel(seat: number) {
  const reserved = reservedAt(seat)
  return reserved ? reservedSeatLabel(reserved, props.llmProviders) : ''
}

/** 预留的模型已不在服务端注册表：给房主一个可见选项，便于改回「自动选择」。 */
function unavailableReservation(seat: number) {
  const reserved = reservedAt(seat)
  return reserved ? isReservationUnavailable(reserved, props.llmProviders) : false
}

function onPickChange(seat: number, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  pendingPicks.value = { ...pendingPicks.value, [seat]: value }
  emit('reserveSeat', reservationFromPick(seat, value))
}

function startPayload() {
  if (!props.effectiveLlmEnabled) return { llmSeats: [] }
  return { llmSeats: startLlmSeats(props.roomSeats, props.reservedSeats) }
}
</script>

<template>
  <div class="room-panel">
    <div
      class="room-code"
      title="点击复制房间码"
      role="button"
      tabindex="0"
      :aria-label="`复制房间码 ${roomId}`"
      @click="$emit('copy')"
      @keyup.enter="$emit('copy')"
    >
      <span class="room-code-label">房间码</span>
      <strong>{{ roomId }}</strong>
      <span class="room-code-copied" :class="{ visible: copied }" aria-live="polite">已复制</span>
    </div>
    <div class="room-game-config"><b>{{ matchName }}</b><span>·</span><b>{{ ruleName }}</b></div>
    <p v-if="effectiveLlmEnabled" class="room-llm-note on">
      <img :src="robotIconUrl" alt="" aria-hidden="true">空位由大模型代打
    </p>
    <p v-else-if="llmEnabled && !llmAvailable" class="room-llm-note off">
      已请求大模型补位，但服务器未配置（空位将由普通 AI 代打）
    </p>
    <p v-if="reservedCount" class="room-llm-note reserved" data-testid="room-llm-reserved-note">
      <img :src="robotIconUrl" alt="" aria-hidden="true">已预留 {{ reservedCount }} 个空位给大模型（真人不可加入；改回「自动选择」即放开）
    </p>
    <p v-if="roomTimeLimit" class="room-limit-note">
      房间限时 {{ Math.round(roomTimeLimit / 60) }} 分钟，超时自动解散；房主离开将顺延房主，全员离开或房主关闭才会解散。
    </p>
    <button
      v-if="tableThemeName === 'llmAnime'"
      type="button"
      class="room-character-entry"
      data-action-role="secondary"
      @click="$emit('openCharacter')"
    >
      <img :src="currentCharacterAvatar" alt="" aria-hidden="true">
      <span><small>本家形象</small><b>{{ currentCharacter.label }}</b></span>
      <em>更换 ›</em>
    </button>
    <div class="room-seats">
      <div
        v-for="(seat, index) in roomSeats"
        :key="index"
        class="room-seat"
        :class="{
          occupied: !!seat,
          'llm-planned': !seat && effectiveLlmEnabled,
          'llm-reserved': seatState(index).kind === 'reserved',
        }"
        :data-seat-state="seatState(index).kind"
      >
        <span class="room-seat-no">{{ index + 1 }}</span>
        <template v-if="seat">
          <b>{{ seat.nickname }}</b>
          <em v-if="seat.ready">已准备</em>
          <em v-else class="unready">未准备</em>
        </template>
        <span
          v-else-if="isCreator && effectiveLlmEnabled && llmProviders.length"
          class="room-seat-provider-wrap"
        >
          <img :src="robotIconUrl" alt="" aria-hidden="true">
          <select
            class="room-seat-provider"
            :class="{ reserved: seatState(index).kind === 'reserved' }"
            :value="selectValueAt(index)"
            :aria-label="seatState(index).kind === 'reserved'
              ? `空位 ${index + 1} 已预留给大模型，改回自动选择即放开给真人`
              : `空位 ${index + 1} 大模型提供商`"
            data-testid="room-llm-pick"
            @change="onPickChange(index, $event)"
          >
            <option value="">自动选择（真人可占）</option>
            <option
              v-if="unavailableReservation(index)"
              :value="pickValueAt(index)"
            >{{ reservedLabel(index) }}</option>
            <template v-for="provider in llmProviders" :key="provider.id">
              <option
                v-for="style in stylesForProvider(provider)"
                :key="`${provider.id}-${style}`"
                :value="pickValue(provider.id, style)"
              >
                {{ provider.nickname }}（{{ style }}）· {{ provider.model }}
              </option>
            </template>
          </select>
        </span>
        <span
          v-else-if="seatState(index).kind === 'reserved'"
          class="room-seat-reserved"
        >已预留给 {{ reservedLabel(index) }}</span>
        <b v-else-if="effectiveLlmEnabled">大模型补位</b>
        <b v-else>等待加入…</b>
      </div>
    </div>
    <!-- 暂离状态：本场进行中，本家已离开牌桌（座位保留、服务端 AI 代打），可一键回桌。 -->
    <p v-if="awayFromTable" class="room-away-note" role="status">本场进行中 · 你在暂离（AI 代打中，座位与重进码保留）</p>
    <div v-if="awayFromTable" class="room-owner-actions">
      <button class="start-button room-start" data-action-role="primary" @click="$emit('resume')">
        <b>回到牌桌</b><span>恢复原座位，继续本场</span>
      </button>
      <button class="text-button" data-action-role="light" @click="$emit('leaveMatch')">退出本场（回主大厅，可再回来）</button>
    </div>
    <div v-else class="room-owner-actions">
      <button v-if="mySeat >= 0" class="secondary" data-action-role="primary" :disabled="sessionStatus === 'readying'" @click="$emit('toggleReady')">准备 / 取消准备</button>
      <button
        v-if="isCreator"
        class="start-button room-start"
        :data-action-role="allOccupiedReady ? 'primary' : 'disabled'"
        :disabled="!allOccupiedReady || matchStarting"
        @click="$emit('start', startPayload())"
      ><b>开始对局</b><span>{{ matchStarting ? '正在打扫房间' : (allOccupiedReady ? '全员已准备' : '等待全员准备') }}</span></button>
    </div>
    <div class="room-actions-row">
      <button class="text-button room-leave" data-action-role="danger" :disabled="leaving || closing" @click="$emit('leave')">{{ leaving ? '离开中…' : '离开房间' }}</button>
      <button v-if="isCreator" class="text-button room-close" data-action-role="danger" :disabled="leaving || closing" @click="$emit('close')">{{ closing ? '关闭中…' : '关闭房间' }}</button>
    </div>
  </div>
</template>

<style scoped>
.room-away-note {
  margin: 0 0 8px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-accent, #e6c482) 45%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--theme-accent, #e6c482) 10%, transparent);
  color: var(--theme-text, #fff2d9);
  font-size: 12px;
  text-align: center;
}

.room-llm-note {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.5;
}
.room-llm-note img { width: 18px; height: 18px; }
.room-llm-note.on { color: #4caf50; }
.room-llm-note.off { color: #e6a23c; }
/* 预留提示与「空位由大模型代打」区分开：预留是房主显式锁定，真人进不来。 */
.room-llm-note.reserved {
  justify-content: flex-start;
  padding: 6px 9px;
  border: 1px solid color-mix(in srgb, var(--theme-accent, #e6c482) 40%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--theme-accent, #e6c482) 9%, transparent);
  color: var(--theme-accent, #e6c482);
  font-size: 12px;
  text-align: left;
}
.room-character-entry { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; padding: 5px 8px; border: 1px solid color-mix(in srgb, var(--theme-border) 38%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--theme-panel-elevated) 72%, transparent); color: var(--theme-text); text-align: left; cursor: pointer; }
.room-character-entry img { width: 32px; height: 32px; border-radius: 8px 8px 3px 3px; object-fit: cover; background: var(--theme-surface); }
.room-character-entry span { display: grid; min-width: 0; }
.room-character-entry small { color: var(--theme-text-muted); font-size: 9px; }
.room-character-entry b { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.room-character-entry em { color: var(--theme-accent); font-size: 10px; font-style: normal; }
.room-seat.llm-planned {
  border-color: color-mix(in srgb, var(--theme-positive) 42%, transparent);
  background: color-mix(in srgb, var(--theme-positive) 10%, var(--theme-panel));
  color: var(--theme-positive);
}
.room-seat.llm-planned .room-seat-no {
  background: color-mix(in srgb, var(--theme-positive) 20%, transparent);
  color: var(--theme-text);
}
/* 已预留给大模型的空位：真人不可加入（与「大模型补位」的自动档区分开）。 */
.room-seat.llm-reserved {
  border-color: color-mix(in srgb, var(--theme-accent, #e6c482) 55%, transparent);
  background: color-mix(in srgb, var(--theme-accent, #e6c482) 12%, var(--theme-panel));
  color: var(--theme-accent, #e6c482);
}
.room-seat.llm-reserved .room-seat-no {
  background: color-mix(in srgb, var(--theme-accent, #e6c482) 26%, transparent);
  color: var(--theme-text);
}
.room-seat-reserved {
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.room-seat-provider.reserved { color: var(--theme-accent, #e6c482); }
.room-seat-provider {
  flex: 1;
  width: 100%;
  min-width: 0;
  padding: 5px 4px;
  overflow: hidden;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--theme-text);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  color-scheme: dark;
  cursor: pointer;
}
.room-seat-provider-wrap {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 5px;
}
.room-seat-provider-wrap > img {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
}
.room-seat-provider:focus-visible {
  border-radius: 4px;
  box-shadow: 0 0 0 2px var(--theme-accent);
}
.room-seat-provider option {
  background: var(--theme-panel);
  color: var(--theme-text);
}
</style>
