import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useRoomAvailability } from './useRoomAvailability'
import { getRoomMeta } from '../api/roomApi'
import type { GameMode } from '../../../core/contracts/activeGamePort'
import type { RuleVariant } from '../../../core/rules/ruleVariants'

vi.mock('../api/roomApi', () => ({ getRoomMeta: vi.fn() }))
vi.mock('../../../core/presentation/imagePreload', () => ({ materializeImages: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useRoomAvailability', () => {
  it('直接恢复到房间以及房间切换后都会重新取得可选模型', async () => {
    const setInterval = vi.fn(() => 1)
    const clearInterval = vi.fn()
    vi.stubGlobal('window', { setInterval, clearInterval })
    vi.mocked(getRoomMeta).mockResolvedValue({
      active: 1, max: 20, llmAvailable: true, llmProviders: [],
    })

    const gameMode = ref<GameMode>('remote')
    const roomId = ref('ROOM01')
    const { roomMeta } = useRoomAvailability(gameMode, roomId, ref('lotus-classic'))
    await nextTick()
    expect(getRoomMeta).toHaveBeenCalledTimes(1)
    expect(roomMeta.value?.llmAvailable).toBe(true)

    roomId.value = 'ROOM02'
    await nextTick()
    expect(getRoomMeta).toHaveBeenCalledTimes(2)

    gameMode.value = 'local'
    await nextTick()
    expect(clearInterval).toHaveBeenCalledWith(1)
  })

  it('按所选玩法立即刷新并轮询，切换时清掉旧容量，忽略晚到的旧响应', async () => {
    const setInterval = vi.fn((_callback: () => Promise<void>, _delay: number) => 1)
    vi.stubGlobal('window', { setInterval, clearInterval: vi.fn() })
    const classic = { active: 1, max: 4 }
    const legacy = { active: 3, max: 4 }
    vi.mocked(getRoomMeta).mockResolvedValueOnce(classic)
    const selectedRule = ref<RuleVariant>('lotus-classic')
    const { roomMeta, refresh } = useRoomAvailability(ref<GameMode>('remote'), ref(''), selectedRule)
    await nextTick()
    expect(roomMeta.value).toEqual(classic)

    let resolveOld!: (meta: typeof classic) => void
    vi.mocked(getRoomMeta).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const oldRequest = refresh()
    let resolveLegacy!: (meta: typeof legacy) => void
    vi.mocked(getRoomMeta).mockImplementationOnce(() => new Promise(resolve => { resolveLegacy = resolve }))
    selectedRule.value = 'lotus-legacy'
    await nextTick()
    expect(getRoomMeta).toHaveBeenLastCalledWith('lotus-legacy')
    expect(roomMeta.value).toBeNull()
    resolveLegacy(legacy)
    await nextTick()
    resolveOld(classic)
    await oldRequest
    expect(roomMeta.value).toEqual(legacy)

    vi.mocked(getRoomMeta).mockResolvedValueOnce({ active: 2, max: 4 })
    await setInterval.mock.calls[0]![0]!()
    expect(getRoomMeta).toHaveBeenLastCalledWith('lotus-legacy')
    expect(roomMeta.value?.active).toBe(2)
    expect(setInterval).toHaveBeenCalledTimes(1)

    vi.mocked(getRoomMeta).mockRejectedValueOnce(new Error('offline'))
    await refresh()
    expect(roomMeta.value?.active).toBe(2)
    vi.mocked(getRoomMeta).mockRejectedValueOnce(new Error('offline'))
    selectedRule.value = 'lotus-blood-flow'
    await nextTick()
    expect(getRoomMeta).toHaveBeenLastCalledWith('lotus-blood-flow')
    expect(roomMeta.value).toBeNull()
  })
})
