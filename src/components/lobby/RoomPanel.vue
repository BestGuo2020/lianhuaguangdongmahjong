<script setup lang="ts">
import { computed, ref } from 'vue'
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

const emptySeats = computed(() => props.roomSeats
  .map((state, index) => (state ? null : index))
  .filter((index): index is number => index !== null))

function startPayload() {
  const llmSeats = Object.entries(picks.value)
    .filter(([, providerId]) => providerId)
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
    <div v-if="isCreator && llmProviders.length" class="room-llm-picks">
      <p class="room-llm-picks-title">空位大模型（服务端提供商）</p>
      <label v-for="seat in emptySeats" :key="seat" class="room-llm-pick">
        <span>空位 {{ seat + 1 }}</span>
        <select
          :value="picks[seat] ?? ''"
          data-testid="room-llm-pick"
          @change="picks[seat] = ($event.target as HTMLSelectElement).value"
        >
          <option value="">服务器默认</option>
          <option v-for="provider in llmProviders" :key="provider.id" :value="provider.id">
            {{ provider.nickname }}（{{ provider.style }}）· {{ provider.name }} {{ provider.model }}
          </option>
        </select>
      </label>
    </div>
    <p v-if="roomTimeLimit" class="room-limit-note">
      房间限时 {{ Math.round(roomTimeLimit / 60) }} 分钟，超时自动解散；房主离开将解散房间。
    </p>
    <div class="room-seats">
      <div v-for="(seat, index) in roomSeats" :key="index" class="room-seat" :class="{ occupied: !!seat }">
        <span class="room-seat-no">{{ index + 1 }}</span>
        <b>{{ seat?.nickname || '等待加入…' }}</b>
        <em v-if="seat?.ready">已准备</em>
        <em v-else-if="seat" class="unready">未准备</em>
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
.room-llm-picks {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px dashed rgba(229, 213, 173, 0.35);
  border-radius: 8px;
}
.room-llm-picks-title {
  margin: 0 0 6px;
  font-size: 12px;
  opacity: 0.75;
}
.room-llm-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 13px;
}
.room-llm-pick select {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(229, 213, 173, 0.35);
  background: rgba(0, 0, 0, 0.3);
  color: #e5d5ad;
}
</style>
