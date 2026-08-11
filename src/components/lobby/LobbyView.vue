<script setup lang="ts">
import RoomPanel from './RoomPanel.vue'
import type { GameMode } from '../../game/core/activeGamePort'
import type { MatchType } from '../../game/core/types'
import type { RoomMeta, RoomSeatState } from '../../game/online/api/roomApi'
import type { StoredSession } from '../../game/online/session/remoteSessionStore'

interface Props {
  gameMode: GameMode
  selectedMatch: MatchType
  storedSession: StoredSession | null
  roomId: string
  nicknameInput: string
  joinCode: string
  roomMeta: RoomMeta | null
  sessionStatus: string
  sessionError: string
  roomTimeLimit: number | null
  roomSeats: Array<RoomSeatState | null>
  mySeat: number
  isCreator: boolean
  allOccupiedReady: boolean
  matchStarting: boolean
  copied: boolean
  leaving: boolean
  closing: boolean
}

defineProps<Props>()
defineEmits<{
  'update:gameMode': [value: GameMode]
  'update:selectedMatch': [value: MatchType]
  'update:nicknameInput': [value: string]
  'update:joinCode': [value: string]
  startLocal: []
  createRoom: []
  joinRoom: []
  resumeSession: []
  copyRoom: []
  toggleReady: []
  startRemote: []
  leaveRoom: []
  closeRoom: []
  openStats: []
  openRules: []
}>()
</script>

<template>
  <section class="lobby">
    <p class="eyebrow">LINGNAN GUANGDONG MAHJONG</p>
    <h1>莲花<span>广麻</span></h1>
    <p class="subtitle">一款莲花县特有的地方麻将游戏玩法</p>
    <button v-if="storedSession && !roomId" class="continue-session" @click="$emit('resumeSession')">
      ⏵ 继续对局<template v-if="storedSession.roomId">（房间 {{ storedSession.roomId }}）</template>
    </button>
    <div class="mode-selector" role="radiogroup" aria-label="游戏模式">
      <button :class="{ active: gameMode === 'local' }" role="radio" :aria-checked="gameMode === 'local'" @click="$emit('update:gameMode', 'local')"><b>单机对战</b><span>与 AI 同桌</span></button>
      <button :class="{ active: gameMode === 'remote' }" role="radio" :aria-checked="gameMode === 'remote'" @click="$emit('update:gameMode', 'remote')"><b>联机对战</b><span>创建或加入房间</span></button>
    </div>

    <template v-if="gameMode === 'local'">
      <div class="match-selector" role="radiogroup" aria-label="场次选择">
        <button :class="{ active: selectedMatch === 'east' }" role="radio" :aria-checked="selectedMatch === 'east'" @click="$emit('update:selectedMatch', 'east')"><b>东风场</b><span>一场4局（不含连庄）</span></button>
        <button :class="{ active: selectedMatch === 'hanchan' }" role="radio" :aria-checked="selectedMatch === 'hanchan'" @click="$emit('update:selectedMatch', 'hanchan')"><b>半庄场</b><span>一场8局（不含连庄）</span></button>
      </div>
      <button class="start-button" @click="$emit('startLocal')"><b>开始{{ selectedMatch === 'east' ? '东风场' : '半庄场' }}</b><span>四人对局</span></button>
    </template>

    <div v-else class="remote-lobby">
      <label class="remote-field">
        <span>昵称</span>
        <input
          :value="nicknameInput"
          maxlength="12"
          placeholder="输入昵称"
          @input="$emit('update:nicknameInput', ($event.target as HTMLInputElement).value)"
          @keyup.enter="joinCode ? $emit('joinRoom') : $emit('createRoom')"
        />
      </label>
      <p v-if="roomMeta && !roomId" class="room-meta-note" role="status">
        剩余房间 <b>{{ roomMeta.max - roomMeta.active }}</b> / {{ roomMeta.max }}
      </p>
      <div v-if="!roomId" class="match-selector" role="radiogroup" aria-label="场次选择">
        <button :class="{ active: selectedMatch === 'east' }" role="radio" :aria-checked="selectedMatch === 'east'" @click="$emit('update:selectedMatch', 'east')"><b>东风场</b><span>一场4局（不含连庄）</span></button>
        <button :class="{ active: selectedMatch === 'hanchan' }" role="radio" :aria-checked="selectedMatch === 'hanchan'" @click="$emit('update:selectedMatch', 'hanchan')"><b>半庄场</b><span>一场8局（不含连庄）</span></button>
      </div>
      <div class="remote-actions">
        <button class="remote-create" :disabled="!nicknameInput.trim() || sessionStatus === 'creating' || !!roomId" @click="$emit('createRoom')">
          {{ sessionStatus === 'creating' ? '创建中…' : '创建房间' }}
        </button>
        <div class="remote-join">
          <input
            :value="joinCode"
            maxlength="6"
            placeholder="6 位房间码"
            @input="$emit('update:joinCode', ($event.target as HTMLInputElement).value)"
            @keyup.enter="$emit('joinRoom')"
          />
          <button class="remote-join-btn" :disabled="!nicknameInput.trim() || !joinCode.trim() || sessionStatus === 'joining' || !!roomId" @click="$emit('joinRoom')">
            {{ sessionStatus === 'joining' ? '加入中…' : '加入房间' }}
          </button>
        </div>
      </div>
      <p v-if="sessionError" class="session-error" role="alert">{{ sessionError }}</p>

      <RoomPanel
        v-if="roomId"
        :room-id="roomId"
        :room-time-limit="roomTimeLimit"
        :room-seats="roomSeats"
        :my-seat="mySeat"
        :is-creator="isCreator"
        :session-status="sessionStatus"
        :all-occupied-ready="allOccupiedReady"
        :match-starting="matchStarting"
        :copied="copied"
        :leaving="leaving"
        :closing="closing"
        @copy="$emit('copyRoom')"
        @toggle-ready="$emit('toggleReady')"
        @start="$emit('startRemote')"
        @leave="$emit('leaveRoom')"
        @close="$emit('closeRoom')"
      />
    </div>

    <div class="lobby-links">
      <button v-if="gameMode === 'remote'" class="text-button" @click="$emit('openStats')">我的战绩 →</button>
      <button class="text-button" @click="$emit('openRules')">游戏规则 →</button>
      <a class="repository-link" href="https://github.com/BestGuo2020/lianhuaguangdongmahjong" target="_blank" rel="noopener noreferrer" aria-label="在 GitHub 新标签页打开莲花广麻仓库">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.24c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A11 11 0 0 1 12 6.1c.98 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.26c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>
        GitHub ↗
      </a>
    </div>
  </section>
</template>
