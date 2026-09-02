<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { defaultAvatarForSeat } from '../game/core/presentation/avatar'
import type { GamePlayer } from '../game/core/contracts/types'
import type { TableThemeName } from './table/three/tableTheme'
import { animeCharacterAccent } from '../game/core/presentation/animeCharacterPalette'

const props = withDefaults(defineProps<{
  player: GamePlayer
  active?: boolean
  actionActive?: boolean
  scoreDelta?: number
  scoreFlowId?: number
  position: string
  dealer?: boolean
  themeName?: TableThemeName
  /** 主题表现头像覆盖，不修改权威玩家 avatar。 */
  avatarOverride?: string
  /** AI 大模型吐槽气泡（可选；由上层管理过期） */
  bubble?: { text: string; id: number; persistent?: boolean } | null
}>(), { active: false, actionActive: false, scoreDelta: 0, scoreFlowId: 0, dealer: false, avatarOverride: undefined, bubble: null })

// 外部头像（联机真人）加载失败 → 回退到本地座位默认头像
const avatarSrc = ref(props.avatarOverride || props.player.avatar)
watch(() => [props.avatarOverride, props.player.avatar], () => {
  avatarSrc.value = props.avatarOverride || props.player.avatar
})
function onAvatarError() {
  avatarSrc.value = props.avatarOverride && avatarSrc.value !== props.player.avatar
    ? props.player.avatar
    : defaultAvatarForSeat(props.player.seat)
}
const animeStyle = computed(() => props.themeName === 'llmAnime'
  ? { '--anime-accent': animeCharacterAccent(props.player.characterId) }
  : undefined)
</script>

<template>
  <section class="player-seat" :class="[`seat-${position}`, { active, 'action-active': actionActive }]" :style="animeStyle">
    <div class="avatar-wrap">
      <span v-if="dealer" class="dealer-badge">庄</span>
      <img class="avatar" :src="avatarSrc" :alt="`${player.name}头像`" @error="onAvatarError" />
      <div class="player-info">
        <strong>{{ player.name }}</strong>
        <span>{{ player.score }}</span>
      </div>
      <span v-if="active" class="turn-dot"></span>
      <Transition name="score-flow">
        <strong
          v-if="scoreDelta"
          :key="`${scoreFlowId}-${player.seat}`"
          class="score-delta"
          :class="scoreDelta > 0 ? 'positive' : 'negative'"
        >{{ scoreDelta > 0 ? '+' : '' }}{{ scoreDelta }}</strong>
      </Transition>
      <Transition name="llm-bubble">
        <div v-if="bubble" :key="bubble.id" class="llm-bubble" role="status" aria-live="polite">{{ bubble.text }}</div>
      </Transition>
    </div>
  </section>
</template>
