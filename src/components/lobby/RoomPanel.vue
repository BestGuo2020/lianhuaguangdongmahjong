<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LobbySeat } from '../../game/online/vibe/vibeLobby'
import type { HostLlmOption, HostLlmSeatSelection, PublicAiSeat } from '../../game/online/vibe/vibeLlm'
import AnimeCharacterPicker from '../llm/AnimeCharacterPicker.vue'
import type { CharacterId } from '../../game/llm/animeCharacters'
import type { TableThemeName } from '../table/three/tableTheme'

interface Props {
  roomId: string
  roomTimeLimit: number | null
  roomSeats: LobbySeat[]
  aiSeats: PublicAiSeat[]
  llmOptions: HostLlmOption[]
  mySeat: number
  isHost: boolean
  sessionStatus: string
  allOccupiedReady: boolean
  matchStarting: boolean
  copied: boolean
  leaving: boolean
  closing: boolean
  matchName: string
  ruleName: string
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
  start: []
  configureAiSeats: [selections: HostLlmSeatSelection[]]
  leave: []
  close: []
  'update:characterId': [value: CharacterId]
}>()

const PICK_SEPARATOR = '::'
const picks = ref<Record<number, string>>({})
const selectedPickCount = computed(() => Object.values(picks.value).filter(Boolean).length)

function pickDisabled(seat: number): boolean {
  return !picks.value[seat] && selectedPickCount.value >= 2
}

function optionValue(option: HostLlmOption): string {
  return `${option.presetId}${PICK_SEPARATOR}${option.style}`
}

function selectedSeats(): HostLlmSeatSelection[] {
  const occupied = new Set(props.roomSeats.map((seat) => seat.seat))
  return Object.entries(picks.value).flatMap(([rawSeat, value]) => {
    const seat = Number(rawSeat)
    const split = value.lastIndexOf(PICK_SEPARATOR)
    if (occupied.has(seat) || seat < 1 || seat > 3 || split <= 0) return []
    const option = props.llmOptions.find((candidate) => optionValue(candidate) === value)
    if (!option) return []
    return [{ seat: seat as 1 | 2 | 3, presetId: option.presetId, style: option.style }]
  })
}

function changePick(seat: number, value: string) {
  picks.value = { ...picks.value, [seat]: value }
  emit('configureAiSeats', selectedSeats())
}

watch(
  () => props.roomSeats.map((seat) => seat.seat).join(','),
  () => { if (props.isHost) emit('configureAiSeats', selectedSeats()) },
)

function humanAt(seat: number): LobbySeat | undefined {
  return props.roomSeats.find((item) => item.seat === seat)
}

function aiAt(seat: number): PublicAiSeat | undefined {
  return props.aiSeats.find((item) => item.seat === seat)
}
</script>

<template>
  <div class="room-panel">
    <div class="room-code" title="点击复制房间码" role="button" tabindex="0" @click="$emit('copy')" @keyup.enter="$emit('copy')">
      房间码 <strong>{{ roomId }}</strong><span v-if="copied" class="room-code-copied">已复制</span>
    </div>
    <div class="room-game-config"><b>{{ matchName }}</b><span>·</span><b>{{ ruleName }}</b></div>
    <p v-if="aiSeats.length" class="room-llm-note">
      <img :src="robotIconUrl" alt="" aria-hidden="true">大模型由房主浏览器运行，空位仍可由真人加入
    </p>
    <p v-if="roomTimeLimit" class="room-limit-note">
      房间限时 {{ Math.round(roomTimeLimit / 60) }} 分钟，超时自动解散；房主离开将解散房间。
    </p>
    <div class="room-seats">
      <div
        v-for="seatIndex in 4"
        :key="seatIndex - 1"
        class="room-seat"
        :class="{ occupied: !!humanAt(seatIndex - 1), 'llm-planned': !!aiAt(seatIndex - 1) }"
      >
        <span class="room-seat-no">{{ seatIndex }}</span>
        <template v-if="humanAt(seatIndex - 1)">
          <b>{{ humanAt(seatIndex - 1)?.nickname }}</b>
          <em v-if="humanAt(seatIndex - 1)?.ready">已准备</em>
          <em v-else class="unready">未准备</em>
        </template>
        <span v-else-if="isHost && seatIndex > 1" class="room-seat-provider-wrap">
          <img :src="aiAt(seatIndex - 1)?.avatar || robotIconUrl" alt="" aria-hidden="true">
          <select
            class="room-seat-provider"
            :value="picks[seatIndex - 1] ?? ''"
            :disabled="pickDisabled(seatIndex - 1)"
            :aria-label="`空位 ${seatIndex} AI 选择`"
            data-testid="room-llm-pick"
            @change="changePick(seatIndex - 1, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">普通 AI（空位补位）</option>
            <option
              v-for="option in llmOptions"
              :key="`${option.presetId}-${option.style}`"
              :value="optionValue(option)"
            >
              {{ option.displayName }} · {{ option.model }}
            </option>
          </select>
        </span>
        <span v-else-if="aiAt(seatIndex - 1)" class="room-seat-ai-view">
          <img :src="aiAt(seatIndex - 1)?.avatar" alt="" aria-hidden="true">
          <b>{{ aiAt(seatIndex - 1)?.displayName }}</b>
          <small>{{ aiAt(seatIndex - 1)?.model }}</small>
        </span>
        <b v-else>等待加入…</b>
      </div>
    </div>
    <p v-if="isHost && llmOptions.length" class="room-ai-hint">大模型座位将被预留；为保证至少 2 名真人，最多选择 2 席。</p>
    <p v-if="isHost && !llmOptions.length" class="room-ai-hint">未启用可用的大模型预置，空位将使用普通 AI。</p>
    <AnimeCharacterPicker
      v-if="tableThemeName === 'llmAnime'"
      :model-value="characterId"
      @update:model-value="$emit('update:characterId', $event)"
    />
    <div class="room-owner-actions">
      <button v-if="mySeat >= 0" class="secondary" :disabled="sessionStatus === 'readying'" @click="$emit('toggleReady')">准备 / 取消准备</button>
      <button
        v-if="isHost"
        class="start-button room-start"
        :disabled="!allOccupiedReady || matchStarting"
        @click="$emit('start')"
      ><b>开始对局</b><span>{{ matchStarting ? '正在打扫房间' : (roomSeats.length < 2 ? '至少需要 2 名玩家' : (allOccupiedReady ? '全员已准备' : '等待全员准备')) }}</span></button>
    </div>
    <div class="room-actions-row">
      <button class="text-button room-leave" :disabled="leaving || closing" @click="$emit('leave')">{{ leaving ? '离开中…' : '离开房间' }}</button>
      <button v-if="isHost" class="text-button room-close" :disabled="leaving || closing" @click="$emit('close')">{{ closing ? '关闭中…' : '关闭房间' }}</button>
    </div>
  </div>
</template>

<style scoped>
.room-llm-note,
.room-ai-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 0 0 8px;
  color: #91caa2;
  font-size: 12px;
}
.room-llm-note img { width: 18px; height: 18px; }
.room-ai-hint { color: #9ea99e; }
.room-seat.llm-planned {
  border-color: rgba(91, 190, 126, 0.4);
  background: linear-gradient(100deg, rgba(38, 102, 67, 0.2), rgba(2, 12, 9, 0.62));
}
.room-seat-provider-wrap,
.room-seat-ai-view {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 6px;
}
.room-seat-provider-wrap > img,
.room-seat-ai-view > img {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 50%;
  object-fit: cover;
}
.room-seat-provider {
  flex: 1;
  width: 100%;
  min-width: 0;
  padding: 6px 4px;
  border: 0;
  outline: 0;
  background: transparent;
  color: #e4eadf;
  color-scheme: dark;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  cursor: pointer;
}
.room-seat-provider option { background: #07150f; color: #e8ddc4; }
.room-seat-provider:disabled { opacity: 0.48; cursor: not-allowed; }
.room-seat-ai-view { flex-wrap: wrap; }
.room-seat-ai-view b { flex: 1; min-width: 0; }
.room-seat-ai-view small { width: 100%; padding-left: 30px; color: #91a493; font-size: 10px; }
</style>
