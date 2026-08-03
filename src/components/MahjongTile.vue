<script setup lang="ts">
import { computed } from 'vue'
import { TILE_META, tileFaceFile } from '../game/tiles'
import type { TileType } from '../game/types'

const props = withDefaults(defineProps<{
  tile?: TileType | 'back'
  hidden?: boolean
  selected?: boolean
  drawn?: boolean
  disabled?: boolean
  small?: boolean
}>(), { tile: 'back', hidden: false, selected: false, drawn: false, disabled: false, small: false })

const emit = defineEmits(['choose'])
const choose = () => {
  if (!props.disabled) emit('choose')
}
const shownTile = computed(() => (props.hidden ? 'back' : props.tile))
const meta = computed(() => TILE_META[shownTile.value] || TILE_META.back)
const tileStyle = computed(() => {
  if (shownTile.value === 'back') return {}
  const file = tileFaceFile(shownTile.value as TileType)
  return file ? { backgroundImage: `url("${import.meta.env.BASE_URL}tiles/${file}")` } : {}
})
</script>

<template>
  <div
    class="mahjong-tile"
    :class="{ selected, drawn, disabled, small, 'tile-back': shownTile === 'back', joker: tile === 'white' && !hidden, red: tile === 'red' && !hidden }"
    :style="tileStyle"
    role="button"
    :aria-label="meta.name"
    :aria-disabled="disabled"
    :tabindex="disabled ? -1 : 0"
    @click="choose"
    @keydown.enter="choose"
    @keydown.space.prevent="choose"
  >
    <span v-if="tile === 'white' && !hidden" class="joker-mark">癞</span>
  </div>
</template>
