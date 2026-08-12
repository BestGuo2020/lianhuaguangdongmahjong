<script setup lang="ts">
import type { RoomSeatState } from '../../game/online/api/roomApi'

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
}

defineProps<Props>()
defineEmits<{
  copy: []
  toggleReady: []
  start: []
  leave: []
  close: []
}>()
</script>

<template>
  <div class="room-panel">
    <div class="room-code" title="点击复制房间码" role="button" tabindex="0" @click="$emit('copy')" @keyup.enter="$emit('copy')">
      房间码 <strong>{{ roomId }}</strong><span v-if="copied" class="room-code-copied">已复制</span>
    </div>
    <div class="room-game-config"><b>{{ matchName }}</b><span>·</span><b>{{ ruleName }}</b></div>
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
        @click="$emit('start')"
      ><b>开始对局</b><span>{{ matchStarting ? '正在打扫房间' : (allOccupiedReady ? '全员已准备' : '等待全员准备') }}</span></button>
    </div>
    <div class="room-actions-row">
      <button class="text-button room-leave" :disabled="leaving || closing" @click="$emit('leave')">{{ leaving ? '离开中…' : '离开房间' }}</button>
      <button v-if="isCreator" class="text-button room-close" :disabled="leaving || closing" @click="$emit('close')">{{ closing ? '关闭中…' : '关闭房间' }}</button>
    </div>
  </div>
</template>
