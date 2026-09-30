import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useRoomAvailability } from './useRoomAvailability'
import { getRoomMeta } from '../api/roomApi'
import type { GameMode } from '../../core/contracts/activeGamePort'

vi.mock('../api/roomApi', () => ({ getRoomMeta: vi.fn() }))
vi.mock('../../core/presentation/imagePreload', () => ({ materializeImages: vi.fn() }))

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
    const { roomMeta } = useRoomAvailability(gameMode, roomId)
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
})
