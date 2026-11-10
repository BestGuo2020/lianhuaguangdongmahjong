<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { defaultAvatarForSeat } from '../game/core/presentation/avatar'
import { displayImageSrc, materializedImageVersion } from '../game/core/presentation/imagePreload'
import type { GamePlayer } from '../game/core/contracts/types'
import type { TableThemeName } from './table/three/tableTheme'
import { animeCharacterAccent } from '../game/core/presentation/animeCharacterPalette'
import { scoreDirection } from '../theme/themeEventPresentation'

const props = withDefaults(defineProps<{
  player: GamePlayer
  active?: boolean
  actionActive?: boolean
  scoreDelta?: number
  scoreFlowId?: number
  position: string
  /** 手机上昵称不占位；点头像查看完整昵称。 */
  nicknameOnTap?: boolean
  dealer?: boolean
  themeName?: TableThemeName
  /** 主题表现头像覆盖，不修改权威玩家 avatar。 */
  avatarOverride?: string
  emoteEnabled?: boolean
  quickChatBubble?: boolean
  /** 玩家快捷语或大模型发言，由上层管理过期。 */
  bubble?: { text: string; id: number; persistent?: boolean } | null
}>(), { active: false, actionActive: false, scoreDelta: 0, scoreFlowId: 0, dealer: false, avatarOverride: undefined, bubble: null })
const emit = defineEmits<{ emote: [] }>()

// 外部头像（联机真人）加载失败 → 回退到本地座位默认头像
// 已物化的头像用本地 blob（座位会随快照重建，避免每次重建都做一次协商校验）。
const nicknameOpen = ref(false)
function activateAvatar() {
  if (props.emoteEnabled) emit('emote')
  else nicknameOpen.value = !nicknameOpen.value
}
watch(() => props.emoteEnabled, () => { nicknameOpen.value = false })
const avatarSrc = ref(displayImageSrc(props.avatarOverride || props.player.avatar))
watch(() => [props.avatarOverride, props.player.avatar, materializedImageVersion.value], () => {
  avatarSrc.value = displayImageSrc(props.avatarOverride || props.player.avatar)
})
function onAvatarError() {
  avatarSrc.value = displayImageSrc(props.avatarOverride && avatarSrc.value !== props.player.avatar
    ? props.player.avatar
    : defaultAvatarForSeat(props.player.seat))
}
const animeStyle = computed(() => props.themeName === 'llmAnime'
  ? { '--anime-accent': animeCharacterAccent(props.player.characterId) }
  : undefined)
</script>

<template>
  <section class="player-seat" :class="[`seat-${position}`, { active, 'action-active': actionActive, 'nickname-open': nicknameOpen }]" :style="animeStyle" :aria-label="player.name" :data-table-seat="player.seat">
    <div class="avatar-wrap">
      <span v-if="dealer" class="dealer-badge">庄</span>
      <button v-if="nicknameOnTap || emoteEnabled" type="button" class="avatar-button"
        :aria-label="emoteEnabled ? `对${player.name}使用互动道具` : `查看${player.name}的昵称`"
        :aria-haspopup="emoteEnabled ? 'dialog' : undefined"
        :aria-expanded="emoteEnabled ? undefined : nicknameOpen" :title="emoteEnabled ? player.name : undefined"
        @click.stop="activateAvatar" @keydown.esc="nicknameOpen = false" @blur="nicknameOpen = false">
        <img class="avatar" :src="avatarSrc" :alt="`${player.name}头像`" @error="onAvatarError" />
      </button>
      <img v-else class="avatar" :src="avatarSrc" :alt="`${player.name}头像`" @error="onAvatarError" />
      <div class="player-info">
        <strong><span class="player-name">{{ player.name }}</span></strong>
        <span>{{ player.score }}</span>
      </div>
      <Transition name="nickname-reveal">
        <div v-if="nicknameOpen && nicknameOnTap" class="nickname-popover" role="status" aria-live="polite">{{ player.name }}</div>
      </Transition>
      <slot name="footer" />
      <span v-if="active" class="turn-dot"></span>
      <Transition name="score-flow">
        <strong
          v-if="scoreDelta"
          :key="`${scoreFlowId}-${player.seat}`"
          class="score-delta"
          :class="scoreDirection(scoreDelta)"
          :data-score-direction="scoreDirection(scoreDelta)"
        >{{ scoreDelta > 0 ? '+' : '' }}{{ scoreDelta }}</strong>
      </Transition>
      <Transition name="llm-bubble">
        <div v-if="bubble" :key="`${quickChatBubble ? 'chat' : 'llm'}:${bubble.id}`" class="llm-bubble"
          :class="{ 'quick-chat-bubble': quickChatBubble }" :data-quick-chat-seat="quickChatBubble ? player.seat : undefined"
          role="status" aria-live="polite">{{ bubble.text }}</div>
      </Transition>
    </div>
  </section>
</template>
