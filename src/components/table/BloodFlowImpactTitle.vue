<script setup lang="ts">
import { computed, useId } from 'vue'
import type { TableThemeName } from './three/tableTheme'

const props = defineProps<{ text: string; theme: TableThemeName }>()
const id = useId()
const glyphs = computed(() => [...props.text])
const width = computed(() => glyphs.value.length * 92 + 40)
const palette = computed(() => ({
  jade: ['#ffffe6', '#c6e4ca', '#699c80', '#274e3d', '#101e19', '#e2d298'],
  rosewood: ['#fff0cc', '#e6ac6e', '#ac6240', '#5a261b', '#25150e', '#f1cc97'],
  happyMahjong: ['#fffde5', '#ffe16b', '#ffac35', '#307eae', '#173d66', '#fff5bb'],
  llm: ['#edffff', '#93eeff', '#2aa8cd', '#135668', '#071e30', '#a8faff'],
  llmAnime: ['#ffffff', '#fae5f5', '#cfa1cf', '#714678', '#291d3a', '#f1b8d7'],
})[props.theme])
function glyphTransform(index: number) {
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
        <text v-for="(glyph, index) in glyphs" :key="index" :transform="glyphTransform(index)" y="106">{{ glyph }}</text>
      </g>
    </defs>
    <!-- One solid extrusion behind a bevel and a separate face, rather than chromatic ghost copies. -->
    <use :href="`#${id}-glyphs`" transform="translate(7 10)" :fill="palette[4]" :stroke="palette[4]" stroke-width="11" />
    <use v-for="depth in [7, 5, 3]" :key="depth" :href="`#${id}-glyphs`" :transform="`translate(${depth * .65} ${depth})`" :fill="palette[3]" :stroke="palette[3]" stroke-width="7" />
    <use :href="`#${id}-glyphs`" :fill="palette[5]" :stroke="palette[5]" stroke-width="6" />
    <use :href="`#${id}-glyphs`" transform="translate(0 -1)" :fill="`url(#${id}-face)`" :stroke="palette[4]" stroke-width="1.5" />
  </svg>
</template>

<style scoped>
.impact-lettering { display:block; width:100%; overflow:visible; filter:drop-shadow(0 5px 5px #0007); }
text { font-family:'KaiTi','STKaiti','Noto Serif CJK SC',serif; font-size:104px; font-weight:900; paint-order:stroke fill; stroke-linejoin:round; }
.lettering-jade text { font-family:'STKaiti','KaiTi',serif; }
.lettering-rosewood text { font-family:'FangSong','SimSun',serif; font-weight:900; }
.lettering-happyMahjong text { font-family:'Microsoft YaHei',sans-serif; font-size:98px; font-weight:1000; }
.lettering-llm text { font-family:'Microsoft YaHei UI',monospace; font-size:94px; font-weight:900; stroke-linejoin:bevel; }
</style>
