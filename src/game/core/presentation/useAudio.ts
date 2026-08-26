import { getCurrentInstance, inject, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import type { InjectionKey, Ref } from 'vue'
import {
  registerLlmAudioPlayer,
  subscribeLocalLlmAudio,
  type LlmAudioPlaybackHooks,
} from './llmAudioBus'
import type { LlmSpeechPriority } from '../../llm/speechPolicy'

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
  'didu.ogg',
]
const EFFECT_WAIT_TIMEOUT_MS = 4_000
const BGM_VOLUME = 0.32
const BGM_DUCKED_VOLUME = 0.08
const BGM_DUCK_RAMP_SECONDS = 0.12
const NORMAL_LLM_AUDIO_TTL_MS = 3_000
const IMPORTANT_LLM_AUDIO_TTL_MS = 10_000
const LLM_AUDIO_PLAYBACK_TIMEOUT_MS = 12_000
export const AUDIO_PREFERENCES_STORAGE_KEY = 'lianhua-guangma:audio-preferences:v1'

interface AudioPreferences {
  soundOn: boolean
  bgmOn: boolean
  effectsOn: boolean
}

export interface AudioControls {
  soundOn: Ref<boolean>
  bgmOn: Ref<boolean>
  effectsOn: Ref<boolean>
}

const AUDIO_CONTROLS_KEY: InjectionKey<AudioControls> = Symbol('audio-controls')

export function useAudioControls(): AudioControls {
  const controls = inject(AUDIO_CONTROLS_KEY, null)
  if (!controls) throw new Error('Audio controls must be used below useAudio()')
  return controls
}

const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  soundOn: true,
  bgmOn: true,
  effectsOn: true,
}

function readAudioPreferences(): AudioPreferences {
  try {
    const stored = globalThis.localStorage?.getItem(AUDIO_PREFERENCES_STORAGE_KEY)
    if (!stored) return DEFAULT_AUDIO_PREFERENCES
    const parsed = JSON.parse(stored) as Partial<AudioPreferences>
    return {
      soundOn: typeof parsed.soundOn === 'boolean' ? parsed.soundOn : true,
      bgmOn: typeof parsed.bgmOn === 'boolean' ? parsed.bgmOn : true,
      effectsOn: typeof parsed.effectsOn === 'boolean' ? parsed.effectsOn : true,
    }
  } catch {
    return DEFAULT_AUDIO_PREFERENCES
  }
}

function persistAudioPreferences(preferences: AudioPreferences) {
  try {
    globalThis.localStorage?.setItem(AUDIO_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // 隐私模式或存储配额异常时只放弃持久化，不影响本局声音控制。
  }
}

type EffectAudio = HTMLAudioElement & { __releaseEffect?: () => void }
interface LlmAudioItem {
  url: string
  seat: number
  messageId: number
  priority: LlmSpeechPriority
  enqueuedAt: number
  waitForMidpoint?: boolean
  onStarted?: () => void
  fallbackMidpointMs?: number
  resolveMidpoint?: (played: boolean) => void
  cancel?: () => void
}

export function useAudio() {
  const initialPreferences = readAudioPreferences()
  const soundOn = ref(initialPreferences.soundOn)
  const bgmOn = ref(initialPreferences.bgmOn)
  const effectsOn = ref(initialPreferences.effectsOn)
  const controls: AudioControls = { soundOn, bgmOn, effectsOn }
  // App 根组件在 setup 中初始化音频；子组件直接注入控制状态，避免两条联机分支
  // 各自维护一套声音 props/事件接线。
  if (getCurrentInstance()) provide(AUDIO_CONTROLS_KEY, controls)
  const bgmStarted = ref(false)
  const activeEffects = new Set<EffectAudio>()
  const effectTemplates = new Map<string, HTMLAudioElement>()
  const effectObjectUrls = new Set<string>()
  const llmAudioQueue: LlmAudioItem[] = []
  let activeLlmAudio: HTMLAudioElement | null = null
  let activeLlmItem: LlmAudioItem | null = null
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
  bgm.volume = BGM_VOLUME
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
    if (!soundOn.value || !effectsOn.value || !name) return null
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
    if (!soundOn.value || !effectsOn.value || !name) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let timeoutId: number | undefined
      const finish = () => {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        resolve()
      }
      const audio = playEffect(name, volume, finish)
      if (!audio) {
        finish()
        return
      }
      // Audio loading/decoding is decorative and must never block the game timeline.
      timeoutId = window.setTimeout(() => {
        audio.__releaseEffect?.()
        finish()
      }, EFFECT_WAIT_TIMEOUT_MS)
    })
  }

  function setBgmDucked(ducked: boolean) {
    const target = ducked ? BGM_DUCKED_VOLUME : BGM_VOLUME
    bgm.volume = target
    if (!bgmGain || !audioContext) return
    const now = audioContext.currentTime
    bgmGain.gain.cancelScheduledValues(now)
    bgmGain.gain.setValueAtTime(bgmGain.gain.value, now)
    bgmGain.gain.linearRampToValueAtTime(target, now + BGM_DUCK_RAMP_SECONDS)
  }

  function settleLlmMidpoint(item: LlmAudioItem, played: boolean) {
    const resolve = item.resolveMidpoint
    if (!resolve) return
    item.resolveMidpoint = undefined
    resolve(played)
  }

  function pumpLlmAudio() {
    if (!soundOn.value || !effectsOn.value || activeLlmAudio) return
    let item: LlmAudioItem | undefined
    while (llmAudioQueue.length) {
      const candidate = llmAudioQueue.shift()!
      const ttl = candidate.priority === 'important' ? IMPORTANT_LLM_AUDIO_TTL_MS : NORMAL_LLM_AUDIO_TTL_MS
      // 单机等待中的动作不会过期：动作尚未执行，台词仍属于当前决策。
      if (candidate.waitForMidpoint || Date.now() - candidate.enqueuedAt <= ttl) {
        item = candidate
        break
      }
      settleLlmMidpoint(candidate, false)
    }
    if (!item) {
      setBgmDucked(false)
      return
    }
    const audio = new Audio(item.url)
    activeLlmAudio = audio
    activeLlmItem = item
    audio.preload = 'auto'
    audio.volume = 1
    setBgmDucked(true)
    let finished = false
    let started = false
    let fallbackTimer = 0
    const playbackTimer = window.setTimeout(() => {
      audio.pause()
      finish(false)
    }, LLM_AUDIO_PLAYBACK_TIMEOUT_MS)
    const clearPlaybackTimers = () => {
      window.clearTimeout(playbackTimer)
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
    }
    const finish = (played: boolean) => {
      if (finished) return
      finished = true
      clearPlaybackTimers()
      settleLlmMidpoint(item, played)
      if (activeLlmAudio !== audio) return
      activeLlmAudio = null
      activeLlmItem = null
      pumpLlmAudio()
      if (!activeLlmAudio) setBgmDucked(false)
    }
    const maybeResolveMidpoint = () => {
      if (!started || !item.resolveMidpoint) return
      const duration = audio.duration
      if (Number.isFinite(duration) && duration > 0 && audio.currentTime >= duration / 2) {
        settleLlmMidpoint(item, true)
      }
    }
    const refreshMidpointFallback = () => {
      if (!started || !item.resolveMidpoint) return
      const duration = audio.duration
      if (Number.isFinite(duration) && duration > 0) {
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer)
          fallbackTimer = 0
        }
        maybeResolveMidpoint()
        return
      }
      if (!fallbackTimer) {
        fallbackTimer = window.setTimeout(
          () => settleLlmMidpoint(item, true),
          item.fallbackMidpointMs ?? 1_500,
        )
      }
    }
    const handleStarted = () => {
      if (started) return
      started = true
      try { item.onStarted?.() } catch { /* 展示失败不能阻塞语音和动作 */ }
      refreshMidpointFallback()
    }
    item.cancel = () => {
      audio.pause()
      audio.currentTime = 0
      finish(false)
    }
    audio.addEventListener('playing', handleStarted, { once: true })
    audio.addEventListener('timeupdate', maybeResolveMidpoint)
    audio.addEventListener('durationchange', refreshMidpointFallback)
    audio.addEventListener('ended', () => finish(started), { once: true })
    audio.addEventListener('error', () => finish(false), { once: true })
    audio.play().catch(() => finish(false))
  }

  /** 普通吐槽忙时直接丢弃；关键/胜利台词可打断普通语音，且只保留最新一条待播。 */
  function playLlmAudio(
    url: string,
    seat: number,
    messageId: number,
    priority: LlmSpeechPriority = 'normal',
  ) {
    if (!soundOn.value || !effectsOn.value || !url) return
    if (priority === 'normal' && (activeLlmAudio || llmAudioQueue.length)) return
    if (priority === 'important') {
      llmAudioQueue.splice(0, llmAudioQueue.length).forEach((item) => settleLlmMidpoint(item, false))
    }
    if (activeLlmAudio && priority === 'important' && activeLlmItem?.priority === 'normal') {
      activeLlmItem.cancel?.()
    }
    llmAudioQueue.push({ url, seat, messageId, priority, enqueuedAt: Date.now() })
    while (llmAudioQueue.length > 1) llmAudioQueue.shift()
    pumpLlmAudio()
  }

  /** 单机 LLM：不丢弃台词；实际播放开始时显示气泡，播放到中点时放行动作。 */
  function playLocalLlmAudioUntilMidpoint(
    url: string,
    seat: number,
    messageId: number,
    priority: LlmSpeechPriority = 'normal',
    hooks: LlmAudioPlaybackHooks = {},
  ): Promise<boolean> {
    if (!soundOn.value || !effectsOn.value || !url) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      llmAudioQueue.push({
        url, seat, messageId, priority, enqueuedAt: Date.now(),
        waitForMidpoint: true,
        onStarted: hooks.onStarted,
        fallbackMidpointMs: hooks.fallbackMidpointMs,
        resolveMidpoint: resolve,
      })
      pumpLlmAudio()
    })
  }

  function stopLlmAudio() {
    llmAudioQueue.splice(0, llmAudioQueue.length).forEach((item) => settleLlmMidpoint(item, false))
    activeLlmItem?.cancel?.()
    if (activeLlmAudio) activeLlmAudio.pause()
    activeLlmAudio = null
    activeLlmItem = null
    setBgmDucked(false)
  }

  // 单机 TTS 通过共享总线接入；两分支的 App.vue 均无需感知该实现。
  const unregisterLlmAudioPlayer = registerLlmAudioPlayer(
    playLocalLlmAudioUntilMidpoint,
    () => soundOn.value && effectsOn.value,
    stopLlmAudio,
  )
  const unsubscribeLocalLlmAudio = subscribeLocalLlmAudio(playLlmAudio)

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

  function removeBgmPrimeListeners() {
    window.removeEventListener('pointerdown', primeBgm)
    window.removeEventListener('keydown', primeBgm)
    window.removeEventListener('touchstart', primeBgm)
  }

  function primeBgm() {
    removeBgmPrimeListeners()
    void preloadBgm()
  }

  onMounted(() => {
    window.addEventListener('pointerdown', primeBgm, { once: true, passive: true })
    window.addEventListener('keydown', primeBgm, { once: true })
    window.addEventListener('touchstart', primeBgm, { once: true, passive: true })
  })

  // Web Audio 无缝循环：BufferSource.loop 在缓冲区边界样本级拼接，无 HTMLAudio 的卡顿。
  function playBgmWebAudio() {
    const ctx = ensureAudioContext()
    if (!ctx || !bgmBuffer || bgmSource) return
    if (ctx.state === 'suspended') void ctx.resume()
    if (!bgmGain) {
      bgmGain = ctx.createGain()
      bgmGain.gain.value = activeLlmAudio ? BGM_DUCKED_VOLUME : BGM_VOLUME
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
    if (!soundOn.value || !bgmOn.value) return
    await preloadBgm()   // 确保 buffer 就绪，避免开局静音
    if (!bgmStarted.value || !soundOn.value || !bgmOn.value) return
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

  watch([soundOn, bgmOn, effectsOn], ([globalEnabled, bgmEnabled, effectsEnabled]) => {
    persistAudioPreferences({
      soundOn: globalEnabled,
      bgmOn: bgmEnabled,
      effectsOn: effectsEnabled,
    })

    if (!globalEnabled || !bgmEnabled) {
      // Web Audio：suspend 保留播放位置，再次开启时 resume 无缝续播
      if (bgmWebAudio) void audioContext?.suspend()
      else bgm.pause()
    } else if (bgmStarted.value) {
      if (bgmWebAudio && audioContext) {
        if (audioContext.state === 'suspended') void audioContext.resume()
        if (!bgmSource && bgmBuffer) playBgmWebAudio()
      } else {
        bgm.play().catch(() => {})
      }
    }

    if (!globalEnabled || !effectsEnabled) {
      stopEffects()
      stopLlmAudio()
    }
  })

  onBeforeUnmount(() => {
    unregisterLlmAudioPlayer()
    unsubscribeLocalLlmAudio()
    removeBgmPrimeListeners()
    if (bgmWebAudio) {
      bgmSource?.stop()
      bgmSource = null
      void audioContext?.close()
      audioContext = null
    } else {
      bgm.pause()
    }
    stopEffects()
    stopLlmAudio()
    effectObjectUrls.forEach((url) => URL.revokeObjectURL(url))
    effectObjectUrls.clear()
    effectTemplates.clear()
  })

  return {
    soundOn,
    bgmOn,
    effectsOn,
    playEffect,
    playEffectAndWait,
    playLlmAudio,
    playLocalLlmAudioUntilMidpoint,
    startBgm,
    preloadBgm,
  }
}
