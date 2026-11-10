<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BASE_SCORE } from '../../game/core/rules/rules'
import type { GameMode } from '../../game/core/contracts/activeGamePort'
import type { GamePhase } from '../../game/core/contracts/gamePort'
import { useAudioControls } from '../../game/core/presentation/useAudio'
import { TABLE_THEME_OPTIONS, type TableThemeName } from '../table/three/tableTheme'
import { saveTableThemePreference } from '../table/three/tableThemePreference'
import { THEME_PRESENTATIONS } from '../../theme/themePresentation'
import TableControlIcon from '../table/TableControlIcon.vue'

interface Props {
  gameMode: GameMode
  phase: GamePhase
  hasPlayers: boolean
  matchName: string
  roundLabel: string
  honba: number
  baseScore?: number
  roomId: string
  signalQuality: number
  signalWarningThreshold?: number
  themeName: TableThemeName
  /** 联机房间内锁定主题切换（非房主 / 开局后）。 */
  themeLocked?: boolean
  /** 锁定时给用户的提示文案。 */
  themeLockReason?: string
}

const props = withDefaults(defineProps<Props>(), {
  signalWarningThreshold: 0,
  baseScore: BASE_SCORE,
  themeLocked: false,
  themeLockReason: '主题由房主控制',
})
const emit = defineEmits<{
  quit: []
  openRules: []
  changeTheme: [theme: TableThemeName]
}>()

const imageBase = `${import.meta.env.BASE_URL}img/`
const themeMenuOpen = ref(false)
const audioMenuOpen = ref(false)
const themePicker = ref<HTMLElement | null>(null)
const audioPicker = ref<HTMLElement | null>(null)
const { soundOn, bgmOn, effectsOn } = useAudioControls()
const hasAudibleAudio = computed(() => soundOn.value && (bgmOn.value || effectsOn.value))
const signalText = computed(() => (
  { 0: '网络不稳定', 1: '网络波动', 2: '网络良好', 3: '网络流畅' }[props.signalQuality] ?? ''
))
const themeOptions = TABLE_THEME_OPTIONS.map((option) => ({
  ...option,
  previewUrl: THEME_PRESENTATIONS[option.value].identity.previewUrl,
  previewBackground: THEME_PRESENTATIONS[option.value].shell.pageBackground,
}))

function hideBrokenPreview(event: Event) {
  ;(event.currentTarget as HTMLImageElement).hidden = true
}

function chooseTheme(theme: TableThemeName) {
  themeMenuOpen.value = false
  if (theme !== props.themeName) {
    if (props.gameMode === 'local') saveTableThemePreference(theme)
    emit('changeTheme', theme)
  }
}

function closeThemeMenu(event: PointerEvent) {
  const target = event.target as Node
  if (!themePicker.value?.contains(target)) themeMenuOpen.value = false
  if (!audioPicker.value?.contains(target)) audioMenuOpen.value = false
}

function toggleThemeMenu() {
  if (props.themeLocked) return
  audioMenuOpen.value = false
  themeMenuOpen.value = !themeMenuOpen.value
}

function toggleAudioMenu() {
  themeMenuOpen.value = false
  audioMenuOpen.value = !audioMenuOpen.value
}

function closeMenusOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  themeMenuOpen.value = false
  audioMenuOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', closeThemeMenu)
  document.addEventListener('keydown', closeMenusOnEscape)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeThemeMenu)
  document.removeEventListener('keydown', closeMenusOnEscape)
})
</script>

<template>
  <header
    class="top-bar"
    :data-sound-enabled="soundOn ? 'true' : 'false'"
    :data-bgm-enabled="bgmOn ? 'true' : 'false'"
    :data-effects-enabled="effectsOn ? 'true' : 'false'"
  >
    <div v-if="hasPlayers" class="table-meta" :class="{ 'has-signal': gameMode === 'remote', 'has-signal-warning': gameMode === 'remote' && signalQuality <= signalWarningThreshold }">
      <div class="round-info">{{ matchName }} · {{ roundLabel }}<span v-if="honba" class="round-honba"> · {{ honba }}本场</span></div>
      <div class="base-score-badge">
        <span v-if="gameMode === 'remote' && roomId" class="badge-room"><span class="badge-room-label">房间 </span>{{ roomId }}</span>
        <span>底分{{ baseScore }}</span>
        <span v-if="honba" class="badge-honba">{{ honba }}本场</span>
        <span v-if="gameMode === 'remote'" class="table-signal">
          <img
            class="signal-icon"
            :src="`${imageBase}signal-${signalQuality}.png`"
            :alt="signalText"
            :title="signalQuality <= signalWarningThreshold ? `${signalText}，可能被 AI 托管` : signalText"
          />
          <span v-if="signalQuality <= signalWarningThreshold" class="signal-warn">{{ signalText }}</span>
        </span>
      </div>
    </div>
    <nav>
      <div ref="themePicker" class="theme-picker">
        <button
          type="button"
          class="theme-toggle topbar-control"
          :disabled="themeLocked"
          aria-label="切换牌桌主题"
          aria-haspopup="menu"
          :aria-expanded="themeMenuOpen"
          :title="themeLocked ? themeLockReason : '切换牌桌主题'"
          @click.stop="toggleThemeMenu"
        >
          <TableControlIcon name="theme" />
        </button>
        <div v-if="themeMenuOpen" class="theme-menu" role="menu" aria-label="牌桌主题">
          <p>牌桌主题</p>
          <button
            v-for="option in themeOptions"
            :key="option.value"
            :class="{ active: option.value === themeName }"
            role="menuitemradio"
            :aria-checked="option.value === themeName"
            @click="chooseTheme(option.value)"
          >
            <span class="theme-card-preview" :style="{ background: option.previewBackground }" aria-hidden="true">
              <img :src="option.previewUrl" alt="" loading="lazy" @error="hideBrokenPreview" />
            </span>
            <span class="theme-card-copy"><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
            <i aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <button
        v-if="gameMode === 'remote' && phase !== 'lobby'"
        type="button"
        class="quit-match topbar-control"
        aria-label="退出对局"
        title="退出对局"
        @click="emit('quit')"
      ><TableControlIcon name="exit" /></button>
      <div ref="audioPicker" class="audio-picker">
        <button
          type="button"
          class="topbar-control"
          aria-label="声音设置"
          :aria-expanded="audioMenuOpen"
          title="声音设置"
          @click.stop="toggleAudioMenu"
        >
          <TableControlIcon :name="hasAudibleAudio ? 'audio' : 'mute'" />
        </button>
        <div v-if="audioMenuOpen" class="audio-menu" role="group" aria-label="声音设置">
          <p>声音设置</p>
          <button role="switch" :aria-checked="soundOn" @click="soundOn = !soundOn">
            <span><strong>声音总开关</strong><small>同时控制 BGM 与音效</small></span>
            <i :class="{ active: soundOn }" aria-hidden="true"></i>
          </button>
          <button role="switch" :aria-checked="bgmOn" :disabled="!soundOn" @click="bgmOn = !bgmOn">
            <span><strong>BGM</strong><small>牌桌背景音乐</small></span>
            <i :class="{ active: bgmOn }" aria-hidden="true"></i>
          </button>
          <button role="switch" :aria-checked="effectsOn" :disabled="!soundOn" @click="effectsOn = !effectsOn">
            <span><strong>音效</strong><small>牌声、提示音与角色语音</small></span>
            <i :class="{ active: effectsOn }" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <button type="button" class="topbar-control" aria-label="查看规则" title="查看规则" @click="emit('openRules')">
        <TableControlIcon name="rules" />
      </button>
    </nav>
  </header>
</template>
