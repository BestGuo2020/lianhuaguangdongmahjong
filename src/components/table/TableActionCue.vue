<script setup lang="ts">
import { computed } from 'vue'
import type { GamePlayer, TableActionEvent } from '../../game/core/contracts/types'
import { resolveTableActionPresentation } from '../../theme/themeEventPresentation'
import type { TableThemeName } from './three/tableTheme'
import AnimeActionCue from './AnimeActionCue.vue'

// Display only: callers own event deduplication, timing and audio.
const props = defineProps<{
  event: TableActionEvent
  player?: GamePlayer
  themeName: TableThemeName
  position: string
  progress?: number
}>()
const presentation = computed(() => resolveTableActionPresentation(props.event.type))
const timing = computed(() => props.progress == null ? undefined : {
  animation: 'win-cue-serial 700ms ease-out both paused',
  animationDelay: `${-Math.max(0, Math.min(1, props.progress)) * 700}ms`,
})
</script>

<template>
  <AnimeActionCue v-if="themeName === 'llmAnime'"
    :class="[`action-${presentation.kind}`, `strength-${presentation.strength}`]"
    :data-action-type="event.type" :data-action-kind="presentation.kind" :data-action-strength="presentation.strength"
    :event="event" :player="player" :position="position" :progress="progress" />
  <div v-else class="table-action-cue"
    :class="[`action-from-${position}`, `action-${presentation.kind}`, `strength-${presentation.strength}`,
      { gang: presentation.kind === 'gang', win: presentation.kind === 'win' }]"
    :data-action-type="event.type" :data-action-kind="presentation.kind" :data-action-strength="presentation.strength"
    :style="timing" aria-live="polite"
  ><span>{{ presentation.label }}</span></div>
</template>
