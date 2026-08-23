import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudio } from './useAudio'
import { dispatchLocalLlmAudio, resetLlmAudioBusForTests } from './llmAudioBus'

class MockAudio {
  static instances: MockAudio[] = []

  src: string
  preload = ''
  loop = false
  volume = 1
  currentTime = 0
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
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  resetLlmAudioBusForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useAudio LLM voice ducking', () => {
  it('吐槽期间压低 BGM、语音满音量，队列播完后恢复 BGM', () => {
    const audio = useAudio()
    const bgm = MockAudio.instances[0]
    expect(bgm.volume).toBe(0.32)

    const firstUrl = `/api/local-tts/audio/${'a'.repeat(64)}.mp3`
    expect(dispatchLocalLlmAudio(firstUrl, 1, 1)).toBe(true)
    const first = MockAudio.instances.find((item) => item.src === firstUrl)!
    expect(first.volume).toBe(1)
    expect(bgm.volume).toBe(0.08)

    audio.playLlmAudio('/api/tts/audio/second.mp3', 2, 2)
    first.emit('ended')
    const second = MockAudio.instances.find((item) => item.src.endsWith('/second.mp3'))!
    expect(second.volume).toBe(1)
    expect(bgm.volume).toBe(0.08)

    second.emit('ended')
    expect(bgm.volume).toBe(0.32)
  })
})
