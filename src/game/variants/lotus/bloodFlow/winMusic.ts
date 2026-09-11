import { DEFAULT_BGM_FILE } from '../../../core/presentation/useAudio'

/**
 * 血流「全场多胡」背景乐。
 *
 * 用户口径：**所有人的胡牌加起来 >= 8 张**（即四家胡牌区累计张数）时换成 `HuMusic.ogg`，
 * 每一局结束时切回默认 BGM；换曲必须交叉淡入淡出，不能生硬截断。
 *
 * 计张口径：`seats[seat].winCount` 就是该座胡牌区的张数（每次胡牌 +1），四家求和即全场胡牌张数。
 */
export const HU_MUSIC_FILE = 'HuMusic.ogg'
export const HU_MUSIC_WIN_TILE_THRESHOLD = 8

export interface WinMusicBgmPort {
  /** 交叉淡入淡出切换循环 BGM；file 为 `audio/` 下的文件名，秒数省略时用音频层默认时长。 */
  fadeTo(file: string, fadeSeconds?: number): void
  /** 预热目标曲目，避免第一次到阈值时才下载导致换曲延迟（可选）。 */
  preload?(file: string): void
}

export interface WinMusicState {
  /** 本局四家胡牌张数合计。 */
  totalWinTiles(): number
  /** 本局是否仍在进行（未结算、未中断）。 */
  playing(): boolean
}

export interface BloodFlowWinMusic {
  /** 按当前牌局状态刷新曲目；返回是否处于「多胡」曲。 */
  update(state: WinMusicState): boolean
  /** 离开牌桌/重开一局时收尾：回到默认 BGM。 */
  release(): void
  active(): boolean
}

export function createBloodFlowWinMusic(bgm?: WinMusicBgmPort, fadeSeconds?: number): BloodFlowWinMusic {
  let winMusic = false
  let warmed = false
  return {
    update(state) {
      // 本局第一次刷新时预热「多胡」曲目：到阈值时直接换曲，不再等下载/解码。
      if (!warmed && state.playing()) {
        warmed = true
        bgm?.preload?.(HU_MUSIC_FILE)
      }
      const wanted = state.playing() && state.totalWinTiles() >= HU_MUSIC_WIN_TILE_THRESHOLD
      if (wanted !== winMusic) {
        winMusic = wanted
        bgm?.fadeTo(wanted ? HU_MUSIC_FILE : DEFAULT_BGM_FILE, fadeSeconds)
      }
      return winMusic
    },
    release() {
      warmed = false
      if (!winMusic) return
      winMusic = false
      bgm?.fadeTo(DEFAULT_BGM_FILE, fadeSeconds)
    },
    active: () => winMusic,
  }
}

/** 四家胡牌区张数合计。 */
export function totalBloodFlowWinTiles(seats: readonly { winCount: number }[]): number {
  return seats.reduce((total, seat) => total + Math.max(0, seat.winCount), 0)
}
