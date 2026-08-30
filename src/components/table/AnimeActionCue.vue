<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GamePlayer, TableActionEvent } from '../../game/core/contracts/types'
import { animeActionPresentation } from '../../game/core/presentation/animeActionPresentation'
import { animePortraitUrl, resolveShippedAnimePortraitId } from '../../game/core/presentation/llmAnimeAssets'
import { resolveAnimeCharacter } from '../../game/llm/animeCharacters'

const props = defineProps<{
  event: TableActionEvent
  player?: GamePlayer
  position: string
}>()

const portraitFailed = ref(false)
const action = computed(() => animeActionPresentation(props.event.type))
const character = computed(() => resolveAnimeCharacter(resolveShippedAnimePortraitId(props.player?.characterId)))
const portrait = computed(() => animePortraitUrl(portraitFailed.value ? 'deepseek' : character.value.id))

watch(() => [props.event.id, character.value.id], () => { portraitFailed.value = false })

function onPortraitError(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  if (!portraitFailed.value && image.src !== new URL(animePortraitUrl('deepseek'), window.location.href).href) {
    portraitFailed.value = true
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
    :aria-label="`${character.label}${action.label}`"
  >
    <div class="anime-action-burst" aria-hidden="true"></div>
    <img :src="portrait" alt="" aria-hidden="true" @error="onPortraitError">
    <div class="anime-action-copy" aria-hidden="true">
      <strong :data-text="action.label">{{ action.label }}</strong>
      <small>{{ character.label }}</small>
    </div>
  </div>
</template>

<style scoped>
.anime-action-cue {
  position: absolute;
  z-index: 45;
  width: clamp(210px, 25vw, 390px);
  height: clamp(150px, 22vw, 330px);
  overflow: hidden;
  pointer-events: none;
  filter: drop-shadow(0 13px 20px rgba(12, 5, 42, .62));
  isolation: isolate;
  animation: anime-action-enter .26s cubic-bezier(.16, .88, .25, 1.08) both;
}
.anime-action-cue::before {
  content: '';
  position: absolute;
  z-index: -2;
  inset: 12% 2% 3%;
  border: 2px solid rgba(213, 225, 255, .78);
  border-radius: 44% 56% 20% 28% / 35% 34% 24% 28%;
  background: linear-gradient(145deg, rgba(28, 36, 105, .88), rgba(121, 54, 154, .72) 58%, rgba(245, 108, 177, .52));
  box-shadow: inset 0 0 26px rgba(137, 190, 255, .28), 0 0 18px rgba(218, 121, 255, .38);
  transform: skewX(-5deg);
}
.anime-action-burst {
  position: absolute;
  z-index: -1;
  inset: 1%;
  opacity: .8;
  background:
    radial-gradient(circle at 72% 63%, rgba(255,255,255,.85) 0 2%, transparent 3%),
    repeating-conic-gradient(from 18deg at 66% 64%, rgba(255,255,255,.36) 0 2deg, transparent 3deg 15deg);
  mask-image: radial-gradient(circle at 66% 64%, #000 0 7%, transparent 58%);
}
.anime-action-cue img {
  position: absolute;
  left: 0;
  bottom: -21%;
  width: 68%;
  height: 122%;
  object-fit: contain;
  object-position: center bottom;
  filter: drop-shadow(7px 9px 5px rgba(18, 6, 47, .5));
}
.anime-action-copy {
  position: absolute;
  right: 4%;
  bottom: 9%;
  display: grid;
  justify-items: end;
  transform: rotate(-5deg);
}
.anime-action-copy strong {
  position: relative;
  color: #eaff8b;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: clamp(47px, 7vw, 104px);
  font-weight: 1000;
  line-height: .92;
  letter-spacing: -.08em;
  paint-order: stroke fill;
  -webkit-text-stroke: clamp(4px, .55vw, 9px) #1771c8;
  text-shadow: 0 5px 0 #0a2b70, 0 0 8px #fff, 0 0 18px #84e9ff;
}
.anime-action-copy strong::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  z-index: -1;
  color: transparent;
  -webkit-text-stroke: clamp(7px, .85vw, 13px) rgba(241, 248, 255, .96);
}
.anime-action-copy small {
  margin-top: 7px;
  padding: 3px 10px;
  border: 1px solid rgba(223, 229, 255, .64);
  border-radius: 999px;
  background: rgba(26, 20, 75, .82);
  color: #fff4ff;
  font-size: clamp(10px, 1.2vw, 15px);
  font-weight: 800;
  letter-spacing: .08em;
}
.anime-action-zimo .anime-action-copy strong,
.anime-action-qiangganghu .anime-action-copy strong { font-size: clamp(37px, 5vw, 76px); letter-spacing: -.12em; }
.action-from-top { top: 15%; left: 50%; transform: translate(-50%, -50%); }
.action-from-right { top: 42%; right: 11%; transform: translate(50%, -50%); }
.action-from-bottom { bottom: 13%; left: 50%; transform: translate(-50%, 50%); }
.action-from-left { top: 42%; left: 11%; transform: translate(-50%, -50%); }
.action-from-left img { left: auto; right: 0; transform: scaleX(-1); }
.action-from-left .anime-action-copy { right: auto; left: 4%; align-items: start; }
@keyframes anime-action-enter {
  from { opacity: 0; scale: .75; filter: blur(5px) drop-shadow(0 13px 20px rgba(12,5,42,.62)); }
  to { opacity: 1; scale: 1; filter: blur(0) drop-shadow(0 13px 20px rgba(12,5,42,.62)); }
}
@media (max-width: 760px), (max-height: 520px) {
  .anime-action-cue { width: clamp(170px, 28vw, 260px); height: clamp(120px, 23vw, 190px); }
  .action-from-right { right: 8%; }.action-from-left { left: 8%; }
}
@media (prefers-reduced-motion: reduce) {
  .anime-action-cue { animation: anime-action-fade .16s ease-out both; }
  .anime-action-burst { display: none; }
}
@keyframes anime-action-fade { from { opacity: 0; } to { opacity: 1; } }
</style>
