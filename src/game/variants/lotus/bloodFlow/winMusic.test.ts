import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BGM_FILE } from '../../../core/presentation/useAudio'
import { HU_MUSIC_FILE, HU_MUSIC_WIN_TILE_THRESHOLD, createBloodFlowWinMusic, totalBloodFlowWinTiles } from './winMusic'

const fadeTo = vi.fn()
const preload = vi.fn()
const winMusic = () => createBloodFlowWinMusic({ fadeTo, preload })

beforeEach(() => {
  fadeTo.mockClear()
  preload.mockClear()
})

describe('血流全场多胡 BGM', () => {
  it('四家胡牌张数合计到 8 才换 HuMusic，一局未结束前不回切', () => {
    const music = winMusic()
    const state = (winCounts: number[], playing = true) => ({
      totalWinTiles: () => winCounts.reduce((sum, n) => sum + n, 0),
      playing: () => playing,
    })
    expect(music.update(state([3, 2, 1, 1]))).toBe(false)   // 7 张：仍是默认 BGM
    expect(fadeTo).not.toHaveBeenCalled()
    expect(music.update(state([3, 2, 2, 1]))).toBe(true)    // 8 张：换曲
    expect(fadeTo).toHaveBeenCalledWith(HU_MUSIC_FILE, undefined)
    fadeTo.mockClear()
    expect(music.update(state([4, 3, 2, 2]))).toBe(true)    // 继续胡：不重复切换
    expect(fadeTo).not.toHaveBeenCalled()
    expect(music.update(state([5, 3, 2, 2]))).toBe(true)
    expect(fadeTo).not.toHaveBeenCalled()
  })

  it('每一局结束（结算/中断）切回默认 BGM，新一局从默认 BGM 开始', () => {
    const music = winMusic()
    const total = { totalWinTiles: () => 9, playing: () => true }
    music.update(total)
    expect(fadeTo).toHaveBeenCalledWith(HU_MUSIC_FILE, undefined)
    fadeTo.mockClear()
    // 本局结算：playing() 变 false → 回默认曲目
    expect(music.update({ ...total, playing: () => false })).toBe(false)
    expect(fadeTo).toHaveBeenCalledWith(DEFAULT_BGM_FILE, undefined)
    fadeTo.mockClear()
    // 下一局：计数从头开始 → 未到阈值就保持默认，不再切曲
    expect(music.update({ totalWinTiles: () => 0, playing: () => true })).toBe(false)
    expect(fadeTo).not.toHaveBeenCalled()
  })

  it('离开牌桌/重开一局的收尾会回到默认 BGM，且只回切一次', () => {
    const music = winMusic()
    music.update({ totalWinTiles: () => 12, playing: () => true })
    fadeTo.mockClear()
    music.release()
    expect(music.active()).toBe(false)
    expect(fadeTo).toHaveBeenCalledWith(DEFAULT_BGM_FILE, undefined)
    fadeTo.mockClear()
    music.release()
    expect(fadeTo).not.toHaveBeenCalled()
  })

  it('阈值与计张口径：按四家胡牌区张数求和，负数不参与', () => {
    expect(HU_MUSIC_WIN_TILE_THRESHOLD).toBe(8)
    expect(totalBloodFlowWinTiles([{ winCount: 3 }, { winCount: 3 }, { winCount: 2 }, { winCount: 0 }])).toBe(8)
    expect(totalBloodFlowWinTiles([{ winCount: 1 }, { winCount: 1 }, { winCount: 1 }, { winCount: 1 }])).toBe(4)
    expect(totalBloodFlowWinTiles([{ winCount: -2 }, { winCount: 10 }, { winCount: 0 }, { winCount: 0 }])).toBe(10)
  })

  it('本局开始即预热多胡曲目（只预热一次），局末收尾后下一局重新预热', () => {
    const music = winMusic()
    music.update({ totalWinTiles: () => 0, playing: () => true })
    music.update({ totalWinTiles: () => 2, playing: () => true })
    expect(preload).toHaveBeenCalledTimes(1)
    expect(preload).toHaveBeenCalledWith(HU_MUSIC_FILE)
    expect(fadeTo).not.toHaveBeenCalled()
    music.update({ totalWinTiles: () => 9, playing: () => true })
    music.release()
    preload.mockClear()
    music.update({ totalWinTiles: () => 0, playing: () => true })
    expect(preload).toHaveBeenCalledTimes(1)
  })
})
