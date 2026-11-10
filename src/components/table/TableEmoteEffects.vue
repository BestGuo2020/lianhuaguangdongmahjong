<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import TableEmoteArt from './TableEmoteArt.vue'
import type { TableEmoteCue } from './useTableInteractions'

const props = defineProps<{ cues: readonly TableEmoteCue[] }>()
const root = ref<HTMLElement | null>(null)
const size = shallowRef({ width: 1, height: 1 })
const anchors = shallowRef<Record<number, { x: number; y: number; avatarSize: number }>>({})
let observer: ResizeObserver | undefined
const hitTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

function measure() {
  const layer = root.value
  if (!layer) return
  const rect = layer.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const width = layer.clientWidth
  const height = layer.clientHeight
  const scaleX = width / rect.width
  const scaleY = height / rect.height
  const next: typeof anchors.value = {}
  for (const seat of layer.parentElement?.querySelectorAll<HTMLElement>('[data-table-seat]') ?? []) {
    const avatar = seat.querySelector('.avatar')?.getBoundingClientRect()
    if (!avatar) continue
    next[Number(seat.dataset.tableSeat)] = {
      x: (avatar.left + avatar.width / 2 - rect.left) * scaleX,
      y: (avatar.top + avatar.height / 2 - rect.top) * scaleY,
      avatarSize: Math.max(avatar.width * scaleX, avatar.height * scaleY),
    }
  }
  size.value = { width, height }
  anchors.value = next
}

const performances = computed(() => props.cues.flatMap(cue => {
  const from = anchors.value[cue.fromSeat]
  const target = anchors.value[cue.targetSeat]
  if (!from || !target) return []
  const dx = target.x - from.x
  const lift = Math.min(150, Math.max(58, Math.abs(dx) * 0.22 + 38))
  const midX = from.x + dx * 0.5
  const midY = Math.max(24, Math.min(from.y, target.y) - lift)
  return [{
    ...cue, from, target,
    path: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${target.x.toFixed(1)} ${target.y.toFixed(1)}`,
  }]
}))

function shakeAvatar(seat: number) {
  const avatar = root.value?.parentElement?.querySelector<HTMLElement>(`[data-table-seat="${seat}"] .avatar`)
  if (!avatar) return
  clearTimeout(hitTimers.get(avatar))
  avatar.classList.remove('table-emote-hit')
  void avatar.offsetWidth
  avatar.classList.add('table-emote-hit')
  hitTimers.set(avatar, setTimeout(() => {
    avatar.classList.remove('table-emote-hit')
    hitTimers.delete(avatar)
  }, 560))
}

watch(() => props.cues, measure, { flush: 'post' })
onMounted(() => {
  const layer = root.value
  if (!layer) return
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(layer)
  layer.parentElement?.querySelectorAll('[data-table-seat]').forEach(seat => observer?.observe(seat))
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', measure)
  for (const [avatar, timer] of hitTimers) {
    clearTimeout(timer)
    avatar.classList.remove('table-emote-hit')
  }
})
</script>

<template>
  <div ref="root" class="table-emote-effects" aria-hidden="true">
    <div v-for="cue in performances" :key="cue.id" class="emote-performance" :data-emote="cue.emote"
      :data-emote-id="cue.id" :data-from-seat="cue.fromSeat" :data-target-seat="cue.targetSeat">
      <svg class="emote-route" :viewBox="`0 0 ${size.width} ${size.height}`" aria-hidden="true">
        <path class="emote-route-glow" :d="cue.path" pathLength="1" />
        <path class="emote-route-line" :d="cue.path" pathLength="1" />
      </svg>
      <div class="emote-start-puff" :style="{ left: `${cue.from.x}px`, top: `${cue.from.y}px` }"></div>
      <div class="emote-target-ring" :style="{
        left: `${cue.target.x}px`, top: `${cue.target.y}px`,
        width: `${cue.target.avatarSize + 32}px`, height: `${cue.target.avatarSize + 32}px`,
      }"></div>
      <div class="emote-projectile" :style="{ offsetPath: `path('${cue.path}')` }">
        <div class="emote-projectile-art"><TableEmoteArt :kind="cue.emote" :size="48" /></div>
      </div>
      <div class="emote-impact" :style="{ left: `${cue.target.x}px`, top: `${cue.target.y}px` }"
        @animationstart.self="shakeAvatar(cue.targetSeat)">
        <i class="emote-impact-star"></i>
        <i class="emote-impact-burst"></i>
        <i v-for="n in 8" :key="n" class="emote-particle" :style="{ '--angle': `${n * 45}deg` }"></i>
        <TableEmoteArt :kind="cue.emote" :size="100" impact class="emote-impact-art" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-emote-effects {
  position: absolute;
  inset: 0;
  z-index: 60;
  overflow: hidden;
  pointer-events: none;
}
.emote-performance { position: absolute; inset: 0; }
.emote-route { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.emote-route path { fill: none; stroke-linecap: round; stroke-dasharray: 1 1; }
.emote-route-glow { stroke: #ffd36e; stroke-width: 5; opacity: 0; filter: blur(2px); animation: emote-route .58s ease-out both; }
.emote-route-line { stroke: #fff0bd; stroke-width: 1.2; opacity: 0; animation: emote-route .58s ease-out both; }
.emote-start-puff {
  position: absolute;
  width: 30px;
  height: 30px;
  margin: -15px;
  border: 2px solid #ffe2a0;
  border-radius: 50%;
  opacity: 0;
  animation: emote-puff .5s ease-out both;
}
.emote-projectile {
  position: absolute;
  left: 0;
  top: 0;
  width: 48px;
  height: 48px;
  offset-anchor: 50% 50%;
  offset-rotate: 0deg;
  animation: emote-travel .6s cubic-bezier(.2, .7, .3, 1) both,
    emote-projectile-fade .12s ease-out .48s both;
}
.emote-projectile-art { width: 100%; height: 100%; animation: emote-spin .6s linear both; }
/* 点赞/亲吻是手势，飞行时保持正向，不做翻转。 */
.emote-performance[data-emote="like"] .emote-projectile-art,
.emote-performance[data-emote="kiss"] .emote-projectile-art { animation: none; }
.emote-target-ring {
  position: absolute;
  border: 2px solid #ffd36e;
  border-radius: 50%;
  box-shadow: 0 0 14px rgba(255, 211, 110, .5), inset 0 0 12px rgba(255, 211, 110, .2);
  opacity: 0;
  transform: translate(-50%, -50%) scale(.65);
  animation: emote-ring .8s ease-out .42s both;
}
.emote-impact {
  position: absolute;
  display: grid;
  place-items: center;
  width: 120px;
  height: 120px;
  opacity: 0;
  transform: translate(-50%, -50%) scale(.3);
  animation: emote-impact 1.3s cubic-bezier(.2, .8, .3, 1) .48s both;
}
.emote-impact-star {
  position: absolute;
  z-index: 0;
  width: 80px;
  height: 80px;
  background: #fff1b8;
  clip-path: polygon(50% 0, 61% 30%, 93% 25%, 70% 50%, 93% 75%, 61% 70%, 50% 100%, 39% 70%, 7% 75%, 30% 50%, 7% 25%, 39% 30%);
  filter: drop-shadow(0 0 6px #ffd36e);
  opacity: 0;
  animation: emote-star .6s cubic-bezier(.2, .8, .3, 1) .45s both;
}
.emote-impact-burst {
  position: absolute;
  z-index: 0;
  inset: 6px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 226, 150, .9) 0 28%, rgba(255, 178, 70, .4) 52%, transparent 72%);
}
.emote-particle {
  position: absolute;
  width: 5px;
  height: 5px;
  margin: -2.5px;
  border-radius: 50%;
  background: #ffe8a3;
  box-shadow: 0 0 4px #ffd36e;
  opacity: 0;
  animation: emote-particle .65s ease-out .5s both;
}
.emote-impact-art { position: relative; z-index: 2; }
.emote-performance[data-emote="banana"] .emote-impact-art {
  transform-origin: 50% 35%;
  animation: banana-stick 1.2s cubic-bezier(.2, .8, .3, 1) .52s both;
}
@keyframes banana-stick {
  0% { opacity: 0; transform: scale(1.3) rotate(-8deg); }
  10% { opacity: 1; transform: scale(1.08) rotate(-3deg); }
  32% { opacity: 1; transform: scale(1.03) rotate(0); }
  55% { opacity: 1; transform: scale(1) rotate(3deg); }
  82% { opacity: 1; transform: translateY(16px) scale(.98) rotate(12deg); }
  100% { opacity: 0; transform: translateY(30px) scale(.92) rotate(18deg); }
}
/* 除香蕉外不套黄色光晕，命中用中性白闪。 */
.emote-performance:not([data-emote="banana"]) .emote-impact-star { display: none; }
.emote-performance:not([data-emote="banana"]) .emote-impact-burst {
  background: radial-gradient(circle, rgba(255, 255, 255, .85) 0 26%, rgba(255, 255, 255, .22) 52%, transparent 72%);
}
.emote-performance:not([data-emote="banana"]) .emote-particle {
  background: #fff;
  box-shadow: 0 0 4px rgba(255, 255, 255, .7);
}
.emote-performance:not([data-emote="banana"]) .emote-target-ring {
  border-color: rgba(255, 255, 255, .85);
  box-shadow: 0 0 14px rgba(255, 255, 255, .35), inset 0 0 12px rgba(255, 255, 255, .16);
}
.emote-performance:not([data-emote="banana"]) .emote-route-glow { stroke: #fff; }
.emote-performance:not([data-emote="banana"]) .emote-route-line { stroke: #fff; }
.emote-performance:not([data-emote="banana"]) .emote-start-puff { border-color: rgba(255, 255, 255, .8); }

@keyframes emote-route {
  0% { stroke-dashoffset: 1; opacity: 0; }
  18% { opacity: .5; }
  72% { stroke-dashoffset: 0; opacity: .42; }
  100% { stroke-dashoffset: 0; opacity: 0; }
}
@keyframes emote-puff {
  0% { opacity: 0; transform: scale(.4); }
  25% { opacity: .8; }
  100% { opacity: 0; transform: scale(1.5); }
}
@keyframes emote-travel {
  from { offset-distance: 0%; }
  to { offset-distance: 100%; }
}
@keyframes emote-projectile-fade {
  to { opacity: 0; }
}
@keyframes emote-spin {
  to { transform: rotate(520deg); }
}
@keyframes emote-ring {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(.65); }
  25% { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(1.18); }
}
@keyframes emote-star {
  0% { opacity: 0; transform: scale(.2) rotate(-30deg); }
  25% { opacity: .95; transform: scale(1.15) rotate(6deg); }
  60% { opacity: .8; transform: scale(1) rotate(0); }
  100% { opacity: 0; transform: scale(.9); }
}
@keyframes emote-particle {
  0% { opacity: 0; transform: rotate(var(--angle)) translateY(-4px) scale(.5); }
  25% { opacity: 1; }
  100% { opacity: 0; transform: rotate(var(--angle)) translateY(-38px) scale(1); }
}
@keyframes emote-impact {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(.3); }
  18% { opacity: 1; transform: translate(-50%, -50%) scale(1.12); }
  78% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(.92); }
}
@media (prefers-reduced-motion: reduce) {
  .emote-route,
  .emote-start-puff,
  .emote-projectile,
  .emote-impact-star,
  .emote-particle { display: none; }
  .emote-target-ring { animation: emote-ring .2s ease-out both; }
  .emote-impact { animation-duration: .3s; animation-delay: 0s; }
}
</style>
