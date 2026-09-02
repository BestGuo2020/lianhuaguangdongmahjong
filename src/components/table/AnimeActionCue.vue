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
  /* R6.23：PC 立绘按用户红框目标放大约 15%（手机分档在下方媒体块，不受影响）。 */
  width: clamp(110px, 9.8vw, 152px);
  height: clamp(83px, 8vw, 117px);
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
  right: -8%;
  bottom: -4%;
  width: 74%;
  height: 58%;
  border: 0;
  background: radial-gradient(ellipse at 58% 58%, rgba(10, 27, 22, .72) 0 34%, rgba(34, 75, 63, .38) 54%, transparent 78%);
  box-shadow: none;
}
.anime-action-burst {
  position: absolute;
  z-index: -1;
  inset: -18% -24%;
  opacity: .66;
  border: 0;
  background:
    radial-gradient(circle at 42% 54%, color-mix(in srgb, var(--anime-accent, #9e5148) 46%, transparent) 0 3%, transparent 32%),
    conic-gradient(from 12deg at 42% 54%, transparent 0 9%, rgba(133, 224, 241, .42) 10% 11%, transparent 12% 29%, rgba(235, 142, 167, .38) 30% 31%, transparent 32% 100%);
  -webkit-mask-image: radial-gradient(circle at 42% 54%, #000 0 18%, rgba(0,0,0,.72) 35%, transparent 70%);
  mask-image: radial-gradient(circle at 42% 54%, #000 0 18%, rgba(0,0,0,.72) 35%, transparent 70%);
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
  top: calc((1 - var(--action-art-scale)) * 50%);
  left: calc((1 - var(--action-art-scale)) * 50%);
  width: calc(100% * var(--action-art-scale));
  height: calc(100% * var(--action-art-scale));
  border: 0;
  border-radius: 0;
  object-fit: contain;
  object-position: center;
  -webkit-mask-image: radial-gradient(ellipse at 44% 50%, #000 0 32%, rgba(0,0,0,.92) 46%, rgba(0,0,0,.48) 61%, transparent 79%);
  mask-image: radial-gradient(ellipse at 44% 50%, #000 0 32%, rgba(0,0,0,.92) 46%, rgba(0,0,0,.48) 61%, transparent 79%);
  filter: saturate(1.08) contrast(1.02) drop-shadow(3px 4px 0 rgba(45, 36, 28, .26));
}
.anime-action-copy {
  position: absolute;
  right: calc((1 - var(--action-art-scale)) * 50%);
  bottom: calc((1 - var(--action-art-scale)) * 50%);
  display: grid;
  justify-items: end;
  transform: rotate(-4deg);
}
.anime-action-copy strong {
  position: relative;
  color: #fff8e7;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: clamp(10px, 5.9vh, 76px);
  font-weight: 1000;
  line-height: .92;
  letter-spacing: -.08em;
  paint-order: stroke fill;
  -webkit-text-stroke: clamp(4px, .44vw, 6px) #2d241c;
  text-shadow: 3px 3px 0 rgba(45, 36, 28, .22);
}
.anime-action-copy strong::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  z-index: -1;
  color: transparent;
  -webkit-text-stroke: clamp(8px, .76vw, 12px) var(--anime-accent, #bd5b48);
}
.anime-action-zimo .anime-action-copy strong,
.anime-action-qiangganghu .anime-action-copy strong { font-size: clamp(44px, 4.7vw, 72px); letter-spacing: -.12em; }
.anime-action-cue.anime-action-hu,
.anime-action-cue.anime-action-zimo,
.anime-action-cue.anime-action-qiangganghu {
  /* 胡牌与吃碰杠同尺寸（用户确认）；仅叠加串行演出动画。 */
  animation: anime-win-cue-serial calc(1600ms + 400ms) ease-out both;
}
/* 四个方向的座位锚点统一由共享样式表（src/style.css）维护；
   组件内只保留镜像、文字等纯视觉规则。 */
.action-from-left img.base-q-avatar { left: auto; right: 0; transform: scaleX(-1); }
.action-from-left .anime-action-copy {
  right: auto;
  left: calc((1 - var(--action-art-scale)) * 50%);
  align-items: start;
  transform: rotate(-4deg);
}
@keyframes anime-action-enter {
  from { opacity: 0; scale: .88; filter: blur(2px) drop-shadow(3px 5px 0 rgba(45,36,28,.26)); }
  to { opacity: 1; scale: 1; filter: blur(0) drop-shadow(3px 5px 0 rgba(45,36,28,.26)); }
}
@keyframes anime-win-cue-serial {
  0% { opacity: 0; scale: .82; filter: blur(2px) drop-shadow(3px 5px 0 rgba(45,36,28,.26)); }
  16%, 74% { opacity: 1; scale: 1; filter: blur(0) drop-shadow(3px 5px 0 rgba(45,36,28,.26)); }
  100% { opacity: 0; scale: .96; filter: blur(1px) drop-shadow(3px 5px 0 rgba(45,36,28,.18)); }
}
@media (hover: none) and (pointer: coarse) and (orientation: landscape) {
  /* 移动端只收敛视觉尺寸；座位锚点与 --action-art-scale 均由共享样式表提供（R6.19）。 */
  .anime-action-cue {
    width: clamp(84px, 13cqw, 112px);
    max-width: var(--action-art-max-width);
    height: clamp(64px, 10cqw, 86px);
    max-height: var(--action-art-max-height);
  }
}
@media (prefers-reduced-motion: reduce) {
  .anime-action-cue { animation: anime-action-fade .16s ease-out both; }
  .anime-action-burst { display: none; }
}
@keyframes anime-action-fade { from { opacity: 0; } to { opacity: 1; } }
</style>
