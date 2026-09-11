import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BGM_FILE, activeBgmTrackPort, useAudio } from './useAudio'

/** 交叉淡入淡出只在 BGM 层，这里独立桩出可观测的音量斜坡。 */
class MockAudio {
  static instances: MockAudio[] = []
  src: string
  preload = ''
  loop = false
  volume = 1
  currentTime = 0
  duration = 4
  readonly play = vi.fn(async () => {})
  readonly pause = vi.fn()
  constructor(src = '') { this.src = src; MockAudio.instances.push(this) }
  load() {}
  cloneNode() { return new MockAudio(this.src) }
  addEventListener() {}
  removeEventListener() {}
}

interface GainSpy { value: number; ramps: Array<[number, number]>; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> }
class MockGainNode {
  readonly gain: GainSpy
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() {
    const gain: GainSpy = {
      value: 1, ramps: [],
      setValueAtTime: vi.fn((value: number) => { gain.value = value }),
      cancelScheduledValues: vi.fn(),
      linearRampToValueAtTime: vi.fn((value: number, time: number) => { gain.ramps.push([value, time]); gain.value = value }),
    }
    this.gain = gain
  }
}
class MockBufferSource {
  buffer: unknown = null
  loop = false
  readonly started = vi.fn()
  readonly stopped = vi.fn()
  connect = vi.fn()
  disconnect = vi.fn()
  start(...args: unknown[]) { this.started(...args) }
  stop(...args: unknown[]) { this.stopped(...args) }
}
class MockAudioContext {
  static created: MockAudioContext[] = []
  state: 'running' | 'suspended' = 'running'
  currentTime = 0
  readonly destination = { name: 'destination' }
  readonly gains: MockGainNode[] = []
  readonly sources: MockBufferSource[] = []
  readonly decodeAudioData = vi.fn(async () => ({ duration: 1 }) as unknown as AudioBuffer)
  constructor() { MockAudioContext.created.push(this) }
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createGain() { const node = new MockGainNode(); this.gains.push(node); return node }
  createBufferSource() { const node = new MockBufferSource(); this.sources.push(node); return node }
}

function stubGlobals(withWebAudio: boolean) {
  MockAudio.instances = []
  MockAudioContext.created = []
  vi.stubGlobal('Audio', MockAudio)
  const testWindow = Object.assign(new EventTarget(), {
    location: { href: 'http://localhost:5173/' },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    ...(withWebAudio ? { AudioContext: MockAudioContext } : {}),
  })
  vi.stubGlobal('window', testWindow)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })))
  vi.stubGlobal('Blob', class { constructor(public parts: unknown[], public options?: unknown) {} })
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:mock-bgm'),
    revokeObjectURL: vi.fn(),
  })
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('useAudio BGM 交叉淡入淡出（HTMLAudio 回退路径）', () => {
  beforeEach(() => stubGlobals(false))
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('换曲时新轨淡入、旧轨淡出，斜坡结束后旧轨停止；重复点同一曲目不重复切换', async () => {
    const audio = useAudio()
    const bg = MockAudio.instances[0]
    await audio.startBgm()
    expect(bg.play).toHaveBeenCalledOnce()

    audio.fadeToBgm('HuMusic.ogg', 0.2)
    const hu = MockAudio.instances.find(item => item.src.endsWith('/audio/HuMusic.ogg'))
    expect(hu).toBeDefined()
    expect(hu!.loop).toBe(true)
    expect(hu!.play).toHaveBeenCalledOnce()
    // 交叉区间：两条同时在播、音量都在中间值（不硬切、也不叠加满音量）
    await wait(110)
    expect(hu!.volume).toBeGreaterThan(0)
    expect(hu!.volume).toBeLessThan(0.32)
    expect(bg.volume).toBeLessThan(0.32)
    // 斜坡结束：新轨到满音量，旧轨停止
    await wait(180)
    expect(hu!.volume).toBeCloseTo(0.32, 5)
    expect(bg.pause).toHaveBeenCalled()
    expect(bg.volume).toBeCloseTo(0.32, 5)

    const plays = hu!.play.mock.calls.length
    audio.fadeToBgm('HuMusic.ogg', 0.2)
    await wait(30)
    expect(hu!.play.mock.calls.length).toBe(plays)
  })

  it('局末切回默认 BGM，默认轨重新淡入', async () => {
    const audio = useAudio()
    const bg = MockAudio.instances[0]
    await audio.startBgm()
    audio.fadeToBgm('HuMusic.ogg', 0.05)
    await wait(120)
    expect(bg.pause).toHaveBeenCalled()
    bg.pause.mockClear()

    audio.fadeToDefaultBgm(0.05)
    await wait(120)
    expect(bg.play).toHaveBeenCalled()
    expect(bg.volume).toBeCloseTo(0.32, 5)
  })

  it('切换过程中静音/关闭 BGM 不残留斜坡，且重新开启按当前曲目续播', async () => {
    const audio = useAudio()
    await audio.startBgm()
    audio.fadeToBgm('HuMusic.ogg', 0.3)
    const hu = MockAudio.instances.find(item => item.src.endsWith('/audio/HuMusic.ogg'))!
    audio.bgmOn.value = false
    await wait(20)
    expect(hu.pause).toHaveBeenCalled()
    audio.bgmOn.value = true
    await wait(400)
    expect(hu.play).toHaveBeenCalledTimes(2)
    expect(hu.volume).toBeCloseTo(0.32, 5)
  })

  it('注册表暴露 BGM 曲目端口：玩法层不接线也能换曲（两条联机分支共用）', async () => {
    const audio = useAudio()
    const port = activeBgmTrackPort()
    expect(port).not.toBeNull()
    const bg = MockAudio.instances[0]
    await audio.startBgm()
    port!.preload?.('HuMusic.ogg')
    port!.fadeTo('HuMusic.ogg', 0.05)
    await wait(120)
    expect(MockAudio.instances.filter(item => item.src.endsWith('/audio/HuMusic.ogg'))).toHaveLength(1)
    expect(bg.pause).toHaveBeenCalled()
  })
})

describe('useAudio BGM 交叉淡入淡出（Web Audio 路径）', () => {
  beforeEach(() => stubGlobals(true))
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('换曲生成第二条 BufferSource：新轨 0→1、旧轨 →0，斜坡结束后旧轨 stop', async () => {
    const audio = useAudio()
    await audio.startBgm()
    const ctx = MockAudioContext.created[0]
    expect(ctx.sources).toHaveLength(1)

    audio.fadeToBgm('HuMusic.ogg', 0.05)
    await wait(30)
    expect(ctx.sources).toHaveLength(2)
    // gains[0] 是主增益（ducking 用），换曲的是其后两条轨道增益。
    const [oldTrack, newTrack] = ctx.gains.slice(1, 3).map(node => node.gain)
    expect(newTrack.ramps.some(([value]) => value === 1)).toBe(true)
    expect(oldTrack.ramps.some(([value]) => value === 0)).toBe(true)
    expect(ctx.sources[0].loop).toBe(true)
    expect(ctx.sources[1].loop).toBe(true)

    audio.fadeToDefaultBgm(0.05)
    await wait(200)
    expect(ctx.sources[0].stopped).toHaveBeenCalled()
    expect(ctx.sources[1].stopped).toHaveBeenCalled()
    expect(ctx.sources).toHaveLength(3)
    expect(ctx.decodeAudioData).toHaveBeenCalledWith(expect.any(ArrayBuffer))
    expect(DEFAULT_BGM_FILE).toBe('bg.ogg')
  })
})
