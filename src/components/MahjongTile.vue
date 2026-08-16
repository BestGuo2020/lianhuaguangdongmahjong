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
  /** 本局癞子集合；未传时按现行玩法「白板」高亮 */
  jokerTiles?: TileType[]
  /** 可替代精牌的实体牌；不参与精牌排序。 */
  wildcardTiles?: TileType[]
}>(), { tile: 'back', hidden: false, selected: false, drawn: false, disabled: false, small: false })

const emit = defineEmits(['choose'])
const choose = (event?: Event) => {
  if (!props.disabled) emit('choose', event)
}
const shownTile = computed(() => (props.hidden ? 'back' : props.tile))
const meta = computed(() => TILE_META[shownTile.value] || TILE_META.back)
const isPrecision = computed(() => (
  props.tile !== 'back'
  && props.tile !== 'white'
  && Boolean(props.jokerTiles?.includes(props.tile))
))
// 替牌 = 莲花麻将中可替代精牌的实体牌（白板出现在 wildcardTiles）；
// 莲花广麻无 wildcardTiles，白板癞子走 isLaizi，不在此列。
const isWildcard = computed(() => {
  if (props.tile === 'back' || isPrecision.value) return false
  return Boolean(props.wildcardTiles?.includes(props.tile))
})
const isLaizi = computed(() => (
  !isPrecision.value
  && !isWildcard.value
  && props.tile === 'white'
  && Boolean(props.jokerTiles?.includes(props.tile))
))
const isJoker = computed(() => isPrecision.value || isWildcard.value || isLaizi.value)
// 标记统一为「精」：真精牌、白板替身（可代本局精牌）、白板癞子/白板翻精都标「精」
// （此前替身标「替」，白板翻精标「癞」，用户要求统一为「精」）。
const tileMarker = computed(() => (isPrecision.value || isWildcard.value || isLaizi.value ? '精' : ''))
const tileLabel = computed(() => {
  if (!isJoker.value || shownTile.value === 'back') return meta.value.name
  const role = isPrecision.value || isLaizi.value ? '精牌' : '万能牌'
  return `${meta.value.name}，${role}${isWildcard.value ? '，可代本局精牌' : ''}`
})
const tileStyle = computed(() => {
  if (shownTile.value === 'back') return {}
  // 优先用预加载的内存 blob URL；预加载未完成时回退网络地址（浏览器缓存兜底）
  return { backgroundImage: `url("${tileFaceUrl(shownTile.value as TileType)}")` }
})
</script>

<template>
  <div
    class="mahjong-tile"
    :class="{ selected, drawn, disabled, small, 'tile-back': shownTile === 'back', joker: isPrecision && !hidden, wildcard: isWildcard && !hidden, laizi: isLaizi && !hidden, red: tile === 'red' && !hidden }"
    :style="tileStyle"
    role="button"
    :aria-label="tileLabel"
    :aria-disabled="disabled"
    :tabindex="disabled ? -1 : 0"
    @click="choose"
    @keydown.enter="choose"
    @keydown.space.prevent="choose"
  >
    <span v-if="isJoker && !hidden" class="joker-mark">{{ tileMarker }}</span>
  </div>
</template>
