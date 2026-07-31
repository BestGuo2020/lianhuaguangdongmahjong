<script setup>
import { computed } from 'vue'
import { TILE_META, tileFaceFile } from '../game/tiles'

const props = defineProps({
  tile: { type: String, default: 'back' },
  hidden: Boolean,
  selected: Boolean,
  drawn: Boolean,
  disabled: Boolean,
  small: Boolean,
})

const emit = defineEmits(['choose'])
const shownTile = computed(() => (props.hidden ? 'back' : props.tile))
const meta = computed(() => TILE_META[shownTile.value] || TILE_META.back)
const tileStyle = computed(() => {
  if (shownTile.value === 'back') return {}
  const file = tileFaceFile(shownTile.value)
  return file ? { backgroundImage: `url("${import.meta.env.BASE_URL}tiles/${file}")` } : {}
})
</script>

<template>
  <button
    class="mahjong-tile"
    :class="{ selected, drawn, disabled, small, 'tile-back': shownTile === 'back', joker: tile === 'white' && !hidden, red: tile === 'red' && !hidden }"
    :style="tileStyle"
    :aria-label="meta.name"
    :disabled="disabled"
    @click="emit('choose')"
  >
    <span v-if="tile === 'white' && !hidden" class="joker-mark">癞</span>
  </button>
</template>
