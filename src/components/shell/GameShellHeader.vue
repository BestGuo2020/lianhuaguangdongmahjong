<script setup lang="ts">
import { computed } from 'vue'
import { BASE_SCORE } from '../../game/core/rules/rules'
import type { GameMode } from '../../game/core/contracts/activeGamePort'
import type { GamePhase } from '../../game/core/contracts/gamePort'

interface Props {
  gameMode: GameMode
  phase: GamePhase
  hasPlayers: boolean
  matchName: string
  roundLabel: string
  honba: number
  roomId: string
  signalQuality: number
  soundOn: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  quit: []
  toggleSound: []
  openRules: []
}>()

const imageBase = `${import.meta.env.BASE_URL}img/`
const signalText = computed(() => (
  { 0: '网络不稳定', 1: '网络波动', 2: '网络良好', 3: '网络流畅' }[props.signalQuality] ?? ''
))
</script>

<template>
  <header class="top-bar">
    <div class="brand-mini"><span v-if="!hasPlayers">莲花广麻</span></div>
    <div class="round-info">{{ matchName }} · {{ roundLabel }}<span v-if="honba"> · {{ honba }}本场</span></div>
    <div v-if="hasPlayers" class="base-score-badge">
      <span v-if="gameMode === 'remote' && roomId" class="badge-room">房间 {{ roomId }}</span>
      <span>底分{{ BASE_SCORE }}</span>
      <img
        v-if="gameMode === 'remote'"
        class="signal-icon"
        :src="`${imageBase}signal-${signalQuality}.png`"
        :alt="signalText"
        :title="signalQuality <= 0 ? `${signalText}，可能被 AI 托管` : signalText"
      />
      <span v-if="gameMode === 'remote' && signalQuality <= 0" class="signal-warn">{{ signalText }}</span>
    </div>
    <nav>
      <button
        v-if="gameMode === 'remote' && phase !== 'lobby'"
        class="quit-match"
        aria-label="退出对局"
        title="退出对局"
        @click="emit('quit')"
      ><img :src="`${imageBase}door-open.svg`" alt="" /></button>
      <button class="icon-button" :aria-label="soundOn ? '关闭声音' : '开启声音'" @click="emit('toggleSound')">
        <img :src="`${imageBase}${soundOn ? 'audio.png' : 'mute.png'}`" alt="" />
      </button>
      <button class="icon-button" aria-label="查看规则" @click="emit('openRules')">
        <img :src="`${imageBase}manual.png`" alt="" />
      </button>
    </nav>
  </header>
</template>
