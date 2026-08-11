<script setup lang="ts">
import { computed } from 'vue'
import { TILE_META } from '../game/core/rules/tiles'
import { tileFaceUrl } from '../game/core/presentation/tileAssets'
import type { TileType } from '../game/core/contracts/types'

const props = withDefaults(defineProps<{
  tile?: TileType | 'back'
  hidden?: boolean
  selected?: boolean
  drawn?: boolean
  disabled?: boolean
  small?: boolean
}>(), { tile: 'back', hidden: false, selected: false, drawn: false, disabled: false, small: false })

const emit = defineEmits(['choose'])
const choose = (event?: Event) => {
  if (!props.disabled) emit('choose', event)
}
const shownTile = computed(() => (props.hidden ? 'back' : props.tile))
const meta = computed(() => TILE_META[shownTile.value] || TILE_META.back)
const tileStyle = computed(() => {
  if (shownTile.value === 'back') return {}
  // 优先用预加载的内存 blob URL；预加载未完成时回退网络地址（浏览器缓存兜底）
  return { backgroundImage: `url("${tileFaceUrl(shownTile.value as TileType)}")` }
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
