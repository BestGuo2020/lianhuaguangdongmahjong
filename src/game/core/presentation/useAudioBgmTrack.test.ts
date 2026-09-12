import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BGM_FILE, useAudio } from './useAudio'

/**
 * BGM 轨叠放的回归测试（2026-09-12 线上反馈：「回大厅 → 切主题 → 重新开局」出现多重 BGM）。
 *
 * 场景前提：BGM 跨局常驻（回大厅不中断），因此第二局开局时 `startBgm()` 会在「已经有一条
 * 在播 BGM」的情况下再被调用。Web Audio 路径此前只覆盖 `webBgmTrack` 引用、不 stop 旧源，
 * 旧轨继续以满音量循环且再也停不掉——每开一局多一层。
 */

class FakeAudioParam {
  value = 1
  setValueAtTime = vi.fn()
  linearRampToValueAtTime = vi.fn()
  cancelScheduledValues = vi.fn()
  setTargetAtTime = vi.fn()
}

class FakeGainNode {
  gain = new FakeAudioParam()
  connect = vi.fn()
  disconnect = vi.fn()
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null
  loop = false
  started = false
  stopped = false
  connect = vi.fn()
  disconnect = vi.fn()

  start() { this.started = true }
  stop() { this.stopped = true }
}

class FakeAudioContext {
  state: AudioContextState = 'running'
  currentTime = 0
  destination = {}
  sources: FakeBufferSource[] = []

  createGain() { return new FakeGainNode() }
  createBufferSource() {
    const source = new FakeBufferSource()
    this.sources.push(source)
    return source
  }
  async decodeAudioData() { return {} as AudioBuffer }
  resume() { this.state = 'running'; return Promise.resolve() }
  suspend() { this.state = 'suspended'; return Promise.resolve() }
  close() { return Promise.resolve() }
}

class MockAudio {
  static instances: MockAudio[] = []
  src: string
  preload = ''
  loop = false
  volume = 1
  currentTime = 0
  readonly pause = vi.fn()
  readonly play = vi.fn(async () => {})

  constructor(src = '') {
    this.src = src
    MockAudio.instances.push(this)
  }

  load() {}
  cloneNode() { return new MockAudio(this.src) }
  addEventListener() {}
}

let context: FakeAudioContext

const livePlaying = () => context.sources.filter((source) => source.started && !source.stopped && source.loop)

beforeEach(() => {
  MockAudio.instances = []
  context = new FakeAudioContext()
  vi.stubGlobal('Audio', MockAudio)
  vi.stubGlobal('AudioContext', class {
    constructor() { return context as unknown as AudioContext }
  })
  const testWindow = Object.assign(new EventTarget(), {
    location: { href: 'http://localhost:5173/' },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    AudioContext: globalThis.AudioContext,
  })
  vi.stubGlobal('window', testWindow)
  // BGM 解码走 fetch + decodeAudioData；音效预加载与本测试无关，同样返回可解析响应。
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })))
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('BGM 单轨不变量', () => {
  it('开局后再次开局（回大厅后重开一局）不叠加：目标曲目已在播就复用同一条轨', async () => {
    const audio = useAudio()

    await audio.startBgm()
    expect(livePlaying()).toHaveLength(1)

    // 第二局开局：BGM 一直在播，不应再起一条。
    await audio.startBgm()
    expect(livePlaying()).toHaveLength(1)
    expect(context.sources).toHaveLength(1)
  })

  it('换曲后再开局：旧轨被停掉，只剩一条在播', async () => {
    const audio = useAudio()
    await audio.startBgm()

    audio.fadeToBgm('HuMusic.ogg')
    await vi.waitFor(() => expect(context.sources.length).toBeGreaterThan(1))
    await audio.startBgm()

    expect(livePlaying()).toHaveLength(1)
    expect(livePlaying()[0].buffer).toBeTruthy()
  })

  it('在播 BGM 未停时反复开局三次仍只有一条轨在播', async () => {
    const audio = useAudio()

    await audio.startBgm()
    await audio.startBgm()
    await audio.startBgm()

    expect(livePlaying()).toHaveLength(1)
  })

  it('默认循环曲目仍按 bg.ogg 起轨', async () => {
    const audio = useAudio()
    await audio.startBgm()

    expect(DEFAULT_BGM_FILE).toBe('bg.ogg')
    expect(livePlaying()).toHaveLength(1)
  })
})
