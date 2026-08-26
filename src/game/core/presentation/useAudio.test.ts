import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_PREFERENCES_STORAGE_KEY, useAudio } from './useAudio'
import { dispatchLocalLlmAudio, resetLlmAudioBusForTests } from './llmAudioBus'

class MockAudio {
  static instances: MockAudio[] = []

  src: string
  preload = ''
  loop = false
  volume = 1
  currentTime = 0
  duration = 4
  readonly pause = vi.fn()
  readonly play = vi.fn(async () => {})
  private listeners = new Map<string, Array<() => void>>()

  constructor(src = '') {
    this.src = src
    MockAudio.instances.push(this)
  }

  load() {}

  cloneNode() {
    return new MockAudio(this.src)
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

beforeEach(() => {
  MockAudio.instances = []
  vi.stubGlobal('Audio', MockAudio)
  const testWindow = Object.assign(new EventTarget(), {
    location: { href: 'http://localhost:5173/' },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
  vi.stubGlobal('window', testWindow)
  // 音效预加载与本测试无关；保持请求 pending，避免创建数十个模板 Audio。
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  resetLlmAudioBusForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useAudio LLM voice ducking', () => {
  it('单机语音在 playing 时显示气泡，并到实际播放中点才放行动作', async () => {
    const audio = useAudio()
    const started = vi.fn()
    const url = `/api/local-tts/audio/${'b'.repeat(64)}.mp3`
    let settled = false
    const midpoint = audio.playLocalLlmAudioUntilMidpoint(url, 2, 1, 'normal', { onStarted: started })
      .then((value) => { settled = true; return value })
    const voice = MockAudio.instances.find((item) => item.src === url)!

    expect(started).not.toHaveBeenCalled()
    voice.emit('playing')
    expect(started).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    voice.currentTime = 1.9
    voice.emit('timeupdate')
    expect(settled).toBe(false)
    voice.currentTime = 2
    voice.emit('timeupdate')
    await expect(midpoint).resolves.toBe(true)
    voice.emit('ended')
  })

  it('单机语音串行播放但不丢弃，后一动作等待自己的新台词中点', async () => {
    const audio = useAudio()
    const firstUrl = `/api/local-tts/audio/${'c'.repeat(64)}.mp3`
    const secondUrl = `/api/local-tts/audio/${'d'.repeat(64)}.mp3`
    const firstMidpoint = audio.playLocalLlmAudioUntilMidpoint(firstUrl, 1, 1)
    const secondMidpoint = audio.playLocalLlmAudioUntilMidpoint(secondUrl, 2, 2)
    const first = MockAudio.instances.find((item) => item.src === firstUrl)!

    expect(MockAudio.instances.some((item) => item.src === secondUrl)).toBe(false)
    first.emit('playing')
    first.currentTime = 2
    first.emit('timeupdate')
    await expect(firstMidpoint).resolves.toBe(true)
    first.emit('ended')

    const second = MockAudio.instances.find((item) => item.src === secondUrl)!
    expect(second).toBeDefined()
    second.emit('playing')
    second.currentTime = 2
    second.emit('timeupdate')
    await expect(secondMidpoint).resolves.toBe(true)
    second.emit('ended')
  })

  it('普通吐槽播放期间丢弃后来普通语音，不再积压到下一圈', () => {
    const audio = useAudio()
    const bgm = MockAudio.instances[0]
    expect(bgm.volume).toBe(0.32)

    const firstUrl = `/api/local-tts/audio/${'a'.repeat(64)}.mp3`
    expect(dispatchLocalLlmAudio(firstUrl, 1, 1)).toBe(true)
    const first = MockAudio.instances.find((item) => item.src === firstUrl)!
    expect(first.volume).toBe(1)
    expect(bgm.volume).toBe(0.08)

    audio.playLlmAudio('/api/tts/audio/second.mp3', 2, 2)
    expect(MockAudio.instances.some((item) => item.src.endsWith('/second.mp3'))).toBe(false)
    first.emit('ended')
    expect(bgm.volume).toBe(0.32)
  })

  it('关键胜利语音打断普通吐槽并在结束后恢复 BGM', () => {
    const audio = useAudio()
    const bgm = MockAudio.instances[0]
    const firstUrl = `/api/local-tts/audio/${'a'.repeat(64)}.mp3`
    dispatchLocalLlmAudio(firstUrl, 1, 1)
    const first = MockAudio.instances.find((item) => item.src === firstUrl)!

    audio.playLlmAudio('/api/tts/audio/win.mp3', 2, 2, 'important')

    expect(first.pause).toHaveBeenCalledOnce()
    const win = MockAudio.instances.find((item) => item.src.endsWith('/win.mp3'))!
    expect(win.play).toHaveBeenCalledOnce()
    expect(bgm.volume).toBe(0.08)
    win.emit('ended')
    expect(bgm.volume).toBe(0.32)
  })
})

describe('useAudio preferences', () => {
  it('restores and persists the global, BGM, and effects switches independently', async () => {
    localStorage.setItem(AUDIO_PREFERENCES_STORAGE_KEY, JSON.stringify({
      soundOn: false,
      bgmOn: true,
      effectsOn: false,
    }))
    const audio = useAudio()

    expect(audio.soundOn.value).toBe(false)
    expect(audio.bgmOn.value).toBe(true)
    expect(audio.effectsOn.value).toBe(false)

    audio.soundOn.value = true
    audio.bgmOn.value = false
    audio.effectsOn.value = true
    await nextTick()

    expect(JSON.parse(localStorage.getItem(AUDIO_PREFERENCES_STORAGE_KEY)!)).toEqual({
      soundOn: true,
      bgmOn: false,
      effectsOn: true,
    })
  })

  it('keeps effects playable while BGM is disabled', async () => {
    const audio = useAudio()
    const bgm = MockAudio.instances[0]

    audio.bgmOn.value = false
    await nextTick()
    expect(bgm.pause).toHaveBeenCalled()

    const effect = audio.playEffect('click.mp3') as unknown as MockAudio
    expect(effect).not.toBeNull()
    expect(effect.play).toHaveBeenCalledOnce()
  })

  it('blocks effects and voices without muting BGM when only effects are disabled', async () => {
    const audio = useAudio()
    const bgm = MockAudio.instances[0]

    audio.effectsOn.value = false
    await nextTick()

    expect(audio.playEffect('click.mp3')).toBeNull()
    audio.playLlmAudio('/api/tts/audio/blocked.mp3', 1, 1)
    expect(MockAudio.instances.some((item) => item.src.endsWith('/blocked.mp3'))).toBe(false)
    expect(bgm.pause).not.toHaveBeenCalled()
  })

  it('uses the global switch as a master gate without changing child preferences', async () => {
    const audio = useAudio()
    audio.soundOn.value = false
    await nextTick()

    expect(audio.bgmOn.value).toBe(true)
    expect(audio.effectsOn.value).toBe(true)
    expect(audio.playEffect('click.mp3')).toBeNull()
    await audio.startBgm()
    expect(MockAudio.instances[0].play).not.toHaveBeenCalled()
  })
})
