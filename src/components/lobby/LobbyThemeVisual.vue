<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { animeCharacterAvatarUrl } from '../../game/llm/animeCharacterPreference'
import { resolveAnimeCharacter, type CharacterId } from '../../game/llm/animeCharacters'
import { tableThemeIdentity, type TableThemeName } from '../../theme/themeIdentity'

const props = defineProps<{
  themeName: TableThemeName
  characterId: CharacterId
}>()

defineEmits<{ selectCharacter: [] }>()

const imageFailed = ref(false)
const imageReady = ref(false)
const themeIdentity = computed(() => tableThemeIdentity(props.themeName))
const currentCharacter = computed(() => resolveAnimeCharacter(props.characterId))
const isAnime = computed(() => props.themeName === 'llmAnime')
const visualImageUrl = computed(() => {
  if (isAnime.value) return animeCharacterAvatarUrl(props.characterId)
  if (props.themeName === 'llm') return `${import.meta.env.BASE_URL}img/llm-table.webp`
  return `${import.meta.env.BASE_URL}themes/lobby/v1/${props.themeName}.png`
})

watch(() => [props.themeName, props.characterId], () => {
  imageFailed.value = false
  imageReady.value = false
})

function markImageFailed() {
  imageFailed.value = true
  imageReady.value = false
}
</script>

<template>
  <section class="lobby-visual" :data-visual-theme="themeName" aria-label="当前主题预览">
    <div class="lobby-brand">
      <p class="eyebrow">LIANHUA MAHJONG COLLECTIONS</p>
      <h1>莲花<span>广麻</span></h1>
      <p class="subtitle">一款莲花县特有的地方麻将游戏玩法</p>
    </div>

    <div
      class="theme-showcase"
      :class="{ 'is-anime': isAnime, 'image-failed': imageFailed, 'image-ready': imageReady }"
      :data-preview-state="imageFailed ? 'error' : (imageReady ? 'ready' : 'loading')"
    >
      <div class="theme-showcase-frame" aria-hidden="true">
        <div v-if="!imageReady && !imageFailed" class="theme-showcase-loading"><span></span></div>
        <img
          v-if="!imageFailed"
          :src="visualImageUrl"
          alt=""
          decoding="async"
          @load="imageReady = true"
          @error="markImageFailed"
        >
        <div v-else class="theme-showcase-fallback">
          <span>{{ isAnime ? currentCharacter.label.slice(0, 1) : '牌' }}</span>
          <small>预览暂不可用</small>
        </div>
      </div>

      <div class="theme-showcase-copy">
        <span class="theme-showcase-kicker">{{ isAnime ? '当前本家形象' : '当前牌桌主题' }}</span>
        <strong>{{ isAnime ? currentCharacter.label : themeIdentity.label }}</strong>
        <p v-if="isAnime" class="anime-welcome" data-testid="anime-welcome">准备好一起开局了吗？</p>
        <p v-else>{{ themeIdentity.description }}</p>
      </div>

      <small v-if="isAnime" class="anime-table-theme">牌桌主题 · {{ themeIdentity.label }}</small>
      <button
        v-if="isAnime"
        type="button"
        class="character-shortcut"
        @click="$emit('selectCharacter')"
      >
        <b>更换本家形象</b>
        <span class="character-shortcut-chevron" aria-hidden="true">›</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.lobby-visual { display: grid; gap: clamp(10px, 2cqh, 20px); min-width: 0; min-height: 0; text-align: center; }
.theme-showcase { position: relative; display: grid; gap: 9px; width: min(540px, 88cqw); margin: 0 auto; padding: clamp(4px, .8cqw, 8px); overflow: visible; border: 0; background: transparent; box-shadow: none; isolation: isolate; }
.theme-showcase::before { content: ""; position: absolute; z-index: -1; inset: -18%; background: radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--theme-accent) 18%, transparent), transparent 52%); pointer-events: none; }
.theme-showcase-frame { position: relative; aspect-ratio: 16 / 9; min-height: 0; overflow: hidden; border: 1px solid color-mix(in srgb, var(--theme-border) 46%, transparent); border-radius: 13px; background: var(--theme-surface); box-shadow: 0 22px 60px rgba(0,0,0,.36); }
.theme-showcase-frame img { display: block; width: 100%; height: 100%; object-fit: cover; opacity: 0; }
.theme-showcase.image-ready .theme-showcase-frame img { opacity: 1; }
.theme-showcase-loading { position: absolute; inset: 0; display: grid; place-items: center; background: linear-gradient(110deg, var(--theme-panel) 22%, var(--theme-panel-elevated) 42%, var(--theme-panel) 62%); background-size: 260% 100%; animation: lobby-preview-loading 1.35s ease-in-out infinite; }
.theme-showcase-loading span { width: 42px; height: 42px; border: 2px solid color-mix(in srgb, var(--theme-border) 45%, transparent); border-top-color: var(--theme-accent); border-radius: 50%; animation: lobby-preview-spin .9s linear infinite; }
.theme-showcase.is-anime .theme-showcase-frame { width: min(310px, 64cqw); aspect-ratio: 1; justify-self: center; border: 0; border-radius: 28px 28px 10px 10px; background: transparent; box-shadow: 12px 14px 0 color-mix(in srgb, var(--theme-accent-secondary) 30%, transparent), 0 24px 54px rgba(0,0,0,.28); }
.theme-showcase.is-anime .theme-showcase-frame img { object-fit: contain; }
.theme-showcase-fallback { display: grid; height: 100%; place-content: center; gap: 7px; color: var(--theme-text-muted); }
.theme-showcase-fallback span { color: var(--theme-accent); font: 900 clamp(42px, 8cqw, 72px) "Noto Serif SC", serif; }
.theme-showcase-copy { display: grid; gap: 3px; }
.theme-showcase-kicker { color: var(--theme-text-muted); font-size: 10px; letter-spacing: .2em; }
.theme-showcase-copy strong { color: var(--theme-text); font-size: clamp(19px, 2.1cqw, 26px); letter-spacing: .08em; }
.theme-showcase-copy p { margin: 0; color: var(--theme-text-muted); font-size: 12px; line-height: 1.5; }
.anime-table-theme { justify-self: center; color: var(--theme-text-muted); font-size: 10px; letter-spacing: .09em; }
.character-shortcut { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; width: min(230px, 100%); margin: 0 auto; padding: 8px 11px; border: 1px solid color-mix(in srgb, var(--theme-border) 55%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--theme-panel-elevated) 80%, transparent); color: var(--theme-text); cursor: pointer; text-align: center; }
.character-shortcut:hover { filter: brightness(1.08); transform: translateY(-1px); }
.character-shortcut b { min-width: 0; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.character-shortcut-chevron { color: var(--theme-accent-secondary); font-size: 16px; font-weight: 800; }
:global(.game-app[data-table-theme="llmAnime"]) .theme-showcase-copy strong { color: #fff1d8; }
:global(.game-app[data-table-theme="llmAnime"]) .theme-showcase-copy p,
:global(.game-app[data-table-theme="llmAnime"]) .theme-showcase-kicker,
:global(.game-app[data-table-theme="llmAnime"]) .anime-table-theme { color: #b9b0a3; }
:global(.game-app[data-table-theme="llmAnime"]) .character-shortcut { border: 2px solid #2d2923; background: #fff1dc; color: #2d2923; box-shadow: 4px 4px 0 rgba(189,91,72,.42); }
:global(.game-app[data-table-theme="llmAnime"]) .character-shortcut-chevron { color: #9b4034; }
@keyframes lobby-preview-loading { 0%, 100% { background-position: 100% 0; } 50% { background-position: 0 0; } }
@keyframes lobby-preview-spin { to { transform: rotate(360deg); } }
@container (min-width: 860px) and (min-height: 520px) {
  .lobby-visual { align-content: center; text-align: left; }
  .theme-showcase { width: min(540px, 44cqw); margin: 0; }
  .theme-showcase.is-anime .theme-showcase-frame { width: min(310px, 30cqw, 39cqh); }
}
@media (hover: none) and (pointer: coarse) and (orientation: landscape) {
  .lobby-visual { align-content: center; gap: 4px; text-align: left; }
  .theme-showcase { width: 100%; box-sizing: border-box; padding: 3px; gap: 3px; }
  /* 按列宽保持画面比例，避免 max-height 反向压窄预览、留下空白列。 */
  .theme-showcase-frame { width: 100%; }
  .theme-showcase.is-anime .theme-showcase-frame { width: min(150px, 100%, 27cqh); }
  .theme-showcase-copy strong { font-size: 14px; }
  .theme-showcase-copy p { font-size: 9px; line-height: 1.25; }
  .theme-showcase-kicker, .anime-table-theme { font-size: 8px; }
  .character-shortcut { width: 100%; padding: 4px 7px; }
}
@media (prefers-reduced-motion: reduce) {
  .theme-showcase-loading,
  .theme-showcase-loading span { animation: none !important; }
}
</style>
