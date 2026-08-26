<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BASE_SCORE } from '../../game/core/rules/rules'
import type { GameMode } from '../../game/core/contracts/activeGamePort'
import type { GamePhase } from '../../game/core/contracts/gamePort'
import { TABLE_THEME_OPTIONS, type TableThemeName } from '../table/three/tableTheme'

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
  bgmOn: boolean
  effectsOn: boolean
  themeName: TableThemeName
}

const props = defineProps<Props>()
const emit = defineEmits<{
  quit: []
  toggleSound: []
  toggleBgm: []
  toggleEffects: []
  openRules: []
  changeTheme: [theme: TableThemeName]
}>()

const imageBase = `${import.meta.env.BASE_URL}img/`
const themeMenuOpen = ref(false)
const audioMenuOpen = ref(false)
const themePicker = ref<HTMLElement | null>(null)
const audioPicker = ref<HTMLElement | null>(null)
const hasAudibleAudio = computed(() => props.soundOn && (props.bgmOn || props.effectsOn))
const signalText = computed(() => (
  { 0: '网络不稳定', 1: '网络波动', 2: '网络良好', 3: '网络流畅' }[props.signalQuality] ?? ''
))

function chooseTheme(theme: TableThemeName) {
  themeMenuOpen.value = false
  if (theme !== props.themeName) emit('changeTheme', theme)
}

function closeThemeMenu(event: PointerEvent) {
  const target = event.target as Node
  if (!themePicker.value?.contains(target)) themeMenuOpen.value = false
  if (!audioPicker.value?.contains(target)) audioMenuOpen.value = false
}

function toggleThemeMenu() {
  audioMenuOpen.value = false
  themeMenuOpen.value = !themeMenuOpen.value
}

function toggleAudioMenu() {
  themeMenuOpen.value = false
  audioMenuOpen.value = !audioMenuOpen.value
}

onMounted(() => document.addEventListener('pointerdown', closeThemeMenu))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeThemeMenu))
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
        :title="signalQuality <= 1 ? `${signalText}，可能被 AI 托管` : signalText"
      />
      <span v-if="gameMode === 'remote' && signalQuality <= 1" class="signal-warn">{{ signalText }}</span>
    </div>
    <nav>
      <div ref="themePicker" class="theme-picker">
        <button
          class="theme-toggle"
          aria-label="切换牌桌主题"
          :aria-expanded="themeMenuOpen"
          title="切换牌桌主题"
          @click.stop="toggleThemeMenu"
        >
          <span class="theme-toggle-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        </button>
        <div v-if="themeMenuOpen" class="theme-menu" role="menu" aria-label="牌桌主题">
          <p>牌桌主题</p>
          <button
            v-for="option in TABLE_THEME_OPTIONS"
            :key="option.value"
            :class="{ active: option.value === themeName }"
            role="menuitemradio"
            :aria-checked="option.value === themeName"
            @click="chooseTheme(option.value)"
          >
            <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
            <i aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <button
        v-if="gameMode === 'remote' && phase !== 'lobby'"
        class="quit-match"
        aria-label="退出对局"
        title="退出对局"
        @click="emit('quit')"
      ><img :src="`${imageBase}door-open.svg`" alt="" /></button>
      <div ref="audioPicker" class="audio-picker">
        <button
          class="icon-button"
          aria-label="声音设置"
          :aria-expanded="audioMenuOpen"
          title="声音设置"
          @click.stop="toggleAudioMenu"
        >
          <img :src="`${imageBase}${hasAudibleAudio ? 'audio.png' : 'mute.png'}`" alt="" />
        </button>
        <div v-if="audioMenuOpen" class="audio-menu" role="group" aria-label="声音设置">
          <p>声音设置</p>
          <button role="switch" :aria-checked="soundOn" @click="emit('toggleSound')">
            <span><strong>声音总开关</strong><small>同时控制 BGM 与音效</small></span>
            <i :class="{ active: soundOn }" aria-hidden="true"></i>
          </button>
          <button role="switch" :aria-checked="bgmOn" :disabled="!soundOn" @click="emit('toggleBgm')">
            <span><strong>BGM</strong><small>牌桌背景音乐</small></span>
            <i :class="{ active: bgmOn }" aria-hidden="true"></i>
          </button>
          <button role="switch" :aria-checked="effectsOn" :disabled="!soundOn" @click="emit('toggleEffects')">
            <span><strong>音效</strong><small>牌声、提示音与角色语音</small></span>
            <i :class="{ active: effectsOn }" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <button class="icon-button" aria-label="查看规则" @click="emit('openRules')">
        <img :src="`${imageBase}manual.png`" alt="" />
      </button>
    </nav>
  </header>
</template>
