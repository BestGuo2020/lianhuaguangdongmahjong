// 「莲花麻将」本地对局状态：复用核心状态形状，附加本局翻精/癞子/牌山断点字段。
import { ref } from 'vue'
import type { TileType } from '../../core/contracts/types'
import { createLocalGameState } from '../../core/local/localGameState'

/** 莲花麻将胡牌结算选项（winHand 为含胡牌张的完整 14 张手牌，供番数判定）。 */
export interface LotusEndGameOptions {
  winTile?: TileType
  winHand?: TileType[]
  selfDraw?: boolean
  kongBloom?: boolean
  robbedKong?: boolean
  robbedKongPlayerIndex?: number
  tianhu?: boolean
  dihu?: boolean
  sourceFrom?: number
}

export function createLotusGameState() {
  const base = createLocalGameState()
  return {
    ...base,
    /** 翻出的指示牌（精），桌面亮出 */
    flipTile: ref<TileType | null>(null),
    /** 本局癞子集合（指示牌 + 同序下一张） */
    /** 实际精牌（翻精牌与顺序下一张）；白板不在此集合内。 */
    jokerTiles: ref<TileType[]>([]),
    /** 可替代精牌的实体牌；它不是精牌。 */
    wildcardTiles: ref<TileType[]>(['white']),
    /** 3D 牌山断点（wall[0] 的物理张位） */
    wallBreakIndex: ref(0),
    /** 翻精所在物理墩（0..67），供 3D 在牌山上翻出指示牌；翻精前为 null */
    flipStack: ref<number | null>(null),
    /** 第二次掷骰点数（开牌依据），翻精后由目标方位玩家投出；掷出前为 null */
    secondDice: ref<[number, number] | null>(null),
    /** 本局是否尚未打出第一张牌（庄家首弃 = 地胡判定窗口） */
    roundFirstDiscard: ref(false),
  }
}

export type LotusGameState = ReturnType<typeof createLotusGameState>
