<script setup lang="ts">
import { ref } from 'vue'
import type { LlmProviderInfo, LlmSeatRequest, RoomSeatState } from '../../game/online/api/roomApi'

interface Props {
  roomId: string
  roomTimeLimit: number | null
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
}

const props = defineProps<Props>()
const emit = defineEmits<{
  copy: []
  toggleReady: []
  start: [payload: { llmSeats: Array<LlmSeatRequest> }]
  leave: []
  close: []
}>()

/** 空位（座位号升序）→ 选择的提供商 id（'' = 服务器默认） */
const picks = ref<Record<number, string>>({})

function startPayload() {
  if (!props.effectiveLlmEnabled) return { llmSeats: [] }
  const llmSeats = Object.entries(picks.value)
    .filter(([seat, providerId]) => providerId && props.roomSeats[Number(seat)] == null)
    .map(([seat, providerId]) => ({ seat: Number(seat), providerId }))
  return { llmSeats }
}
</script>

<template>
  <div class="room-panel">
    <div class="room-code" title="点击复制房间码" role="button" tabindex="0" @click="$emit('copy')" @keyup.enter="$emit('copy')">
      房间码 <strong>{{ roomId }}</strong><span v-if="copied" class="room-code-copied">已复制</span>
    </div>
    <div class="room-game-config"><b>{{ matchName }}</b><span>·</span><b>{{ ruleName }}</b></div>
    <p v-if="effectiveLlmEnabled" class="room-llm-note on">🤖 空位由大模型代打</p>
    <p v-else-if="llmEnabled && !llmAvailable" class="room-llm-note off">
      已请求大模型补位，但服务器未配置（空位将由普通 AI 代打）
    </p>
    <p v-if="roomTimeLimit" class="room-limit-note">
      房间限时 {{ Math.round(roomTimeLimit / 60) }} 分钟，超时自动解散；房主离开将解散房间。
    </p>
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
        <select
          v-else-if="isCreator && effectiveLlmEnabled && llmProviders.length"
          class="room-seat-provider"
          :value="picks[index] ?? ''"
          :aria-label="`空位 ${index + 1} 大模型提供商`"
          data-testid="room-llm-pick"
          @change="picks[index] = ($event.target as HTMLSelectElement).value"
        >
          <option value="">🤖 自动选择</option>
          <option v-for="provider in llmProviders" :key="provider.id" :value="provider.id">
            {{ provider.nickname }}（{{ provider.style }}）· {{ provider.model }}
          </option>
        </select>
        <b v-else-if="effectiveLlmEnabled">大模型补位</b>
        <b v-else>等待加入…</b>
      </div>
    </div>
    <div class="room-owner-actions">
      <button v-if="mySeat >= 0" class="secondary" :disabled="sessionStatus === 'readying'" @click="$emit('toggleReady')">准备 / 取消准备</button>
      <button
        v-if="isCreator"
        class="start-button room-start"
        :disabled="!allOccupiedReady || matchStarting"
        @click="$emit('start', startPayload())"
      ><b>开始对局</b><span>{{ matchStarting ? '正在打扫房间' : (allOccupiedReady ? '全员已准备' : '等待全员准备') }}</span></button>
    </div>
    <div class="room-actions-row">
      <button class="text-button room-leave" :disabled="leaving || closing" @click="$emit('leave')">{{ leaving ? '离开中…' : '离开房间' }}</button>
      <button v-if="isCreator" class="text-button room-close" :disabled="leaving || closing" @click="$emit('close')">{{ closing ? '关闭中…' : '关闭房间' }}</button>
    </div>
  </div>
</template>

<style scoped>
.room-llm-note {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.5;
}
.room-llm-note.on { color: #4caf50; }
.room-llm-note.off { color: #e6a23c; }
.room-seat.llm-planned {
  border-color: rgba(91, 190, 126, 0.34);
  background: linear-gradient(100deg, rgba(38, 102, 67, 0.16), rgba(2, 12, 9, 0.62));
  color: #94cda4;
}
.room-seat.llm-planned .room-seat-no {
  background: rgba(91, 190, 126, 0.2);
  color: #b8dfbd;
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
  color: #d8e7d8;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  cursor: pointer;
}
.room-seat-provider:focus-visible {
  border-radius: 4px;
  box-shadow: 0 0 0 1px rgba(115, 207, 142, 0.55);
}
.room-seat-provider option {
  background: #07150f;
  color: #e8ddc4;
}
</style>
