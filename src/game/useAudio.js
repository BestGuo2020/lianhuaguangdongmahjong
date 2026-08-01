import { onBeforeUnmount, ref, watch } from 'vue'

const AUDIO_BASE = `${import.meta.env.BASE_URL}audio/`

export function useAudio() {
  const soundOn = ref(true)
  const bgmStarted = ref(false)
  const activeEffects = new Set()
  const bgm = new Audio(`${AUDIO_BASE}bg.ogg`)
  bgm.loop = true
  bgm.volume = 0.32

  function playEffect(name, volume = 1, onFinish) {
    if (!soundOn.value || !name) return null
    const audio = new Audio(`${AUDIO_BASE}${name}`)
    audio.volume = volume
    activeEffects.add(audio)
    let finished = false
    const release = () => {
      if (finished) return
      finished = true
      activeEffects.delete(audio)
      onFinish?.()
    }
    audio.__releaseEffect = release
    audio.addEventListener('ended', release, { once: true })
    audio.addEventListener('error', release, { once: true })
    audio.play().catch(release)
    return audio
  }

  function playEffectAndWait(name, volume = 1) {
    if (!soundOn.value || !name) return Promise.resolve()
    return new Promise((resolve) => {
      const audio = playEffect(name, volume, resolve)
      if (!audio) resolve()
    })
  }

  function startBgm() {
    bgmStarted.value = true
    if (soundOn.value) bgm.play().catch(() => {})
  }

  function stopEffects() {
    activeEffects.forEach((audio) => {
      audio.pause()
      audio.currentTime = 0
      audio.__releaseEffect?.()
    })
    activeEffects.clear()
  }

  watch(soundOn, (enabled) => {
    if (!enabled) {
      bgm.pause()
      stopEffects()
    } else if (bgmStarted.value) {
      bgm.play().catch(() => {})
    }
  })

  onBeforeUnmount(() => {
    bgm.pause()
    stopEffects()
  })

  return { soundOn, playEffect, playEffectAndWait, startBgm }
}
