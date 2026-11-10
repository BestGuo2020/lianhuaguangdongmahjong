<script setup lang="ts">
import { computed } from 'vue'
import { tableEmote, type TableEmoteId } from '../../game/shared/tableInteractions'

const props = withDefaults(defineProps<{
  kind: TableEmoteId
  size?: number
  impact?: boolean
}>(), { size: 44, impact: false })

const imageBase = `${import.meta.env.BASE_URL}images/emotes/`
const image = computed(() => imageBase + tableEmote(props.kind)!.image)
const sprite = computed(() => {
  if (!props.impact || (props.kind !== 'egg' && props.kind !== 'tomato')) return
  const egg = props.kind === 'egg'
  const width = egg ? Math.round(props.size * 0.625) : props.size
  return {
    width: `${width}px`,
    height: `${props.size}px`,
    backgroundImage: `url(${imageBase}${props.kind}-impact.png)`,
    '--sprite-end': `-${(egg ? 19 : 20) * width}px`,
    '--sprite-steps': egg ? 19 : 20,
  }
})
</script>

<template>
  <div v-if="sprite" class="table-emote-sheet" :style="sprite" aria-hidden="true"></div>
  <img v-else class="table-emote-art" :src="image" :width="size" :height="size" alt="" draggable="false" />
</template>

<style scoped>
.table-emote-art { display: block; flex: none; object-fit: contain; }
.table-emote-sheet {
  display: block;
  flex: none;
  background-repeat: no-repeat;
  background-size: auto 100%;
  animation: table-emote-sheet 1.1s steps(var(--sprite-steps)) .48s both;
}
@keyframes table-emote-sheet {
  from { background-position: 0 0; }
  to { background-position: var(--sprite-end) 0; }
}
@media (prefers-reduced-motion: reduce) {
  .table-emote-sheet { animation: none; background-position: var(--sprite-end) 0; }
}
</style>
