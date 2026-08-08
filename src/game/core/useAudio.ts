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
  // BGM：优先走 Web Audio 的 BufferSource.loop —— 循环边界样本级无缝，避免
  // HTMLAudio loop 每次到头 seek/缓冲的卡顿。Web Audio 不可用时回退 HTMLAudio。
  let audioContext: AudioContext | null = null
  let bgmBuffer: AudioBuffer | null = null
  let bgmSource: AudioBufferSourceNode | null = null
  let bgmGain: GainNode | null = null
  let bgmWebAudio = false
  let bgmPreloadPromise: Promise<void> | null = null
  // HTMLAudio 兜底（无 Web Audio / 解码失败时使用）
  const bgm = new Audio(`${AUDIO_BASE}bg.ogg`)
  bgm.preload = 'auto'
  bgm.loop = true
  bgm.volume = 0.32
  let bgmFallbackSrc: string | null = null

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

  // 保持预加载任务活跃，但不让网络请求阻塞牌桌首次渲染。
  void effectsReady

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

  function ensureAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (!audioContext) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext
      if (!Ctor) return null
      try {
        audioContext = new Ctor()
      } catch {
        return null
      }
    }
    return audioContext
  }

  // BGM 主动下载并解码（移动端 preload='auto' 可能被忽略）。首次用户交互时触发：
  // 同步创建/恢复 AudioContext（手势内解锁自动播放策略），fetch+decode 在后台完成。
  function preloadBgm(): Promise<void> {
    if (bgmPreloadPromise) return bgmPreloadPromise
    const ctx = ensureAudioContext()
    if (ctx && ctx.state === 'suspended') void ctx.resume()
    bgmPreloadPromise = (async () => {
      try {
        const response = await fetch(`${AUDIO_BASE}bg.ogg`, { cache: 'force-cache' })
        if (!response.ok) throw new Error(`Failed to preload bgm: ${response.status}`)
        const arrayBuffer = await response.arrayBuffer()
        if (ctx) {
          bgmBuffer = await ctx.decodeAudioData(arrayBuffer)
          bgmWebAudio = true
        } else {
          const objectUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: 'audio/ogg' }))
          effectObjectUrls.add(objectUrl)
          bgmFallbackSrc = objectUrl
        }
      } catch {
        // 解码/下载失败：保持 HTMLAudio 网络地址回退
      }
    })()
    return bgmPreloadPromise
  }

  // Web Audio 无缝循环：BufferSource.loop 在缓冲区边界样本级拼接，无 HTMLAudio 的卡顿。
  function playBgmWebAudio() {
    const ctx = ensureAudioContext()
    if (!ctx || !bgmBuffer || bgmSource) return
    if (ctx.state === 'suspended') void ctx.resume()
    if (!bgmGain) {
      bgmGain = ctx.createGain()
      bgmGain.gain.value = 0.32
      bgmGain.connect(ctx.destination)
    }
    const source = ctx.createBufferSource()
    source.buffer = bgmBuffer
    source.loop = true
    source.connect(bgmGain)
    source.start(0)
    source.onended = () => { if (bgmSource === source) bgmSource = null }
    bgmSource = source
  }

  async function startBgm() {
    bgmStarted.value = true
    if (!soundOn.value) return
    await preloadBgm()   // 确保 buffer 就绪，避免开局静音
    if (!bgmStarted.value || !soundOn.value) return
    if (bgmWebAudio && bgmBuffer) {
      playBgmWebAudio()
    } else if (bgmFallbackSrc && bgm.src !== bgmFallbackSrc) {
      bgm.src = bgmFallbackSrc
      bgm.play().catch(() => {})
    } else {
      bgm.play().catch(() => {})
    }
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
      // Web Audio：suspend 保留播放位置，再次开启时 resume 无缝续播
      if (bgmWebAudio) void audioContext?.suspend()
      else bgm.pause()
      stopEffects()
    } else if (bgmStarted.value) {
      if (bgmWebAudio && audioContext) {
        if (audioContext.state === 'suspended') void audioContext.resume()
        if (!bgmSource && bgmBuffer) playBgmWebAudio()
      } else {
        bgm.play().catch(() => {})
      }
    }
  })

  onBeforeUnmount(() => {
    if (bgmWebAudio) {
      bgmSource?.stop()
      bgmSource = null
      void audioContext?.close()
      audioContext = null
    } else {
      bgm.pause()
    }
    stopEffects()
    effectObjectUrls.forEach((url) => URL.revokeObjectURL(url))
    effectObjectUrls.clear()
    effectTemplates.clear()
  })

  return { soundOn, playEffect, playEffectAndWait, startBgm, preloadBgm }
}
