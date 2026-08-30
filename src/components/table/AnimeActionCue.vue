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
  width: clamp(122px, 12vw, 198px);
  height: clamp(92px, 10vw, 154px);
  overflow: hidden;
  pointer-events: none;
  filter: drop-shadow(0 8px 12px rgba(24, 20, 16, .34));
  isolation: isolate;
  animation: anime-action-enter .26s cubic-bezier(.16, .88, .25, 1.08) both;
}
.anime-action-cue::before {
  content: '';
  position: absolute;
  z-index: -2;
  inset: 19% 7% 7%;
  border: 2px solid var(--anime-accent, #9e5148);
  border-radius: 10px 18px 12px 20px;
  background: rgba(255, 250, 237, .94);
  box-shadow: inset 0 -5px 0 rgba(185, 55, 41, .14), 0 5px 0 rgba(255, 255, 255, .55);
  transform: rotate(-2deg);
}
.anime-action-burst {
  position: absolute;
  z-index: -1;
  inset: 5% 0 0;
  opacity: .72;
  border-top: 3px solid color-mix(in srgb, var(--anime-accent, #9e5148) 72%, transparent);
  border-radius: 50%;
  transform: rotate(-8deg);
}
.anime-action-cue img.base-q-avatar {
  position: absolute;
  left: 0;
  bottom: -27%;
  width: 62%;
  height: 116%;
  object-fit: contain;
  object-position: center bottom;
  filter: drop-shadow(4px 6px 4px rgba(24, 20, 16, .32));
}
.anime-action-cue img.dedicated-action-art {
  position: absolute;
  inset: 5% 5% 2%;
  width: 90%;
  height: 94%;
  border: 0;
  border-radius: 0;
  object-fit: contain;
  object-position: center;
  clip-path: polygon(8% 4%, 89% 0, 100% 18%, 94% 91%, 74% 100%, 10% 94%, 0 67%);
  -webkit-mask-image: radial-gradient(ellipse at 44% 50%, #000 0 55%, rgba(0,0,0,.88) 70%, transparent 100%);
  mask-image: radial-gradient(ellipse at 44% 50%, #000 0 55%, rgba(0,0,0,.88) 70%, transparent 100%);
  filter: saturate(.58) sepia(.12) drop-shadow(4px 6px 4px rgba(24, 20, 16, .32));
}
.anime-action-copy {
  position: absolute;
  right: 5%;
  bottom: 9%;
  display: grid;
  justify-items: end;
  transform: rotate(-4deg);
}
.anime-action-copy strong {
  position: relative;
  color: #fff8e7;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: clamp(28px, 3.2vw, 50px);
  font-weight: 1000;
  line-height: .92;
  letter-spacing: -.08em;
  paint-order: stroke fill;
  -webkit-text-stroke: clamp(2px, .25vw, 4px) #5b4837;
  text-shadow: 0 3px 0 rgba(91, 72, 55, .45);
}
.anime-action-copy strong::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  z-index: -1;
  color: transparent;
  -webkit-text-stroke: clamp(4px, .42vw, 7px) rgba(185, 55, 41, .94);
}
.anime-action-zimo .anime-action-copy strong,
.anime-action-qiangganghu .anime-action-copy strong { font-size: clamp(24px, 2.8vw, 44px); letter-spacing: -.12em; }
.anime-action-cue.anime-action-hu,
.anime-action-cue.anime-action-zimo,
.anime-action-cue.anime-action-qiangganghu { width: clamp(150px, 15vw, 236px); height: clamp(112px, 12vw, 182px); }
.action-from-top { top: 19%; left: 50%; transform: translate(-50%, -50%); }
.action-from-right { top: 33%; right: 14%; transform: translate(50%, -50%); }
.action-from-bottom { bottom: 22%; left: 50%; transform: translate(-50%, 50%); }
.action-from-left { top: 33%; left: 14%; transform: translate(-50%, -50%); }
.action-from-left img.base-q-avatar { left: auto; right: 0; transform: scaleX(-1); }
.action-from-left .anime-action-copy { right: auto; left: 4%; align-items: start; }
@keyframes anime-action-enter {
  from { opacity: 0; scale: .86; filter: blur(3px) drop-shadow(0 8px 12px rgba(24,20,16,.34)); }
  to { opacity: 1; scale: 1; filter: blur(0) drop-shadow(0 8px 12px rgba(24,20,16,.34)); }
}
@media (max-width: 760px), (max-height: 520px) {
  .anime-action-cue { width: clamp(112px, 17vw, 164px); height: clamp(84px, 14vw, 126px); }
  .action-from-top { top: 20%; }
  .action-from-right { top: 34%; right: 12%; }
  .action-from-bottom { bottom: 21%; }
  .action-from-left { top: 34%; left: 12%; }
}
@media (prefers-reduced-motion: reduce) {
  .anime-action-cue { animation: anime-action-fade .16s ease-out both; }
  .anime-action-burst { display: none; }
}
@keyframes anime-action-fade { from { opacity: 0; } to { opacity: 1; } }
</style>
