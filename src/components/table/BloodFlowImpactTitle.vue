<script setup lang="ts">
import { computed, useId } from 'vue'
import type { TableThemeName } from './three/tableTheme'

const props = defineProps<{ text: string; theme: TableThemeName }>()
const id = useId()
const glyphs = computed(() => [...props.text])
const anime = computed(() => props.theme === 'llmAnime')
const width = computed(() => glyphs.value.length * (anime.value ? 88 : 92) + 40)
const palette = computed(() => ({
  jade: ['#ffffe6', '#c6e4ca', '#699c80', '#274e3d', '#101e19', '#e2d298'],
  rosewood: ['#fff0cc', '#e6ac6e', '#ac6240', '#5a261b', '#25150e', '#f1cc97'],
  happyMahjong: ['#fffde5', '#ffe16b', '#ffac35', '#307eae', '#173d66', '#fff5bb'],
  llm: ['#edffff', '#93eeff', '#2aa8cd', '#135668', '#071e30', '#a8faff'],
  llmAnime: ['#ffffff', '#fae5f5', '#cfa1cf', '#714678', '#291d3a', '#f1b8d7'],
})[props.theme])
function glyphTransform(index: number) {
  if (anime.value) return `translate(${26 + index * 88} ${index % 2 ? 4 : 0}) skewX(-6) scale(.96 1.06)`
  const expressive = props.theme === 'llmAnime' || props.theme === 'happyMahjong'
  const last = index === glyphs.value.length - 1
  return `translate(${24 + index * 92} ${expressive ? index % 2 ? 8 : 2 : 4}) rotate(${expressive ? last ? 2 : -3 : 0} 45 75) scale(${expressive && last ? 1.1 : 1} 1)`
}
</script>

<template>
  <svg class="impact-lettering" :class="`lettering-${theme}`" :viewBox="`0 0 ${width} 148`" role="img" :aria-label="text">
    <defs>
      <linearGradient :id="`${id}-face`" x1="0" y1="0" x2=".25" y2="1">
        <stop offset="0" :stop-color="palette[0]" /><stop offset=".46" :stop-color="palette[1]" />
        <stop offset=".49" :stop-color="palette[0]" /><stop offset="1" :stop-color="palette[2]" />
      </linearGradient>
      <g :id="`${id}-glyphs`">
        <text v-for="(glyph, index) in glyphs" :key="index" :transform="glyphTransform(index)" y="106"
          :style="anime ? {fontFamily: 'Microsoft YaHei,Noto Sans CJK SC,sans-serif',fontSize:'98px',fontWeight:900,strokeLinejoin:'miter',strokeMiterlimit:2} : undefined">{{ glyph }}</text>
      </g>
      <linearGradient :id="`${id}-anime-face`" x1="0" y1="0" x2=".15" y2="1">
        <stop offset="0" stop-color="#ffd7ef" /><stop offset=".6" stop-color="#edacd6" /><stop offset="1" stop-color="#cd82bb" />
      </linearGradient>
      <clipPath :id="`${id}-glints`">
        <path d="M25 22 L68 22 L43 55 L25 55 Z" />
        <path :d="`M${width-93} 26 h32 l-15 19 h-32 Z`" />
      </clipPath>
    </defs>
    <template v-if="anime">
      <!-- A short, one-sided cut edge. The face has no concentric bevel strokes. -->
      <use :href="`#${id}-glyphs`" transform="translate(3 5)" fill="#603564" stroke="#281632" stroke-width="8" />
      <use :href="`#${id}-glyphs`" :fill="`url(#${id}-anime-face)`" stroke="#301a3f" stroke-width="7" />
      <use :href="`#${id}-glyphs`" :clip-path="`url(#${id}-glints)`" fill="#ffe7f4" opacity=".45" />
    </template>
    <template v-else>
      <use :href="`#${id}-glyphs`" transform="translate(7 10)" :fill="palette[4]" :stroke="palette[4]" stroke-width="11" />
      <use v-for="depth in [7, 5, 3]" :key="depth" :href="`#${id}-glyphs`" :transform="`translate(${depth * .65} ${depth})`" :fill="palette[3]" :stroke="palette[3]" stroke-width="7" />
      <use :href="`#${id}-glyphs`" :fill="palette[5]" :stroke="palette[5]" stroke-width="6" />
      <use :href="`#${id}-glyphs`" transform="translate(0 -1)" :fill="`url(#${id}-face)`" :stroke="palette[4]" stroke-width="1.5" />
    </template>
  </svg>
</template>

<style scoped>
.impact-lettering { display:block; width:100%; overflow:visible; filter:drop-shadow(0 5px 5px #0007); }
text { font-family:'Microsoft YaHei','Noto Sans CJK SC','PingFang SC',sans-serif; font-size:98px; font-weight:900; paint-order:stroke fill; stroke-linejoin:round; }
.lettering-jade text { font-size:96px; letter-spacing:2px; }
.lettering-rosewood text { font-size:96px; }
.lettering-happyMahjong text { font-size:98px; font-weight:1000; }
.lettering-llm text { font-size:94px; stroke-linejoin:bevel; }
.lettering-llmAnime { filter:drop-shadow(0 3px 1px #160e2380); }
.lettering-llmAnime text { font-size:98px; stroke-linejoin:miter; stroke-miterlimit:2; }
</style>
