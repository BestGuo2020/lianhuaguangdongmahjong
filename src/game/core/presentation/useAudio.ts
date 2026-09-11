import { getCurrentInstance, inject, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import type { InjectionKey, Ref } from 'vue'
import {
  registerLlmAudioPlayer,
  registerLlmAudioGroupPlayer,
  subscribeLocalLlmAudio,
  type LlmAudioGroupItem,
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
/** 默认循环 BGM；`audio/` 下的文件名。 */
export const DEFAULT_BGM_FILE = 'bg.ogg'
/** 换 BGM 的交叉淡入淡出时长：够长到听不出切换、又不拖到盖住下一拍动作。 */
export const BGM_CROSSFADE_SECONDS = 1.6
const BGM_FADE_STEP_MS = 40
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
type EffectPlayer=(name:string,volume?:number)=>HTMLAudioElement|null
const EFFECT_PLAYER_KEY:InjectionKey<EffectPlayer>=Symbol('effect-player')
/** Shared UI effects use the existing player and its sound/effects mute controls. */
export function useEffectPlayer(){return getCurrentInstance()?inject(EFFECT_PLAYER_KEY,null):null}

/**
 * BGM 曲目端口：玩法层（如血流「全场多胡」）用它换循环 BGM，不直接碰音频实现。
 * 与 `llmAudioBus`/`useEffectPlayer` 同款做法：`useAudio()` 注册到模块级单例，
 * 玩法层随时取用——联机两条分支（WS / P2P）都不必各自改 App.vue 接线。
 */
export interface BgmTrackPort {
  /** 交叉淡入淡出切换循环 BGM；file 为 `audio/` 下的文件名，秒数省略时用默认时长。 */
  fadeTo(file: string, fadeSeconds?: number): void
  /** 预热目标曲目，避免第一次换曲时才下载（可选）。 */
  preload?(file: string): void
}

let bgmTrackPort: BgmTrackPort | null = null

/** 当前页面注册的 BGM 曲目端口；未挂载音频层时为 null。 */
export function activeBgmTrackPort(): BgmTrackPort | null {
  return bgmTrackPort
}

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
  removeAbortListener?: () => void
  url: string
  seat: number
  messageId: number
  priority: LlmSpeechPriority
  enqueuedAt: number
  waitForMidpoint?: boolean
  waitForCompletion?: boolean
  onStarted?: () => void
  fallbackMidpointMs?: number
  isCurrent?: () => boolean
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
  if (getCurrentInstance()) provide(EFFECT_PLAYER_KEY, playEffect)
  const bgmStarted = ref(false)
  const activeEffects = new Set<EffectAudio>()
  const effectTemplates = new Map<string, HTMLAudioElement>()
  const effectObjectUrls = new Set<string>()
  const llmAudioQueue: LlmAudioItem[] = []
  let activeLlmAudio: HTMLAudioElement | null = null
  let activeLlmItem: LlmAudioItem | null = null
  /** 一炮多响并发组：独立于单条串行总线的多个同时播放元素。 */
  const groupAudios = new Set<HTMLAudioElement>()
  // BGM：优先走 Web Audio 的 BufferSource.loop —— 循环边界样本级无缝，避免
  // HTMLAudio loop 每次到头 seek/缓冲的卡顿。Web Audio 不可用时回退 HTMLAudio。
  // 两条路径都支持交叉淡入淡出：换曲时新旧各持一个增益/音量，斜坡互换后再停旧轨。
  // 注意（2026-09-11 用户决定）：LLM 语音播放期间**不压低 BGM**——忽高忽低比语音盖住音乐
  // 更影响对局节奏。BGM 恒定 BGM_VOLUME，不要再加 ducking。
  let audioContext: AudioContext | null = null
  const bgmBuffers = new Map<string, AudioBuffer>()
  let webBgmTrack: { file: string; source: AudioBufferSourceNode; gain: GainNode } | null = null
  let bgmGain: GainNode | null = null
  let bgmWebAudio = false
  let bgmPreloadPromise: Promise<void> | null = null
  let bgmTrackFile = DEFAULT_BGM_FILE
  // HTMLAudio 兜底（无 Web Audio / 解码失败时使用）
  const bgm = new Audio(`${AUDIO_BASE}${DEFAULT_BGM_FILE}`)
  bgm.preload = 'auto'
  bgm.loop = true
  bgm.volume = BGM_VOLUME
  let bgmFallbackSrc: string | null = null
  interface FallbackTrack { file: string; element: HTMLAudioElement; fade: number }
  const fallbackTracks: FallbackTrack[] = [{ file: DEFAULT_BGM_FILE, element: bgm, fade: 1 }]
  /** 回退路径的换曲斜坡：同一时刻只有一条，暂停/卸载时立刻结算到目标状态。 */
  let fallbackFadeTimer = 0

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
    if(audio.dataset)audio.dataset.effectName=name
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

  function applyFallbackVolumes() {
    for (const track of fallbackTracks) track.element.volume = BGM_VOLUME * track.fade
  }

  function settleLlmMidpoint(item: LlmAudioItem, played: boolean) {
    const resolve = item.resolveMidpoint
    if (!resolve) return
    item.resolveMidpoint = undefined
    if (!played) item.removeAbortListener?.()
    resolve(played)
  }

  function pumpLlmAudio() {
    if (!soundOn.value || !effectsOn.value || activeLlmAudio) return
    let item: LlmAudioItem | undefined
    while (llmAudioQueue.length) {
      const candidate = llmAudioQueue.shift()!
      if (candidate.isCurrent?.() === false) {
        settleLlmMidpoint(candidate, false)
        continue
      }
      const ttl = candidate.priority === 'important' ? IMPORTANT_LLM_AUDIO_TTL_MS : NORMAL_LLM_AUDIO_TTL_MS
      // 单机等待中的动作不会过期：动作尚未执行，台词仍属于当前决策。
      if (candidate.waitForMidpoint || candidate.waitForCompletion || Date.now() - candidate.enqueuedAt <= ttl) {
        item = candidate
        break
      }
      settleLlmMidpoint(candidate, false)
    }
    if (!item) return
    const audio = new Audio(item.url)
    activeLlmAudio = audio
    activeLlmItem = item
    audio.preload = 'auto'
    audio.volume = 1
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
      item.removeAbortListener?.()
      settleLlmMidpoint(item, played)
      if (activeLlmAudio !== audio) return
      activeLlmAudio = null
      activeLlmItem = null
      pumpLlmAudio()
    }
    const maybeResolveMidpoint = () => {
      if (item.waitForCompletion) return
      if (!started || !item.resolveMidpoint) return
      const duration = audio.duration
      if (Number.isFinite(duration) && duration > 0 && audio.currentTime >= duration / 2) {
        settleLlmMidpoint(item, true)
      }
    }
    const refreshMidpointFallback = () => {
      if (item.waitForCompletion) return
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
      if (item.isCurrent?.() === false) {
        item.cancel?.()
        return
      }
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
    audio.addEventListener('timeupdate', () => {
      if (item.isCurrent?.() === false) item.cancel?.()
      else maybeResolveMidpoint()
    })
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

  /** 单机 LLM：不丢弃台词；普通动作在中点放行，赛后感言可等待整句播放结束。 */
  function playLocalLlmAudioUntilMidpoint(
    url: string,
    seat: number,
    messageId: number,
    priority: LlmSpeechPriority = 'normal',
    hooks: LlmAudioPlaybackHooks = {},
  ): Promise<boolean> {
    if (!soundOn.value || !effectsOn.value || !url) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      if (priority === 'important') {
        for (let index = llmAudioQueue.length - 1; index >= 0; index -= 1) {
          if (llmAudioQueue[index].priority !== 'normal') continue
          const [removed] = llmAudioQueue.splice(index, 1)
          settleLlmMidpoint(removed, false)
        }
        if (activeLlmAudio && activeLlmItem?.priority === 'normal') activeLlmItem.cancel?.()
      }
      const item: LlmAudioItem = {
        url, seat, messageId, priority, enqueuedAt: Date.now(),
        waitForMidpoint: true,
        waitForCompletion: hooks.waitForCompletion,
        onStarted: hooks.onStarted,
        fallbackMidpointMs: hooks.fallbackMidpointMs,
        isCurrent: hooks.isCurrent,
        resolveMidpoint: resolve,
      }
      const abort = () => {
        const index = llmAudioQueue.indexOf(item)
        if (index >= 0) llmAudioQueue.splice(index, 1)
        item.cancel?.()
        settleLlmMidpoint(item, false)
      }
      hooks.signal?.addEventListener('abort', abort, { once: true })
      item.removeAbortListener = () => hooks.signal?.removeEventListener('abort', abort)
      if (hooks.signal?.aborted) { abort(); return }
      llmAudioQueue.push(item)
      pumpLlmAudio()
    })
  }

  /** 一炮多响：多位赢家的语音在同一拍开始，彼此不打断、不进串行队列。全部结束后 resolve。 */
  async function playConcurrentLlmAudio(items: LlmAudioGroupItem[]): Promise<void> {
    if (!soundOn.value || !effectsOn.value || !items.length) return
    const endings: Promise<void>[] = []
    for (const { url } of items) {
      if (!url) continue
      const audio = new Audio(url)
      groupAudios.add(audio)
      audio.volume = 1
      const release = () => { groupAudios.delete(audio) }
      endings.push(new Promise<void>((resolve) => {
        const settle = () => { release(); resolve() }
        audio.addEventListener('ended', settle, { once: true })
        audio.addEventListener('error', settle, { once: true })
      }))
      audio.play().catch(() => release())
    }
    await Promise.all(endings)
  }

  function stopLlmAudio() {
    llmAudioQueue.splice(0, llmAudioQueue.length).forEach((item) => settleLlmMidpoint(item, false))
    activeLlmItem?.cancel?.()
    if (activeLlmAudio) activeLlmAudio.pause()
    activeLlmAudio = null
    activeLlmItem = null
    groupAudios.forEach((audio) => { audio.pause(); audio.currentTime = 0 })
    groupAudios.clear()
  }

  // 单机 TTS 通过共享总线接入；两分支的 App.vue 均无需感知该实现。
  const unregisterLlmAudioPlayer = registerLlmAudioPlayer(
    playLocalLlmAudioUntilMidpoint,
    () => soundOn.value && effectsOn.value,
    stopLlmAudio,
  )
  const unregisterLlmAudioGroupPlayer = registerLlmAudioGroupPlayer(
    playConcurrentLlmAudio,
    () => soundOn.value && effectsOn.value,
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

  /** BGM 主动下载并解码（移动端 preload='auto' 可能被忽略）。首次用户交互时触发：
   *  同步创建/恢复 AudioContext（手势内解锁自动播放策略），fetch+decode 在后台完成。 */
  async function loadBgmBuffer(file: string): Promise<AudioBuffer | null> {
    const cached = bgmBuffers.get(file)
    if (cached) return cached
    const ctx = ensureAudioContext()
    if (!ctx) return null
    try {
      const response = await fetch(`${AUDIO_BASE}${file}`, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`Failed to preload bgm: ${response.status}`)
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer())
      bgmBuffers.set(file, buffer)
      return buffer
    } catch {
      return null
    }
  }

  function preloadBgm(): Promise<void> {
    if (bgmPreloadPromise) return bgmPreloadPromise
    const ctx = ensureAudioContext()
    if (ctx && ctx.state === 'suspended') void ctx.resume()
    bgmPreloadPromise = (async () => {
      if (await loadBgmBuffer(DEFAULT_BGM_FILE)) {
        bgmWebAudio = true
        return
      }
      // 无 Web Audio 或解码失败：改用 object URL 喂给 HTMLAudio，避免只靠网络地址。
      try {
        const response = await fetch(`${AUDIO_BASE}${DEFAULT_BGM_FILE}`, { cache: 'force-cache' })
        if (!response.ok) throw new Error(`Failed to preload bgm: ${response.status}`)
        const blob = new Blob([await response.arrayBuffer()], { type: 'audio/ogg' })
        const objectUrl = URL.createObjectURL(blob)
        effectObjectUrls.add(objectUrl)
        bgmFallbackSrc = objectUrl
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
  // 换曲用**等功率（equal-power）交叉**：新轨按 sin、旧轨按 cos 走同一条 π/2 曲线。
  // 两条线性斜坡会让中点只剩 √(0.5²+0.5²)≈0.71 的功率（听感掉 ~3dB 再回来），
  // sin/cos 组合在整段交叉里保持 a²+b²=1，响度听不出起伏。
  const CROSSFADE_CURVE_STEPS = 64
  function crossfadeCurve(current: number, direction: 'in' | 'out', steps = CROSSFADE_CURVE_STEPS) {
    const curve = new Float32Array(steps + 1)
    for (let index = 0; index <= steps; index += 1) {
      const angle = (Math.PI / 2) * (index / steps)
      // 起点必须等于当前增益：换曲被再次打断时不会跳变。
      curve[index] = direction === 'in'
        ? current + (1 - current) * Math.sin(angle)
        : current * Math.cos(angle)
    }
    // 端点取精确值，避免 cos(π/2) 的 6e-17 残量留在增益上。
    curve[0] = current
    curve[steps] = direction === 'in' ? 1 : 0
    return curve
  }

  /** 等功率曲线优先；个别浏览器拒绝曲线调度时退回斜坡，绝不把新轨留在 0 增益。 */
  function scheduleCrossfade(param: AudioParam, current: number, direction: 'in' | 'out', startTime: number, duration: number) {
    try {
      param.setValueCurveAtTime(crossfadeCurve(current, direction), startTime, duration)
    } catch {
      param.cancelScheduledValues(startTime)
      param.setValueAtTime(current, startTime)
      param.linearRampToValueAtTime(direction === 'in' ? 1 : 0, startTime + duration)
    }
  }

  function playWebBgmTrack(file: string, buffer: AudioBuffer, fadeSeconds: number) {
    const ctx = ensureAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') void ctx.resume()
    if (!bgmGain) {
      bgmGain = ctx.createGain()
      bgmGain.gain.value = BGM_VOLUME
      bgmGain.connect(ctx.destination)
    }
    const now = ctx.currentTime
    const previous = webBgmTrack
    const gain = ctx.createGain()
    if (fadeSeconds > 0) scheduleCrossfade(gain.gain, 0, 'in', now, fadeSeconds)
    else gain.gain.setValueAtTime(1, now)
    gain.connect(bgmGain)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.connect(gain)
    source.start(0)
    webBgmTrack = { file, source, gain }
    if (!previous) return
    const outgoing = Math.max(fadeSeconds, 0.05)
    previous.gain.gain.cancelScheduledValues(now)
    scheduleCrossfade(previous.gain.gain, previous.gain.gain.value, 'out', now, outgoing)
    const retire = () => {
      try { previous.source.stop() } catch { /* 已停止 */ }
      previous.source.disconnect()
      previous.gain.disconnect()
    }
    if (fadeSeconds > 0) window.setTimeout(retire, Math.ceil(fadeSeconds * 1_000) + 80)
    else retire()
  }

  function fallbackTrackFor(file: string) {
    const existing = fallbackTracks.find(track => track.file === file)
    if (existing) return existing
    const element = new Audio(`${AUDIO_BASE}${file}`)
    element.preload = 'auto'
    element.loop = true
    element.volume = 0
    const track: FallbackTrack = { file, element, fade: 0 }
    fallbackTracks.push(track)
    return track
  }

  /** 默认 BGM 若已预下载成 object URL，优先用它（离线/隐私模式下的解码回退）。 */
  function usePreloadedFallbackSrc(track: FallbackTrack) {
    if (track.file !== DEFAULT_BGM_FILE || !bgmFallbackSrc) return
    if (track.element.src === bgmFallbackSrc) return
    track.element.src = bgmFallbackSrc
  }

  function stopFallbackTrack(track: FallbackTrack) {
    track.fade = 0
    track.element.pause()
    // 默认 BGM 元素常驻（恢复播放与静音开关都复用它），换曲产生的元素用完即弃。
    if (track.element === bgm) { track.element.volume = BGM_VOLUME; return }
    const index = fallbackTracks.indexOf(track)
    if (index >= 0) fallbackTracks.splice(index, 1)
  }

  /** 立刻结束换曲斜坡：目标曲目满音量，其余停掉（暂停 BGM、卸载时调用）。 */
  function settleFallbackBgm(file: string) {
    if (fallbackFadeTimer) { window.clearTimeout(fallbackFadeTimer); fallbackFadeTimer = 0 }
    for (const track of [...fallbackTracks]) {
      if (track.file === file) { usePreloadedFallbackSrc(track); track.fade = 1; continue }
      if (track.fade > 0 || track.element !== bgm) stopFallbackTrack(track)
    }
    applyFallbackVolumes()
  }

  function crossfadeFallbackBgm(file: string, fadeSeconds: number) {
    const incoming = fallbackTrackFor(file)
    usePreloadedFallbackSrc(incoming)
    if (fallbackFadeTimer) { window.clearTimeout(fallbackFadeTimer); fallbackFadeTimer = 0 }
    incoming.element.play().catch(() => {})
    if (fadeSeconds <= 0) { settleFallbackBgm(file); return }
    const outgoing = fallbackTracks.filter(track => track !== incoming && track.fade > 0)
    const incomingStart = incoming.fade
    const outgoingStarts = outgoing.map(track => track.fade)
    const startedAt = Date.now()
    const step = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / (fadeSeconds * 1_000))
      // 等功率交叉：新轨 sin 升起、旧轨 cos 落下，a²+b² 恒为 1，中间不会掉响度。
      const angle = (Math.PI / 2) * progress
      incoming.fade = incomingStart + (1 - incomingStart) * Math.sin(angle)
      outgoing.forEach((track, index) => { track.fade = outgoingStarts[index] * Math.cos(angle) })
      applyFallbackVolumes()
      if (progress < 1) { fallbackFadeTimer = window.setTimeout(step, BGM_FADE_STEP_MS); return }
      fallbackFadeTimer = 0
      outgoing.forEach(stopFallbackTrack)
    }
    step()
  }

  async function applyBgmTrack(file: string, fadeSeconds: number) {
    if (bgmWebAudio) {
      const buffer = await loadBgmBuffer(file)
      if (buffer) { playWebBgmTrack(file, buffer, fadeSeconds); return }
    }
    crossfadeFallbackBgm(file, fadeSeconds)
  }

  /** 预热一条 BGM：Web Audio 下解码进缓存，回退路径下预建元素让浏览器先下载。 */
  function preloadBgmTrack(file: string) {
    if (ensureAudioContext()) { void loadBgmBuffer(file); return }
    usePreloadedFallbackSrc(fallbackTrackFor(file))
  }

  /** 交叉淡入淡出切换循环 BGM（同一时刻只有一条在播）。file 为 `audio/` 下的文件名。 */
  function fadeToBgm(file: string, fadeSeconds = BGM_CROSSFADE_SECONDS) {
    if (file === bgmTrackFile) return
    bgmTrackFile = file
    if (!bgmStarted.value || !soundOn.value || !bgmOn.value) return
    void applyBgmTrack(file, fadeSeconds)
  }

  /** 回到默认 BGM（bg.ogg）。 */
  function fadeToDefaultBgm(fadeSeconds = BGM_CROSSFADE_SECONDS) {
    fadeToBgm(DEFAULT_BGM_FILE, fadeSeconds)
  }

  // 玩法层（血流多胡 BGM 等）通过注册表取端口，不必在 App.vue 里逐分支接线。
  const bgmPort: BgmTrackPort = { fadeTo: fadeToBgm, preload: preloadBgmTrack }
  bgmTrackPort = bgmPort

  async function startBgm() {
    bgmStarted.value = true
    if (!soundOn.value || !bgmOn.value) return
    await preloadBgm()   // 确保 buffer 就绪，避免开局静音
    if (!bgmStarted.value || !soundOn.value || !bgmOn.value) return
    // 首播不做交叉淡入淡出：此刻还没有在播的 BGM，直接进当前目标曲目。
    if (bgmWebAudio && bgmBuffers.has(bgmTrackFile)) playWebBgmTrack(bgmTrackFile, bgmBuffers.get(bgmTrackFile)!, 0)
    else await applyBgmTrack(bgmTrackFile, 0)
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
      else {
        // 回退路径：先把在飞的换曲斜坡结算到目标曲目，再整体静音，避免斜坡回调在后台继续跑。
        settleFallbackBgm(bgmTrackFile)
        fallbackTracks.filter(track => track.fade > 0 || track.element === bgm).forEach(track => track.element.pause())
      }
    } else if (bgmStarted.value) {
      if (bgmWebAudio && audioContext) {
        if (audioContext.state === 'suspended') void audioContext.resume()
        if (!webBgmTrack) void applyBgmTrack(bgmTrackFile, 0)
      } else {
        const current = fallbackTrackFor(bgmTrackFile)
        usePreloadedFallbackSrc(current)
        current.element.play().catch(() => {})
      }
    }

    if (!globalEnabled || !effectsEnabled) {
      stopEffects()
      stopLlmAudio()
    }
  })

  onBeforeUnmount(() => {
    unregisterLlmAudioPlayer()
    unregisterLlmAudioGroupPlayer()
    unsubscribeLocalLlmAudio()
    removeBgmPrimeListeners()
    if (bgmTrackPort === bgmPort) bgmTrackPort = null
    if (bgmWebAudio) {
      try { webBgmTrack?.source.stop() } catch { /* 已停止 */ }
      webBgmTrack?.source.disconnect()
      webBgmTrack?.gain.disconnect()
      webBgmTrack = null
      void audioContext?.close()
      audioContext = null
    } else {
      if (fallbackFadeTimer) { window.clearTimeout(fallbackFadeTimer); fallbackFadeTimer = 0 }
      fallbackTracks.forEach(track => track.element.pause())
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
    preloadBgmTrack,
    fadeToBgm,
    fadeToDefaultBgm,
  }
}
