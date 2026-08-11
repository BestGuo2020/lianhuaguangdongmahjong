<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const required = ref(false)
const message = ref('')

function update() {
  const isPortrait = window.matchMedia('(orientation: portrait)').matches
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
  const isMobileViewport = Math.min(window.innerWidth, window.innerHeight) <= 1024
  required.value = isPortrait && isTouchDevice && isMobileViewport
  if (!required.value) message.value = ''
}

async function enterLandscapeFullscreen() {
  message.value = ''
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    }
    const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> }
    await orientation?.lock?.('landscape')
  } catch {
    message.value = '当前浏览器无法自动旋转，请将手机横置后继续'
  } finally {
    update()
  }
}

onMounted(() => {
  update()
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', update)
  screen.orientation?.addEventListener?.('change', update)
})

onUnmounted(() => {
  window.removeEventListener('resize', update)
  window.removeEventListener('orientationchange', update)
  screen.orientation?.removeEventListener?.('change', update)
})
</script>

<template>
  <div v-if="required" class="orientation-gate" role="dialog" aria-modal="true" aria-labelledby="orientation-title">
    <div class="orientation-card">
      <div class="phone-rotate-icon" aria-hidden="true"><span></span></div>
      <p class="eyebrow">LANDSCAPE MODE</p>
      <h2 id="orientation-title">请横屏游玩</h2>
      <p>为了完整显示牌桌，请进入全屏并将手机旋转为横屏。</p>
      <button type="button" @click="enterLandscapeFullscreen">进入全屏横屏</button>
      <small v-if="message" role="status">{{ message }}</small>
    </div>
  </div>
</template>
