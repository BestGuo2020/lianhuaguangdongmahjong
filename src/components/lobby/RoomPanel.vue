<script setup lang="ts">
import { computed, ref } from 'vue'
import { animeCharacterAvatarUrl } from '../../game/llm/animeCharacterPreference'
import { resolveAnimeCharacter, type CharacterId } from '../../game/llm/animeCharacters'
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

/** 空位（座位号升序）→ 选择的提供商 id（'' = 服务器默认） */
const picks = ref<Record<number, string>>({})

const ALL_STYLES: ServerLlmStyle[] = ['激进', '稳健', '话痨', '高冷']
const PICK_SEPARATOR = '::'

function stylesFor(provider: LlmProviderInfo): ServerLlmStyle[] {
  return provider.styles?.length ? provider.styles : (
    ALL_STYLES.includes(provider.style) ? ALL_STYLES : ['稳健']
  )
}

function pickValue(providerId: string, style: ServerLlmStyle): string {
  return `${providerId}${PICK_SEPARATOR}${style}`
}

function parsePick(seat: number, value: string): LlmSeatRequest | null {
  const separator = value.lastIndexOf(PICK_SEPARATOR)
  if (separator <= 0) return null
  const providerId = value.slice(0, separator)
  const style = value.slice(separator + PICK_SEPARATOR.length) as ServerLlmStyle
  if (!providerId || !ALL_STYLES.includes(style)) return null
  return { seat, providerId, style }
}

function startPayload() {
  if (!props.effectiveLlmEnabled) return { llmSeats: [] }
  const llmSeats = Object.entries(picks.value)
    .filter(([seat, providerId]) => providerId && props.roomSeats[Number(seat)] == null)
    .map(([seat, value]) => parsePick(Number(seat), value))
    .filter((item): item is LlmSeatRequest => item !== null)
  return { llmSeats }
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
        :class="{ occupied: !!seat, 'llm-planned': !seat && effectiveLlmEnabled }"
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
            :value="picks[index] ?? ''"
            :aria-label="`空位 ${index + 1} 大模型提供商`"
            data-testid="room-llm-pick"
            @change="picks[index] = ($event.target as HTMLSelectElement).value"
          >
            <option value="">自动选择</option>
            <template v-for="provider in llmProviders" :key="provider.id">
              <option
                v-for="style in stylesFor(provider)"
                :key="`${provider.id}-${style}`"
                :value="pickValue(provider.id, style)"
              >
                {{ provider.nickname }}（{{ style }}）· {{ provider.model }}
              </option>
            </template>
          </select>
        </span>
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
