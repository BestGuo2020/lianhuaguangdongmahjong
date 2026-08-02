import { onBeforeUnmount, ref, watch } from 'vue'

const AUDIO_BASE = `${import.meta.env.BASE_URL}audio/`
const SUIT_AUDIO_FILES = ['m', 'p', 's'].flatMap((suit) => (
  Array.from({ length: 9 }, (_, index) => `${index + 1}${suit}.mp3`)
))
const HONOR_AUDIO_FILES = Array.from({ length: 7 }, (_, index) => `${index + 1}z.mp3`)
const EFFECT_AUDIO_FILES = [
  ...SUIT_AUDIO_FILES,
  ...HONOR_AUDIO_FILES,
  'chi.mp3',
  'click.mp3',
  'dapai.mp3',
  'deal.mp3',
  'dice.mp3',
  'game_start.mp3',
  'gang.mp3',
  'give.mp3',
  'hu.mp3',
  'hu_effect_sound.mp3',
  'peng.mp3',
  'zimo.mp3',
]

type EffectAudio = HTMLAudioElement & { __releaseEffect?: () => void }

export function useAudio() {
  const soundOn = ref(true)
  const bgmStarted = ref(false)
  const activeEffects = new Set<EffectAudio>()
  const effectTemplates = new Map<string, HTMLAudioElement>()
  const bgm = new Audio(`${AUDIO_BASE}bg.ogg`)
  bgm.preload = 'auto'
  bgm.loop = true
  bgm.volume = 0.32

  function preloadEffect(name: string) {
    const cached = effectTemplates.get(name)
    if (cached) return cached

    const audio = new Audio(`${AUDIO_BASE}${name}`)
    audio.preload = 'auto'
    audio.load()
    effectTemplates.set(name, audio)
    return audio
  }

  // 大厅阶段提前下载全部短音效。文件总量很小，可避免线上首次碰、杠或报牌时才请求资源。
  EFFECT_AUDIO_FILES.forEach(preloadEffect)

  function playEffect(name: string, volume = 1, onFinish?: () => void): EffectAudio | null {
    if (!soundOn.value || !name) return null
    const template = preloadEffect(name)
    const audio = template.cloneNode(true) as EffectAudio
    audio.preload = 'auto'
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

  function playEffectAndWait(name: string, volume = 1): Promise<void> {
    if (!soundOn.value || !name) return Promise.resolve()
    return new Promise<void>((resolve) => {
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
