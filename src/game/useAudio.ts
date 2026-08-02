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
  const effectObjectUrls = new Set<string>()
  const bgm = new Audio(`${AUDIO_BASE}bg.ogg`)
  bgm.preload = 'auto'
  bgm.loop = true
  bgm.volume = 0.32

  function createTemplate(src: string) {
    const audio = new Audio(src)
    audio.preload = 'auto'
    audio.load()
    return audio
  }

  async function preloadEffect(name: string) {
    try {
      const response = await fetch(`${AUDIO_BASE}${name}`, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`Failed to preload audio: ${name}`)
      const objectUrl = URL.createObjectURL(await response.blob())
      effectObjectUrls.add(objectUrl)
      effectTemplates.set(name, createTemplate(objectUrl))
    } catch {
      // 单个资源异常时保留网络地址回退，避免阻断整局游戏。
      effectTemplates.set(name, createTemplate(`${AUDIO_BASE}${name}`))
    }
  }

  // 主动 fetch 才能确保移动浏览器完整下载资源；单纯 audio.preload 可能被系统忽略。
  const effectsReady = Promise.all(EFFECT_AUDIO_FILES.map(preloadEffect)).then(() => {})

  function prepareEffects() {
    return effectsReady
  }

  function playEffect(name: string, volume = 1, onFinish?: () => void): EffectAudio | null {
    if (!soundOn.value || !name) return null
    const template = effectTemplates.get(name)
    const audio = (template
      ? template.cloneNode(true)
      : new Audio(`${AUDIO_BASE}${name}`)) as EffectAudio
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
    effectObjectUrls.forEach((url) => URL.revokeObjectURL(url))
    effectObjectUrls.clear()
    effectTemplates.clear()
  })

  return { soundOn, playEffect, playEffectAndWait, prepareEffects, startBgm }
}
