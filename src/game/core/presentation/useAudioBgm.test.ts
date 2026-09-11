import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BGM_FILE, activeBgmTrackPort, useAudio } from './useAudio'

/** 换曲过渡只在 BGM 层，这里独立桩出可观测的音量与增益曲线。 */
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

interface GainSpy {
  value: number
  ramps: Array<[number, number]>
  curves: Array<{ values: number[]; duration: number }>
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
  setValueCurveAtTime: ReturnType<typeof vi.fn>
  cancelScheduledValues: ReturnType<typeof vi.fn>
}
class MockGainNode {
  readonly gain: GainSpy
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() {
    const gain: GainSpy = {
      value: 1, ramps: [], curves: [],
      setValueAtTime: vi.fn((value: number) => { gain.value = value }),
      cancelScheduledValues: vi.fn(),
      linearRampToValueAtTime: vi.fn((value: number, time: number) => { gain.ramps.push([value, time]); gain.value = value }),
      setValueCurveAtTime: vi.fn((values: Float32Array, _start: number, duration: number) => {
        gain.curves.push({ values: [...values], duration })
        gain.value = values[values.length - 1]
      }),
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

describe('useAudio BGM 顺序切换（HTMLAudio 回退路径）', () => {
  beforeEach(() => stubGlobals(false))
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('顺序切换：旧曲先淡到 0 才停，新曲随后从 0 淡起；重复点同一曲目不重复切换', async () => {
    const audio = useAudio()
    const bg = MockAudio.instances[0]
    await audio.startBgm()
    expect(bg.play).toHaveBeenCalledOnce()

    // 总时长 0.5s → 淡出 0.18s + 淡入 0.32s
    audio.fadeToBgm('HuMusic.ogg', 0.5)
    // 淡出阶段：旧曲在降，且此刻新曲元素还没建（两曲不重叠）
    await vi.waitFor(() => expect(bg.volume).toBeLessThan(0.32))
    expect(bg.volume).toBeGreaterThan(0)
    expect(MockAudio.instances.some(item => item.src.endsWith('/audio/HuMusic.ogg'))).toBe(false)

    // 旧曲到 0 → 停旧曲 → 新曲才开始播、从 0 淡起
    await vi.waitFor(() => expect(bg.pause).toHaveBeenCalled(), { timeout: 2000 })
    await vi.waitFor(() => expect(MockAudio.instances.some(item => item.src.endsWith('/audio/HuMusic.ogg'))).toBe(true))
    const hu = MockAudio.instances.find(item => item.src.endsWith('/audio/HuMusic.ogg'))!
    expect(hu.loop).toBe(true)
    expect(hu.play).toHaveBeenCalledOnce()
    expect(hu.volume).toBeLessThan(0.32)

    // 淡入结束：新曲到满音量
    await vi.waitFor(() => expect(hu.volume).toBeCloseTo(0.32, 5), { timeout: 2000 })

    const plays = hu.play.mock.calls.length
    audio.fadeToBgm('HuMusic.ogg', 0.2)
    await wait(50)
    expect(hu.play.mock.calls.length).toBe(plays)
  })

  it('新曲从 0 单调淡起，直到等于原声音量', async () => {
    const audio = useAudio()
    await audio.startBgm()
    audio.fadeToBgm('HuMusic.ogg', 0.6)
    await vi.waitFor(() => expect(MockAudio.instances.some(item => item.src.endsWith('/audio/HuMusic.ogg'))).toBe(true), { timeout: 2000 })
    const hu = MockAudio.instances.find(item => item.src.endsWith('/audio/HuMusic.ogg'))!
    const early = hu.volume
    expect(early).toBeGreaterThanOrEqual(0)
    expect(early).toBeLessThan(0.32)
    await wait(200)
    expect(hu.volume).toBeGreaterThan(early)
    await vi.waitFor(() => expect(hu.volume).toBeCloseTo(0.32, 5), { timeout: 2000 })
  })

  it('局末切回默认 BGM，默认轨重新淡入', async () => {
    const audio = useAudio()
    const bg = MockAudio.instances[0]
    await audio.startBgm()
    audio.fadeToBgm('HuMusic.ogg', 0.05)
    await vi.waitFor(() => expect(bg.pause).toHaveBeenCalled(), { timeout: 2000 })
    bg.pause.mockClear()

    audio.fadeToDefaultBgm(0.05)
    await vi.waitFor(() => expect(bg.play).toHaveBeenCalled(), { timeout: 2000 })
    await vi.waitFor(() => expect(bg.volume).toBeCloseTo(0.32, 5), { timeout: 2000 })
  })

  it('切换过程中静音/关闭 BGM 不残留斜坡，且重新开启按当前曲目续播', async () => {
    const audio = useAudio()
    await audio.startBgm()
    audio.fadeToBgm('HuMusic.ogg', 0.3)
    await vi.waitFor(() => expect(MockAudio.instances.some(item => item.src.endsWith('/audio/HuMusic.ogg'))).toBe(true), { timeout: 2000 })
    const hu = MockAudio.instances.find(item => item.src.endsWith('/audio/HuMusic.ogg'))!
    audio.bgmOn.value = false
    await vi.waitFor(() => expect(hu.pause).toHaveBeenCalled())
    // 关掉时把在飞的淡入结算到目标音量，避免重新开启后停在半音量
    expect(hu.volume).toBeCloseTo(0.32, 5)
    audio.bgmOn.value = true
    await vi.waitFor(() => expect(hu.play).toHaveBeenCalledTimes(2), { timeout: 2000 })
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

describe('useAudio BGM 顺序切换（Web Audio 路径）', () => {
  beforeEach(() => stubGlobals(true))
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('顺序切换：旧轨先淡到 0 并停止，之后才创建新 BufferSource 从 0 淡起', async () => {
    const audio = useAudio()
    await audio.startBgm()
    const ctx = MockAudioContext.created[0]
    expect(ctx.sources).toHaveLength(1)

    // 总时长 0.06s → 淡出 0.0216s（换轨定时器约 0.08s 后触发），淡入 0.0384s
    audio.fadeToBgm('HuMusic.ogg', 0.06)
    await wait(10)
    // 淡出阶段：只有旧轨，且它的增益曲线是 1 → 0
    expect(ctx.sources).toHaveLength(1)
    const oldGain = ctx.gains[1].gain
    expect(oldGain.curves).toHaveLength(1)
    expect(oldGain.curves[0].values[0]).toBeCloseTo(1, 5)
    expect(oldGain.curves[0].values.at(-1)).toBe(0)

    // 旧轨到 0 → 停旧轨 → 新轨才创建并从 0 淡起
    await wait(120)
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[0].stopped).toHaveBeenCalled()
    const newGain = ctx.gains[2].gain
    expect(newGain.curves).toHaveLength(1)
    expect(newGain.curves[0].values[0]).toBe(0)
    expect(newGain.curves[0].values.at(-1)).toBeCloseTo(1, 5)
    // 线性淡入：中点 0.5（等功率会是 0.707）
    const middle = Math.floor(newGain.curves[0].values.length / 2)
    expect(newGain.curves[0].values[middle]).toBeCloseTo(0.5, 2)
    expect(newGain.curves[0].duration).toBeCloseTo(0.06 * (1 - 0.36), 3)
    expect(ctx.sources[0].loop).toBe(true)
    expect(ctx.sources[1].loop).toBe(true)

    audio.fadeToDefaultBgm(0.06)
    await wait(200)
    expect(ctx.sources[1].stopped).toHaveBeenCalled()
    expect(ctx.sources).toHaveLength(3)
    expect(ctx.decodeAudioData).toHaveBeenCalledWith(expect.any(ArrayBuffer))
    expect(DEFAULT_BGM_FILE).toBe('bg.ogg')
  })
})
