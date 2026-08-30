<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GamePlayer, TableActionEvent } from '../../game/core/contracts/types'
import { animeActionPresentation } from '../../game/core/presentation/animeActionPresentation'
import { animeActionArtUrl } from '../../game/core/presentation/llmAnimeAssets'
import { animeCharacterAccent } from '../../game/core/presentation/animeCharacterPalette'
import { resolveAnimeCharacter } from '../../game/llm/animeCharacters'
import { animeCharacterAvatarUrl } from '../../game/llm/animeCharacterPreference'

const props = defineProps<{
  event: TableActionEvent
  player?: GamePlayer
  position: string
}>()

const dedicatedArtFailed = ref(false)
const baseAvatarFailed = ref(false)
const action = computed(() => animeActionPresentation(props.event.type))
const character = computed(() => resolveAnimeCharacter(props.player?.characterId))
const dedicatedArt = computed(() => animeActionArtUrl(character.value.id, action.value.key))
const artwork = computed(() => !dedicatedArtFailed.value && dedicatedArt.value
  ? dedicatedArt.value
  : animeCharacterAvatarUrl(character.value.id))
const usesDedicatedArt = computed(() => Boolean(dedicatedArt.value && !dedicatedArtFailed.value))
const cueStyle = computed(() => ({ '--anime-accent': animeCharacterAccent(character.value.id) }))

watch(() => [props.event.id, character.value.id], () => {
  dedicatedArtFailed.value = false
  baseAvatarFailed.value = false
})

function onPortraitError(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  if (usesDedicatedArt.value) {
    dedicatedArtFailed.value = true
    return
  }
  if (!baseAvatarFailed.value) {
    baseAvatarFailed.value = true
    image.src = animeCharacterAvatarUrl('deepseek')
    return
  }
  image.hidden = true
}
</script>

<template>
  <div
    class="anime-action-cue"
    :class="[`action-from-${position}`, `anime-action-${action.key}`]"
    role="status"
    aria-live="polite"
    :aria-label="action.label"
    :style="cueStyle"
  >
    <div class="anime-action-burst" aria-hidden="true"></div>
    <img
      :src="artwork"
      :class="{ 'dedicated-action-art': usesDedicatedArt, 'base-q-avatar': !usesDedicatedArt }"
      alt=""
      aria-hidden="true"
      @error="onPortraitError"
    >
    <div class="anime-action-copy" aria-hidden="true">
      <strong :data-text="action.label">{{ action.label }}</strong>
    </div>
  </div>
</template>

<style scoped>
.anime-action-cue {
  position: absolute;
  z-index: 45;
  width: clamp(96px, 8.5vw, 132px);
  height: clamp(72px, 7vw, 102px);
  overflow: visible;
  pointer-events: none;
  filter: drop-shadow(3px 5px 0 rgba(45, 36, 28, .26));
  isolation: isolate;
  animation: anime-action-enter .26s cubic-bezier(.16, .88, .25, 1.08) both;
}
.anime-action-cue::before {
  content: '';
  position: absolute;
  z-index: -2;
  right: 1%;
  bottom: 7%;
  width: 57%;
  height: 31%;
  border: 2px solid #2d241c;
  background: #fff8e8;
  box-shadow: 3px 3px 0 rgba(45, 36, 28, .18);
  clip-path: polygon(5% 0, 100% 7%, 95% 100%, 0 88%);
  transform: rotate(-4deg);
}
.anime-action-burst {
  position: absolute;
  z-index: -1;
  inset: 4% 9% 12% 0;
  opacity: .56;
  border-top: 2px solid var(--anime-accent, #9e5148);
  border-left: 2px solid transparent;
  border-radius: 50%;
  transform: rotate(-10deg) skewX(-8deg);
}
.anime-action-cue img.base-q-avatar {
  position: absolute;
  left: 0;
  bottom: -27%;
  width: 66%;
  height: 112%;
  object-fit: contain;
  object-position: center bottom;
  filter: drop-shadow(3px 4px 0 rgba(45, 36, 28, .28));
}
.anime-action-cue img.dedicated-action-art {
  position: absolute;
  inset: 1% 3% 1% 0;
  width: 88%;
  height: 99%;
  border: 0;
  border-radius: 0;
  object-fit: contain;
  object-position: center;
  -webkit-mask-image: radial-gradient(ellipse at 44% 50%, #000 0 32%, rgba(0,0,0,.92) 46%, rgba(0,0,0,.48) 61%, transparent 79%);
  mask-image: radial-gradient(ellipse at 44% 50%, #000 0 32%, rgba(0,0,0,.92) 46%, rgba(0,0,0,.48) 61%, transparent 79%);
  filter: grayscale(.68) sepia(.18) saturate(.75) contrast(.98) drop-shadow(3px 4px 0 rgba(45, 36, 28, .26));
}
.anime-action-copy {
  position: absolute;
  right: 5%;
  bottom: 10%;
  display: grid;
  justify-items: end;
  transform: rotate(-4deg);
}
.anime-action-copy strong {
  position: relative;
  color: #fff8e7;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: clamp(24px, 2.45vw, 38px);
  font-weight: 1000;
  line-height: .92;
  letter-spacing: -.08em;
  paint-order: stroke fill;
  -webkit-text-stroke: clamp(2px, .22vw, 3px) #2d241c;
  text-shadow: 2px 2px 0 rgba(45, 36, 28, .22);
}
.anime-action-copy strong::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  z-index: -1;
  color: transparent;
  -webkit-text-stroke: clamp(4px, .38vw, 6px) var(--anime-accent, #bd5b48);
}
.anime-action-zimo .anime-action-copy strong,
.anime-action-qiangganghu .anime-action-copy strong { font-size: clamp(22px, 2.35vw, 36px); letter-spacing: -.12em; }
.anime-action-cue.anime-action-hu,
.anime-action-cue.anime-action-zimo,
.anime-action-cue.anime-action-qiangganghu { width: clamp(120px, 10.6vw, 166px); height: clamp(92px, 8.4vw, 126px); }
.action-from-top { top: 18%; left: 50%; transform: translate(-50%, 0); }
.action-from-right { top: 34%; right: 28%; transform: translate(0, -50%); }
.action-from-bottom { bottom: 29%; left: 50%; transform: translate(-50%, 0); }
.action-from-left { top: 34%; left: 28%; transform: translate(0, -50%); }
.action-from-left img.base-q-avatar { left: auto; right: 0; transform: scaleX(-1); }
.action-from-left .anime-action-copy { right: auto; left: 4%; align-items: start; }
@keyframes anime-action-enter {
  from { opacity: 0; scale: .88; filter: blur(2px) drop-shadow(3px 5px 0 rgba(45,36,28,.26)); }
  to { opacity: 1; scale: 1; filter: blur(0) drop-shadow(3px 5px 0 rgba(45,36,28,.26)); }
}
@media (max-width: 760px), (max-height: 520px) {
  .anime-action-cue { width: clamp(92px, 13vw, 124px); height: clamp(68px, 10vw, 94px); }
  .action-from-top { top: 18%; }
  .action-from-right { top: 34%; right: 26%; }
  .action-from-bottom { bottom: 27%; }
  .action-from-left { top: 34%; left: 26%; }
}
@media (prefers-reduced-motion: reduce) {
  .anime-action-cue { animation: anime-action-fade .16s ease-out both; }
  .anime-action-burst { display: none; }
}
@keyframes anime-action-fade { from { opacity: 0; } to { opacity: 1; } }
</style>
